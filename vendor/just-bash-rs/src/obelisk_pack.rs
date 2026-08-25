//! PORT: packs/obelisk-control/workflow-pack.js
//!
//! The obelisk-control pack: one custom command, `obelisk`, whose subcommands
//! (`functions`, `executions`, `call`, `deployment`) all bottom out in a
//! single primitive - calling a deployed Obelisk FFQN and getting back its
//! JSON result - via the `ObeliskHost` seam below. Everything under
//! `packs/obelisk-control/tools/*.js` and `packs/obelisk-control/github/*.js`
//! stays a separately-deployed JS activity/workflow reached *through* one of
//! these FFQN calls (e.g. `obelisk-agent:tools/webapi.list-functions`); this
//! module only ports the shell-command dispatcher that runs inside the
//! session's own bash, not those targets, so it never needs to know how they
//! are implemented.

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::{Value, json};
use toml_edit::{DocumentMut, InlineTable, Item, Table, TableLike};

use crate::commands::{normalize_path, sha256_hex};
use crate::custom_command::CustomCommandHandler;
use crate::fs::{BlobLoader, FsError, Vfs};
use crate::interpreter::{CommandOutput, Interpreter};

const READ_BLOB_FFQN: &str = "obelisk-agent:tools/webapi.deployment-read-blob";
const SUBMIT_FFQN: &str = "obelisk-agent:tools/webapi.deployment-submit";

const DEPLOYMENT_ROOT: &str = "/workspace/deployment";

/// The placeholder value the agent sees in `component_files` maps in place of a
/// pinned digest; `deployment submit` replaces each with the file's real digest.
const AUTO_DIGEST: &str = "auto";

/// The fully-commented default `deployment.toml`, captured at build time from the
/// devshell's `obelisk generate deployment` (see build.rs), so it always matches
/// the Obelisk version this component is built against.
const DEPLOYMENT_TEMPLATE: &str =
    include_str!(concat!(env!("OUT_DIR"), "/deployment-template.toml"));

/// PORT: `packs/obelisk-control/workflow-pack.js`'s `descriptor.systemPrompt`.
/// Appended to the session system prompt by the workflow (`session.rs`).
pub const SYSTEM_PROMPT: &str =
    "You are on a persistent virtual machine with a filesystem rooted at
/workspace. The target Obelisk's active deployment is available at
/workspace/deployment/current; read and edit its deployment.toml and component
sources with ordinary shell commands. Use the obelisk command for operations
against the target server, which may be a different instance than the one you run
on (functions, executions, call, and deployment
current/refresh/check/submit/switch/apply). Edits under the deployment folder
are local until you deploy them: `obelisk deployment submit` stores them as a
new inactive deployment and prints its ID, then `obelisk deployment apply ID`
hot-redeploys that stored deployment now (the ID argument is required);
`obelisk deployment refresh` discards local edits and re-fetches the current
deployment. Never set
or maintain a digest in deployment.toml: submit recomputes each from the file
bytes for you. `content_digest` lines are omitted, `component_files` entries use
the value \"auto\", and `backtrace.sources` entries are plain path strings; leave
them that way. Add a component by writing its source and its
[[activity_js]]/[[workflow_js]] table (name, location, params, return_type), and
add a bundled file by writing it and listing its path in `component_files` with
the value \"auto\", nothing more. Run `obelisk generate deployment` for a
fully-commented starter deployment.toml when authoring one from scratch. Two
read-only reference trees are mounted for you: /workspace/docs (the Obelisk
documentation, obeli-sk/website) and /workspace/components (reusable example
components, obeli-sk/components); browse them with ls and cat while authoring.
Run `mount` to see the network-backed mount points; it reports whether each MCP
server is responding. These mounts
(/workspace/deployment, /workspace/docs, /workspace/components, /workspace/mcp)
are lazy: a directory lists and a file's bytes fetch over the network on first
access, so the first touch of a path may pause briefly. The deployment mount is
cheap (one request for its whole file index), but the reference trees fetch one
network request per directory listed, so avoid recursive scans over them: do not
run tree, find, or a recursive grep (grep -r / fgrep -r) across a mount. Navigate
with targeted ls and cat, or read a known path directly, instead of walking the
whole tree.

The shell's HTTP access goes through an operator allowlist: commands such as
curl work only for explicitly granted hosts (GET only), and a policy-denied
request is the expected result for anything else. The target's webhook base URL
printed by `mount` is granted for GET, so deployed webhook endpoints can be
smoke-tested directly there; anything not granted is verified through the
control plane (`obelisk executions list` / `logs`) instead of by probing its
port.";

/// The one primitive the whole pack needs: dynamically invoke a deployed FFQN
/// and get back its JSON result. Mirrors Obelisk's real
/// `workflow-support.call-json: func(function, params, ...) -> result<
/// result<option<string>, option<string>>, schedule-json-error>` host import,
/// flattened to `Ok(Some(json_text))` (success with a body) / `Ok(None)`
/// (success, no body) / `Err(message)` (host or execution failure).
///
/// This is the seam phase 5's real `workflow/workflow-rs` component
/// implements against the actual wit-bindgen binding once it exists; this
/// crate defines only the trait and a test fake (`tests::FakeHost` below),
/// never a real host import. `call_json`'s `Ok(Some(text))` is always raw
/// JSON text (quoted for a string-typed result), never a pre-decoded native
/// value - callers that need the underlying string or object use
/// `decode_string`/`decode_json` below, same as upstream's own
/// `decodeString`/`decodeJson` helpers.
pub trait ObeliskHost {
    fn call_json(&mut self, ffqn: &str, params_json: &str) -> Result<Option<String>, String>;
}

/// Result of mounting (or refreshing) the active deployment into the VFS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MountResult {
    pub deployment_id: Option<String>,
    pub files: u32,
}

/// Build the `obelisk` custom-command handler. Register it with
/// `bash.register_command("obelisk", obelisk_pack::command_handler(host))`.
/// The handler owns `host` for the life of the session (an `FnMut` closure,
/// not `Rc<RefCell<_>>`, since only the command itself ever touches it).
pub fn command_handler(host: Box<dyn ObeliskHost>) -> CustomCommandHandler {
    let mut host = host;
    Box::new(move |interp, args, stdin| execute_obelisk(interp, args, &stdin, host.as_mut()))
}

/// Check out the active deployment's `deployment.toml` plus the metadata index
/// of its owned source files into `/workspace/deployment/<id>/`, then symlink
/// `/workspace/deployment/current` to it. Only the manifest is fetched here;
/// each owned source (component scripts/wasm and `backtrace.sources`) is
/// registered as a lazy VFS entry. Bounded files are pulled from the CAS on
/// first read, while oversized entries stay digest-only (see
/// `Vfs::register_lazy` and `blob_loader`), so mounting costs two host calls
/// regardless of how many files the deployment owns.
///
/// Called once at session mount (`replace = false`, via `mount`) and again by
/// `obelisk deployment refresh` (`replace = true`, re-registering every file so
/// a locally-read/edited copy is dropped for the current digest; the initial
/// mount instead leaves an already-present file alone).
pub fn refresh_deployment_mount(
    fs: &mut Vfs,
    host: &mut dyn ObeliskHost,
    replace: bool,
) -> Result<MountResult, String> {
    let current = call_value(
        host,
        "obelisk-agent:tools/webapi.current-deployment-id",
        "[]",
    )?;
    let deployment_id = decode_string(&current);
    if deployment_id.is_empty() {
        return Ok(MountResult {
            deployment_id: None,
            files: 0,
        });
    }

    let checkout = call_value(
        host,
        "obelisk-agent:tools/webapi.deployment-checkout",
        &json!([deployment_id]).to_string(),
    )?;
    let checkout = decode_json(&checkout)?;
    let manifest = checkout
        .get("deployment_toml")
        .and_then(Value::as_str)
        .ok_or_else(|| "deployment checkout returned no deployment_toml".to_string())?
        .to_string();
    let indexed_files = checkout_file_refs(&checkout)?;

    let dir = format!("{DEPLOYMENT_ROOT}/{deployment_id}");
    fs.mkdir(&dir, true).map_err(fs_error_message)?;
    // The agent edits and re-submits this manifest by hand, so hide every pinned
    // digest it never needs to maintain (standalone `content_digest`,
    // `component_files` values, `backtrace.sources` tables): `deployment submit`
    // recomputes each from the file's current bytes.
    let manifest_path = format!("{dir}/deployment.toml");
    if replace || !fs.exists(&manifest_path) {
        fs.write_file(&manifest_path, simplify_manifest(&manifest).as_bytes())
            .map_err(fs_error_message)?;
    }

    let mut files = 1u32;
    for reference in indexed_files {
        let path = format!("{dir}/{}", reference.path);
        if !replace && fs.exists(&path) {
            continue;
        }
        fs.register_lazy(&path, &reference.digest, reference.size);
        files += 1;
    }

    let current = format!("{DEPLOYMENT_ROOT}/current");
    if fs.exists(&current) {
        fs.remove(&current, true).map_err(fs_error_message)?;
    }
    fs.symlink(&dir, &current).map_err(fs_error_message)?;
    Ok(MountResult {
        deployment_id: Some(deployment_id),
        files,
    })
}

/// Convenience entry point for session mount: `refresh_deployment_mount` with
/// `replace = false`.
pub fn mount(fs: &mut Vfs, host: &mut dyn ObeliskHost) -> Result<MountResult, String> {
    refresh_deployment_mount(fs, host, false)
}

/// Register the deployment tree as a deferred mount instead of fetching it at
/// session start: the checkout (`current-deployment-id` + `deployment-checkout`)
/// runs only when the session first references a path under
/// `/workspace/deployment`, so a bash-only session never touches the target.
/// A failed mount records the reason in `/workspace/.mount-error`, matching the
/// old eager path (there is no `console.log` to report it to; see `session.rs`).
pub fn register_deferred_mount(fs: &mut Vfs, host: Box<dyn ObeliskHost>) {
    let host = RefCell::new(host);
    let populate = Rc::new(move |fs: &mut Vfs| {
        let mut host = host.borrow_mut();
        if let Err(err) = refresh_deployment_mount(fs, &mut **host, false) {
            let _ = fs.write_file("/workspace/.mount-error", err.as_bytes());
        }
    });
    fs.register_deferred_mount(DEPLOYMENT_ROOT, populate);
}

/// The `Vfs` blob loader for a mounted session: fetch a deployment file's bytes
/// by content digest via `deployment-read-blob`, decoding the same way the old
/// eager mount did (`call_value` peels `call_json`'s JSON layer, `coerce_text`
/// takes the verbatim string body). Install with `fs.set_blob_loader(...)`; it
/// owns a host of its own (the shell's `obelisk` command owns a separate one)
/// with interior mutability, since `BlobLoader::load` is a `&self` call reached
/// from a plain file read.
struct HostBlobLoader {
    host: RefCell<Box<dyn ObeliskHost>>,
}

impl BlobLoader for HostBlobLoader {
    fn load(&self, digest: &str) -> Result<Vec<u8>, String> {
        let value = call_value(
            &mut **self.host.borrow_mut(),
            READ_BLOB_FFQN,
            &json!([digest]).to_string(),
        )?;
        Ok(coerce_text(&value).into_bytes())
    }
}

/// Build the session's lazy blob loader from an owned host (see
/// `HostBlobLoader`).
pub fn blob_loader(host: Box<dyn ObeliskHost>) -> Rc<dyn BlobLoader> {
    Rc::new(HostBlobLoader {
        host: RefCell::new(host),
    })
}

struct IndexedFileRef {
    path: String,
    digest: String,
    size: u64,
}

fn checkout_file_refs(checkout: &Value) -> Result<Vec<IndexedFileRef>, String> {
    let files = checkout
        .get("files")
        .and_then(Value::as_array)
        .ok_or_else(|| "deployment checkout returned no files index".to_string())?;
    files
        .iter()
        .map(|file| {
            let path = file
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "deployment checkout file has no path".to_string())?;
            let digest = file
                .get("digest")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("deployment checkout file {path} has no digest"))?;
            let size = file
                .get("size")
                .and_then(Value::as_u64)
                .ok_or_else(|| format!("deployment checkout file {path} has no size"))?;
            Ok(IndexedFileRef {
                path: path.to_string(),
                digest: digest.to_string(),
                size,
            })
        })
        .collect()
}

fn execute_obelisk(
    interp: &mut Interpreter,
    args: &[String],
    stdin: &str,
    host: &mut dyn ObeliskHost,
) -> CommandOutput {
    match try_execute_obelisk(interp, args, stdin, host) {
        Ok(result) => result,
        Err(message) => fail(format!("obelisk: {message}\n")),
    }
}

fn try_execute_obelisk(
    interp: &mut Interpreter,
    args: &[String],
    stdin: &str,
    host: &mut dyn ObeliskHost,
) -> Result<CommandOutput, String> {
    let group = args.first().map(String::as_str).unwrap_or("");
    let action = args.get(1).map(String::as_str).unwrap_or("");
    let rest: &[String] = if args.len() > 2 { &args[2..] } else { &[] };

    if group.is_empty() || is_help_flag(group) {
        return Ok(ok(help()));
    }
    // `-h`/`--help` at any level prints the matching usage and exits 0: as the
    // action (`obelisk deployment -h`) it is the group help, further right
    // (`obelisk deployment submit -h`) the subcommand help. For `call`, only a
    // help flag before `--` is help; after it, it is a positional parameter.
    if is_help_flag(action) {
        return Ok(ok(group_help(group)));
    }
    let help_scan = if group == "call" {
        &rest[..rest.iter().position(|a| a == "--").unwrap_or(rest.len())]
    } else {
        rest
    };
    if help_requested(help_scan) {
        return Ok(ok(action_help(group, action)));
    }

    if group == "functions" && action == "list" {
        let params = json!([
            option(rest, "--prefix", ""),
            integer_option(rest, "--length", 100)
        ]);
        if flag(rest, "--json") {
            return json_call(host, "obelisk-agent:tools/webapi.list-functions", params);
        }
        return list_functions(host, params);
    }
    if group == "functions" && action == "wit" {
        return json_call(
            host,
            "obelisk-agent:tools/webapi.get-function-wit",
            json!([required(rest.first().map(String::as_str), "ffqn")?]),
        );
    }
    if group == "executions" && action == "list" {
        return json_call(
            host,
            "obelisk-agent:tools/webapi.list-executions",
            json!([
                option(rest, "--ffqn-prefix", ""),
                option(rest, "--id-prefix", ""),
                flag(rest, "--show-derived"),
                flag(rest, "--hide-finished"),
                "",
                "",
                "",
                "",
                false,
                integer_option(rest, "--length", 20),
            ]),
        );
    }
    if group == "executions" && action == "get" {
        return json_call(
            host,
            "obelisk-agent:tools/webapi.get-execution",
            json!([required(rest.first().map(String::as_str), "execution id")?]),
        );
    }
    if group == "executions" && action == "logs" {
        return json_call(
            host,
            "obelisk-agent:tools/webapi.get-logs",
            json!([
                required(rest.first().map(String::as_str), "execution id")?,
                true,
                true,
                true,
                Vec::<String>::new(),
                Vec::<String>::new(),
                "",
                "",
                false,
                integer_option(rest, "--length", 200),
            ]),
        );
    }
    if group == "executions" && action == "result" {
        return json_call(
            host,
            "obelisk-agent:tools/webapi.get-result-json",
            json!([required(rest.first().map(String::as_str), "execution id")?]),
        );
    }
    if group == "call" {
        let ffqn = required(Some(action), "ffqn")?;
        if rest.first().map(String::as_str) == Some("--") {
            let params = rest[1..]
                .iter()
                .map(|argument| {
                    serde_json::from_str(argument)
                        .unwrap_or_else(|_| Value::String(argument.clone()))
                })
                .collect::<Vec<_>>();
            return target_call(host, json!([ffqn, Value::Array(params).to_string()]));
        }
        if rest.len() > 1 {
            return Err(
                "call: expected one params JSON array, or `--` followed by positional parameters"
                    .to_string(),
            );
        }
        // A params-json positional that is present but empty is almost always a
        // shell expansion that produced nothing (e.g. `"$(cat missing.json)"`).
        // Silently defaulting it to `[]` dispatches zero arguments and surfaces
        // as a confusing server-side cardinality mismatch, so reject it here.
        // Only a genuinely absent argument (with empty stdin) defaults to `[]`,
        // which is correct for a target that takes no parameters.
        if matches!(rest.first(), Some(p) if p.is_empty()) {
            return Err("call: params-json argument is empty (a shell expansion likely produced nothing); pass a JSON array such as [] explicitly".to_string());
        }
        let params_json = rest
            .first()
            .map(String::as_str)
            .filter(|s| !s.is_empty())
            .or_else(|| Some(stdin).filter(|s| !s.is_empty()))
            .unwrap_or("[]");
        return target_call(host, json!([ffqn, params_json]));
    }
    if group == "generate" {
        return execute_generate(action);
    }
    if group == "deployment" {
        return execute_deployment(interp, action, rest, host);
    }
    Ok(fail(format!(
        "obelisk: unknown command '{}'\n{}",
        args.join(" "),
        help()
    )))
}

/// Print a starter config file. Purely local: unlike the other groups it never
/// touches the target server, it just echoes a template baked in at build time.
fn execute_generate(action: &str) -> Result<CommandOutput, String> {
    match action {
        "deployment" => Ok(ok(ensure_trailing_newline(DEPLOYMENT_TEMPLATE.to_string()))),
        "" => Ok(fail(format!(
            "obelisk generate: a subcommand is required\n{}",
            generate_help()
        ))),
        _ => Ok(fail(format!(
            "obelisk generate: unknown action '{action}'\n"
        ))),
    }
}

fn execute_deployment(
    interp: &mut Interpreter,
    action: &str,
    args: &[String],
    host: &mut dyn ObeliskHost,
) -> Result<CommandOutput, String> {
    match action {
        "current" => json_call(
            host,
            "obelisk-agent:tools/webapi.current-deployment-id",
            json!([]),
        ),
        "refresh" => {
            // An explicit refresh populates the tree now, so drop the deferred
            // mount to keep a later deployment access from re-fetching it.
            interp.fs.clear_deferred_mount(DEPLOYMENT_ROOT);
            let refreshed = refresh_deployment_mount(&mut interp.fs, host, true)?;
            Ok(ok(format!("{}\n", mount_result_json(&refreshed))))
        }
        "check" => {
            let dir = resolve_deployment_dir(interp, first_positional(args, &[]));
            let manifest = read_manifest(&interp.fs, &dir)?;
            let sources = deployment_sources(&interp.fs, &dir, &manifest);
            let payload = json!({
                "directory": dir,
                "manifest_bytes": manifest.len(),
                "owned_sources": sources,
            });
            Ok(ok(format!(
                "{}\n",
                serde_json::to_string_pretty(&payload).expect("json")
            )))
        }
        "submit" => {
            // The PATH is positional, so skip flags (and `--description`'s value)
            // when finding it; otherwise `submit --description X` reads `X`, or
            // even `--description` itself, as the deployment directory.
            let dir = resolve_deployment_dir(interp, first_positional(args, &["--description"]));
            let manifest = read_manifest(&interp.fs, &dir)?;
            // Expand the digest-free view back to what the server stores: every
            // `content_digest`, `component_files` value, and `backtrace.sources`
            // table, each digest recomputed from the file's current bytes (an
            // unchanged file keeps its CAS digest, a changed one is re-hashed).
            let manifest = manifest_with_digests(&interp.fs, &dir, &manifest);
            let deployment_id = if basename(&dir) == "current" {
                String::new()
            } else {
                basename(&dir)
            };
            let description =
                option(args, "--description", "Submitted from workflow-agent VFS").to_string();
            let allow_missing = flag_runtime_config(args);
            submit_deployment(
                &interp.fs,
                host,
                &dir,
                &manifest,
                &description,
                allow_missing,
                &deployment_id,
            )
        }
        "switch" => json_call(
            host,
            "obelisk-agent:tools/webapi.deployment-switch",
            json!([
                required(args.first().map(String::as_str), "deployment id")?,
                flag_runtime_config(args),
            ]),
        ),
        "apply" => json_call(
            host,
            "obelisk-agent:tools/webapi.apply-deployment",
            json!([required(args.first().map(String::as_str), "deployment id")?]),
        ),
        _ => Ok(fail(format!(
            "obelisk deployment: unknown action '{action}'\n"
        ))),
    }
}

/// The workflow half of the submit contract: drive the dumb `deployment-submit`
/// activity's preflight/attach loop. The first call carries no blobs (a JSON
/// preflight); each 409 names the blobs the CAS lacks, which we read straight
/// from the VFS and resubmit as a multipart package, until the server accepts it.
/// A run that keeps reporting the same files after they were attached is a
/// digest mismatch we cannot fix by resending, so it errors instead of looping.
fn submit_deployment(
    fs: &Vfs,
    host: &mut dyn ObeliskHost,
    dir: &str,
    manifest: &str,
    description: &str,
    allow_missing: bool,
    deployment_id: &str,
) -> Result<CommandOutput, String> {
    let mut attachments: Vec<Value> = Vec::new();
    let mut previous: Option<Vec<String>> = None;
    loop {
        let params = json!([
            manifest,
            attachments,
            description,
            allow_missing,
            deployment_id
        ]);
        let missing = match call_value(host, SUBMIT_FFQN, &params.to_string()) {
            // Ok side is the new deployment id.
            Ok(value) => {
                return Ok(ok(format!(
                    "{}\n",
                    pretty_json(&json!({ "deployment_id": decode_string(&value) }))
                )));
            }
            // The `permanent-missing-files` error arm is recoverable; any other
            // error is terminal (permanent/transient tool-error) and propagates.
            Err(message) => match parse_missing_files(&message) {
                Some(missing) => missing,
                None => return Err(message),
            },
        };
        let paths: Vec<String> = missing
            .iter()
            .filter_map(|m| m.get("path").and_then(Value::as_str).map(String::from))
            .collect();
        if previous.as_ref() == Some(&paths) {
            return Err(format!(
                "server still missing {} file(s) after they were attached (digest mismatch?): {}",
                paths.len(),
                paths.join(", ")
            ));
        }
        let mut next = Vec::with_capacity(missing.len());
        for issue in &missing {
            let path = issue
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| "server reported a missing file with no path".to_string())?;
            let digest = issue.get("digest").and_then(Value::as_str).unwrap_or("");
            let bytes = fs.read_file(&format!("{dir}/{path}")).ok_or_else(|| {
                format!("server needs {path} but it is not in the deployment tree; write the file before submitting")
            })?;
            next.push(json!({
                "path": path,
                "digest": digest,
                "content": String::from_utf8_lossy(&bytes),
            }));
        }
        attachments = next;
        previous = Some(paths);
    }
}

/// Recover the `permanent-missing-files` error arm from the stringified submit
/// error. The host seam collapses an activity's `Err` to text: this arm arrives
/// as verbatim JSON (`{"permanent_missing_files":[{path,digest},...]}`), while a
/// terminal permanent/transient error arrives as its plain message. Returns the
/// entries only for the former (accepting either key spelling), else `None`.
fn parse_missing_files(message: &str) -> Option<Vec<Value>> {
    let value: Value = serde_json::from_str(message).ok()?;
    let entries = value
        .get("permanent_missing_files")
        .or_else(|| value.get("permanent-missing-files"))?
        .as_array()?;
    Some(entries.clone())
}

/// Every deployment-owned source location a submit tracks: each component's
/// `location`, `component_files` keys, and `backtrace.sources` paths. `oci://` refs skipped, deduped first-wins.
fn owned_source_locations(toml: &str) -> Vec<String> {
    let Ok(doc) = toml.parse::<DocumentMut>() else {
        return Vec::new();
    };
    let mut seen = std::collections::BTreeSet::new();
    let mut locations = Vec::new();
    for table in component_tables(&doc) {
        let mut candidates: Vec<&str> = Vec::new();
        if let Some(location) = table.get("location").and_then(Item::as_str) {
            candidates.push(location);
        }
        if let Some(files) = table.get("component_files").and_then(Item::as_table_like) {
            candidates.extend(files.iter().map(|(key, _)| key));
        }
        if let Some(sources) = backtrace_sources(table) {
            for (_, entry) in sources.iter() {
                if let Some(path) = entry
                    .as_table_like()
                    .and_then(|inner| inner.get("path"))
                    .and_then(Item::as_str)
                {
                    candidates.push(path);
                }
            }
        }
        for location in candidates {
            if !location.starts_with("oci://") && seen.insert(location.to_string()) {
                locations.push(location.to_string());
            }
        }
    }
    locations
}

/// The top-level component tables: every top-level array-of-tables.
fn component_tables(doc: &DocumentMut) -> impl Iterator<Item = &Table> {
    doc.as_table()
        .iter()
        .filter_map(|(_, item)| item.as_array_of_tables())
        .flat_map(|array| array.iter())
}

fn component_tables_mut(doc: &mut DocumentMut) -> impl Iterator<Item = &mut Table> {
    doc.as_table_mut()
        .iter_mut()
        .filter_map(|(_, item)| item.as_array_of_tables_mut())
        .flat_map(|array| array.iter_mut())
}

/// A component's `backtrace.sources`, whether a nested table or inline; `TableLike` unifies both.
fn backtrace_sources(table: &Table) -> Option<&dyn TableLike> {
    let backtrace = table.get("backtrace")?.as_table_like()?;
    backtrace.get("sources")?.as_table_like()
}

fn backtrace_sources_mut(table: &mut Table) -> Option<&mut dyn TableLike> {
    let backtrace = table.get_mut("backtrace")?.as_table_like_mut()?;
    backtrace.get_mut("sources")?.as_table_like_mut()
}

/// Collapse a stored manifest into the digest-free view the agent edits: drop
/// `content_digest`, blank `component_files` values to `AUTO_DIGEST`, reduce each `backtrace.sources` table to its path. Inverse of `manifest_with_digests`.
// TODO: Obelisk 0.41.2 is the last version which can return content_digest of backtraces, remove handling afterwards.
fn simplify_manifest(manifest: &str) -> String {
    let Ok(mut doc) = manifest.parse::<DocumentMut>() else {
        return manifest.to_string();
    };
    for table in component_tables_mut(&mut doc) {
        table.remove("content_digest");
        if let Some(files) = table
            .get_mut("component_files")
            .and_then(Item::as_table_like_mut)
        {
            for key in table_like_keys(files) {
                if !key.starts_with("oci://") {
                    files.insert(&key, toml_edit::value(AUTO_DIGEST));
                }
            }
        }
        if let Some(sources) = backtrace_sources_mut(table) {
            for key in table_like_keys(sources) {
                let path = sources
                    .get(&key)
                    .and_then(Item::as_table_like)
                    .and_then(|inner| inner.get("path"))
                    .and_then(Item::as_str)
                    .map(str::to_string);
                if let Some(path) = path
                    && !path.starts_with("oci://")
                {
                    sources.insert(&key, toml_edit::value(path));
                }
            }
        }
    }
    doc.to_string()
}

/// Inverse of `simplify_manifest`: re-pin each `content_digest`, `component_files`
/// value, and `backtrace.sources` table from the file's current bytes (a missing file is left as-is).
fn manifest_with_digests(fs: &Vfs, dir: &str, manifest: &str) -> String {
    let Ok(mut doc) = manifest.parse::<DocumentMut>() else {
        return manifest.to_string();
    };
    for table in component_tables_mut(&mut doc) {
        let location = table
            .get("location")
            .and_then(Item::as_str)
            .map(str::to_string);
        if let Some(location) = location
            && !location.starts_with("oci://")
            && let Some(digest) = owned_source_digest(fs, &format!("{dir}/{location}"))
        {
            table.insert("content_digest", toml_edit::value(digest));
        }
        if let Some(files) = table
            .get_mut("component_files")
            .and_then(Item::as_table_like_mut)
        {
            for key in table_like_keys(files) {
                if key.starts_with("oci://") {
                    continue;
                }
                if let Some(digest) = owned_source_digest(fs, &format!("{dir}/{key}")) {
                    files.insert(&key, toml_edit::value(digest));
                }
            }
        }
        if let Some(sources) = backtrace_sources_mut(table) {
            for key in table_like_keys(sources) {
                let Some(path) = sources.get(&key).and_then(Item::as_str).map(str::to_string)
                else {
                    continue;
                };
                if path.starts_with("oci://") {
                    continue;
                }
                let Some(digest) = owned_source_digest(fs, &format!("{dir}/{path}")) else {
                    continue;
                };
                let mut inline = InlineTable::new();
                inline.insert("path", toml_edit::Value::from(path));
                inline.insert("content_digest", toml_edit::Value::from(digest));
                sources.insert(&key, Item::Value(toml_edit::Value::InlineTable(inline)));
            }
        }
    }
    doc.to_string()
}

/// A `TableLike`'s keys, materialized so a caller can mutate entries by key while iterating.
fn table_like_keys(table: &dyn TableLike) -> Vec<String> {
    table.iter().map(|(key, _)| key.to_string()).collect()
}

/// The `content_digest` for a deployment-owned source at submit time: an
/// unchanged file is still a lazy `pending` VFS entry and keeps its CAS digest;
/// a changed or newly created file is re-hashed from the same lossy-decoded
/// bytes `deployment_sources` transmits, so the server's re-hash matches.
fn owned_source_digest(fs: &Vfs, path: &str) -> Option<String> {
    if let Some(lazy) = fs.lazy_file_ref(path) {
        return Some(lazy.digest);
    }
    let bytes = fs.read_file(path)?;
    let content = String::from_utf8_lossy(&bytes);
    Some(format!("sha256:{}", sha256_hex(content.as_bytes())))
}

/// The deployment-owned source paths a submit would carry: only those the
/// session modified locally (`deployment check` reports them). An unmodified file
/// stays a lazy `pending` VFS entry whose blob is already in the CAS, so
/// `manifest_with_digests` re-pins its existing digest and `submit_deployment`
/// never uploads it (the "upload only what the server is missing" contract).
/// Skipping unmodified files keeps a redeploy from touching every component,
/// notably the multi-MB workflow and activity WASM.
fn deployment_sources(fs: &Vfs, dir: &str, manifest: &str) -> Vec<String> {
    let mut files = Vec::new();
    for location in owned_source_locations(manifest) {
        let path = format!("{dir}/{location}");
        // A local write clears the pending flag; a mere read does not. So a file
        // still pending is unmodified and already in the CAS - skip it.
        if fs.is_pending(&path) {
            continue;
        }
        if fs.exists(&path) {
            files.push(location);
        }
    }
    files
}

/// Resolve the directory holding `deployment.toml` from a positional argument.
/// Accepts a path to the `deployment.toml` file itself (obelisk's `submit PATH`;
/// its parent is the directory), a directory, or nothing (defaults to the cwd).
fn resolve_deployment_dir(interp: &Interpreter, value: Option<&str>) -> String {
    let value = value.filter(|s| !s.is_empty()).unwrap_or(".");
    let resolved = normalize_path(&interp.cwd, value);
    if basename(&resolved) == "deployment.toml" {
        parent_dir(&resolved)
    } else {
        resolved
    }
}

fn parent_dir(path: &str) -> String {
    match path.rsplit_once('/') {
        Some(("", _)) | None => "/".to_string(),
        Some((parent, _)) => parent.to_string(),
    }
}

/// The first positional argument, skipping flags. A flag named in `value_flags`
/// also consumes the following token as its value; `--` ends flag parsing so the
/// next token is positional. Keeps `submit --description X` from reading a flag
/// (or its value) as the PATH.
fn first_positional<'a>(args: &'a [String], value_flags: &[&str]) -> Option<&'a str> {
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        if arg == "--" {
            return args.get(i + 1).map(String::as_str);
        }
        if arg.starts_with('-') && arg.len() > 1 {
            i += if value_flags.contains(&arg) { 2 } else { 1 };
            continue;
        }
        return Some(arg);
    }
    None
}

/// The runtime-config override, accepting both the pack's original flag name and
/// obelisk's `--allow-unavailable-runtime-config` spelling.
fn flag_runtime_config(args: &[String]) -> bool {
    flag(args, "--allow-missing-runtime-config") || flag(args, "--allow-unavailable-runtime-config")
}

fn read_manifest(fs: &Vfs, dir: &str) -> Result<String, String> {
    let path = format!("{dir}/deployment.toml");
    fs.read_file(&path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .ok_or_else(|| format!("{path}: No such file or directory"))
}

fn json_call(
    host: &mut dyn ObeliskHost,
    ffqn: &str,
    params: Value,
) -> Result<CommandOutput, String> {
    let value = call_value(host, ffqn, &params.to_string())?;
    Ok(ok(ensure_trailing_newline(render_output(value))))
}

fn target_call(host: &mut dyn ObeliskHost, params: Value) -> Result<CommandOutput, String> {
    let value = call_value(
        host,
        "obelisk-control:tools/native.call",
        &params.to_string(),
    )?;
    Ok(ok(ensure_trailing_newline(render_output(decode_json(
        &value,
    )?))))
}

fn list_functions(host: &mut dyn ObeliskHost, params: Value) -> Result<CommandOutput, String> {
    let value = call_value(
        host,
        "obelisk-agent:tools/webapi.list-functions",
        &params.to_string(),
    )?;
    let functions = decode_json(&value)?;
    let functions = functions
        .as_array()
        .ok_or_else(|| "functions list returned a non-array response".to_string())?;
    let mut lines = Vec::new();
    for function in functions {
        if !function.get("extension").is_none_or(Value::is_null) {
            continue;
        }
        let ffqn = function
            .get("ffqn")
            .and_then(Value::as_str)
            .ok_or_else(|| "function metadata has no ffqn".to_string())?;
        let parameter_types = function
            .get("parameter_types")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("function metadata for {ffqn} has no parameter_types"))?;
        let parameters = parameter_types
            .iter()
            .map(|parameter| {
                let name = parameter
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| format!("function parameter for {ffqn} has no name"))?;
                let wit_type = parameter
                    .get("wit_type")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        format!("function parameter {name} for {ffqn} has no wit_type")
                    })?;
                Ok(format!("{name}: {wit_type}"))
            })
            .collect::<Result<Vec<_>, String>>()?
            .join(", ");
        let return_type = function
            .get("return_type")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("function metadata for {ffqn} has no return_type"))?;
        lines.push(format!("{ffqn} : func({parameters}) -> {return_type}"));
    }
    Ok(ok(if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    }))
}

/// Render an FFQN result for the shell. The endpoints return JSON *text*, so a
/// structural result (array/object) is pretty-printed - one element/field per
/// line - to stay readable and greppable rather than a single dense line. A
/// string body that is not itself structural JSON (WIT text, execution logs, a
/// bare deployment id) prints verbatim, as does a scalar. `Ok(None)` (no body)
/// stayed `null`.
fn render_output(value: Value) -> String {
    match value {
        Value::String(s) => match serde_json::from_str::<Value>(&s) {
            Ok(inner) if inner.is_array() || inner.is_object() => pretty_json(&inner),
            _ => s,
        },
        other => pretty_json(&other),
    }
}

fn pretty_json(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// PORT: the JS `obelisk.call` builtin. `RealHost::call_json` returns raw JSON
/// text (one layer higher than JS's already-deserialized `obelisk.call`), so
/// every pack consumer peels that single layer here before decoding; see
/// port-findings.md section A. A missing body (`Ok(None)`) becomes
/// `Value::Null`; text that is not valid JSON (a non-JSON blob body) is kept
/// as-is by wrapping it in a string.
fn call_value(host: &mut dyn ObeliskHost, ffqn: &str, params_json: &str) -> Result<Value, String> {
    match host.call_json(ffqn, params_json)? {
        Some(text) => Ok(serde_json::from_str(&text).unwrap_or(Value::String(text))),
        None => Ok(Value::Null),
    }
}

fn ensure_trailing_newline(text: String) -> String {
    if text.ends_with('\n') {
        text
    } else {
        format!("{text}\n")
    }
}

fn mount_result_json(result: &MountResult) -> String {
    pretty_json(&json!({
        "deployment_id": result.deployment_id,
        "files": result.files,
    }))
}

/// PORT: `decodeString`. `value` is the already-peeled `call_value` result. A
/// string that itself parses as a JSON string yields the inner contents (the
/// `current-deployment-id` case, whose body is `resp.text()` of a JSON string,
/// so it arrives double-quoted); a string that parses as an object falls back
/// to its `deployment_id` field; anything else is the trimmed string. A
/// non-string value coerces to text.
fn decode_string(value: &Value) -> String {
    let Value::String(s) = value else {
        return coerce_text(value);
    };
    match serde_json::from_str::<Value>(s) {
        Ok(Value::String(inner)) => inner,
        Ok(other) => other
            .get("deployment_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        Err(_) => s.trim().to_string(),
    }
}

/// PORT: `decodeJson`. An object/array passes through; a string is parsed once.
/// backcompat: 0.1.0 deployment-checkout returned its record as a JSON string.
fn decode_json(value: &Value) -> Result<Value, String> {
    match value {
        Value::Object(_) | Value::Array(_) => Ok(value.clone()),
        Value::String(s) => serde_json::from_str(s).map_err(|e| format!("invalid JSON: {e}")),
        other => serde_json::from_str(&other.to_string()).map_err(|e| format!("invalid JSON: {e}")),
    }
}

/// PORT: JS `String(content)` for blob bodies: the peeled string verbatim (no
/// re-parse, no trim, unlike `decode_string`), or a coercion of a non-string.
fn coerce_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn required<'a>(value: Option<&'a str>, label: &str) -> Result<&'a str, String> {
    match value {
        Some(v) if !v.is_empty() => Ok(v),
        _ => Err(format!("{label} is required")),
    }
}

fn option<'a>(args: &'a [String], name: &str, fallback: &'a str) -> &'a str {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .map(String::as_str)
        .unwrap_or(fallback)
}

fn integer_option(args: &[String], name: &str, fallback: i64) -> i64 {
    match args
        .iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
    {
        Some(raw) => raw
            .parse::<i64>()
            .ok()
            .filter(|n| *n >= 0)
            .unwrap_or(fallback),
        None => fallback,
    }
}

fn flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

fn basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

fn ok(stdout: String) -> CommandOutput {
    CommandOutput {
        stdout,
        stderr: String::new(),
        exit_code: 0,
    }
}

fn fail(stderr: String) -> CommandOutput {
    CommandOutput {
        stdout: String::new(),
        stderr,
        exit_code: 2,
    }
}

fn fs_error_message(error: FsError) -> String {
    match error {
        FsError::NotFound(p) => format!("{p}: No such file or directory"),
        FsError::IsDirectory(p) => format!("{p}: Is a directory"),
        FsError::FileExists(p) => format!("{p}: File exists"),
        FsError::ReadUnavailable(p) => format!("{p}: File body is unavailable"),
    }
}

fn is_help_flag(arg: &str) -> bool {
    arg == "-h" || arg == "--help"
}

fn help_requested(args: &[String]) -> bool {
    args.iter().any(|a| is_help_flag(a))
}

/// Usage for a command group (`obelisk <group> --help`), or the top-level help
/// for an unrecognized group.
fn group_help(group: &str) -> String {
    match group {
        "functions" => functions_help(),
        "executions" => executions_help(),
        "call" => call_help(),
        "deployment" => deployment_help(),
        "generate" => generate_help(),
        _ => help(),
    }
}

/// Usage for a specific subcommand (`obelisk <group> <action> --help`). Only the
/// deployment subcommands (and `call`) carry their own option list; everything
/// else falls back to the group help, which already lists each subcommand.
fn action_help(group: &str, action: &str) -> String {
    match (group, action) {
        ("call", _) => call_help(),
        ("deployment", "submit") => deployment_submit_help(),
        ("deployment", "check") => deployment_check_help(),
        ("deployment", "switch") => deployment_switch_help(),
        ("deployment", "apply") => deployment_apply_help(),
        ("generate", "deployment") => generate_deployment_help(),
        _ => group_help(group),
    }
}

fn help() -> String {
    "Usage: obelisk <command> [args]\n\
\n\
Query and control the running Obelisk server, and edit the deployment checked\n\
out under /workspace/deployment/current.\n\
\n\
Commands:\n\
  functions    List deployed functions, or print a function's WIT.\n\
  executions   List executions, or show one execution's record, logs, or result.\n\
  call         Call a deployed function and print its result.\n\
  deployment   Inspect, edit, submit, and activate deployments.\n\
  generate     Print a starter configuration file.\n\
\n\
Run `obelisk <command> --help` (or `-h`) for a command's subcommands and options.\n"
        .to_string()
}

fn functions_help() -> String {
    "Usage: obelisk functions <subcommand>\n\
\n\
List deployed functions, or print a single function's WIT interface.\n\
\n\
Subcommands:\n\
  list [--prefix PREFIX] [--length N] [--json]   List functions and their signatures.\n\
  wit FFQN                                        Print the WIT interface for one function.\n"
        .to_string()
}

fn executions_help() -> String {
    "Usage: obelisk executions <subcommand>\n\
\n\
List executions, or show one execution's record, logs, or result.\n\
\n\
Subcommands:\n\
  list [--ffqn-prefix PREFIX] [--id-prefix PREFIX] [--show-derived] [--hide-finished] [--length N]\n\
                                                  List executions (most recent first).\n\
  get ID                                          Show an execution's record.\n\
  logs ID [--length N]                            Show an execution's logs.\n\
  result ID                                       Show an execution's result value.\n"
        .to_string()
}

fn call_help() -> String {
    "Usage: obelisk call FFQN [PARAMS_JSON]\n\
       obelisk call FFQN -- PARAM...\n\
\n\
Call a deployed function and print its result. Pass parameters as one JSON array\n\
in WIT parameter order, or after `--` as positional values (each parsed as JSON\n\
when valid, otherwise as a string). With neither, parameters are read from stdin,\n\
defaulting to `[]`.\n"
        .to_string()
}

fn deployment_help() -> String {
    "Usage: obelisk deployment <subcommand>\n\
\n\
Inspect, edit, submit, and activate deployments. Edits under\n\
/workspace/deployment/current are local until `submit` or `apply`.\n\
\n\
Subcommands:\n\
  current                   Print the active deployment ID.\n\
  refresh                   Re-fetch the active deployment, discarding local edits.\n\
  check [PATH]              Report a deployment's manifest and locally-edited sources.\n\
  submit [PATH] [OPTIONS]   Store the edited deployment as a new inactive deployment.\n\
  switch ID [OPTIONS]       Activate a stored deployment (verified on next server restart).\n\
  apply ID                  Submit-and-apply: hot-redeploy a stored deployment now.\n\
\n\
Run `obelisk deployment <subcommand> --help` for a subcommand's options.\n"
        .to_string()
}

fn deployment_submit_help() -> String {
    "Usage: obelisk deployment submit [OPTIONS] [PATH-TO-DEPLOYMENT.TOML]\n\
\n\
Store the edited deployment as a new inactive deployment and print its ID. PATH\n\
is the deployment.toml to submit, or the directory containing it; it defaults to\n\
./deployment.toml. Digests are recomputed from the files, so leave them out.\n\
\n\
Options:\n\
      --description TEXT               Human-readable description for the new deployment.\n\
      --allow-missing-runtime-config  Tolerate runtime config unavailable on this server.\n\
                                       (alias: --allow-unavailable-runtime-config)\n"
        .to_string()
}

fn deployment_check_help() -> String {
    "Usage: obelisk deployment check [PATH-TO-DEPLOYMENT.TOML]\n\
\n\
Report a deployment's manifest size and the owned sources edited locally (the\n\
files a submit would upload). PATH is the deployment.toml, or its directory; it\n\
defaults to ./deployment.toml.\n"
        .to_string()
}

fn deployment_switch_help() -> String {
    "Usage: obelisk deployment switch [OPTIONS] ID\n\
\n\
Mark a stored deployment active; it is verified and applied on the next server\n\
restart.\n\
\n\
Options:\n\
      --allow-missing-runtime-config  Tolerate runtime config unavailable on this server.\n\
                                       (alias: --allow-unavailable-runtime-config)\n"
        .to_string()
}

fn deployment_apply_help() -> String {
    "Usage: obelisk deployment apply ID\n\
\n\
Hot-redeploy a stored deployment now (fails if it cannot be applied live).\n"
        .to_string()
}

fn generate_help() -> String {
    "Usage: obelisk generate <subcommand>\n\
\n\
Print a starter Obelisk configuration file.\n\
\n\
Subcommands:\n\
  deployment   Print a default deployment.toml with every option documented.\n"
        .to_string()
}

fn generate_deployment_help() -> String {
    "Usage: obelisk generate deployment\n\
\n\
Print a default deployment.toml with every option documented as comments.\n\
Redirect it to a file to scaffold a new deployment, e.g.\n\
`obelisk generate deployment > deployment.toml`.\n"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bash::Bash;
    use crate::custom_command::CustomCommands;
    use crate::types::BashOptions;
    use std::collections::BTreeMap;

    /// A fake host backed by an in-memory ffqn -> canned-JSON-response queue,
    /// for tests only. A call to an ffqn with no fixture errors, mirroring a
    /// call to something nothing implements. Multiple `.with` calls for one ffqn
    /// enqueue successive responses (so a test can model a preflight that reports
    /// missing files then a retry that succeeds); the last response repeats once
    /// the queue is down to one. Records every call so tests can assert on the
    /// exact params sent.
    struct FakeHost {
        responses: BTreeMap<String, std::collections::VecDeque<Result<String, String>>>,
        calls: Vec<(String, String)>,
    }

    impl FakeHost {
        fn new() -> Self {
            Self {
                responses: BTreeMap::new(),
                calls: Vec::new(),
            }
        }

        fn with(mut self, ffqn: &str, response_json: &str) -> Self {
            self.responses
                .entry(ffqn.to_string())
                .or_default()
                .push_back(Ok(response_json.to_string()));
            self
        }

        /// Enqueue an activity `Err` (a stringified tool/submit error), mirroring
        /// how the real host seam surfaces a returned error result.
        fn with_err(mut self, ffqn: &str, message: &str) -> Self {
            self.responses
                .entry(ffqn.to_string())
                .or_default()
                .push_back(Err(message.to_string()));
            self
        }
    }

    impl ObeliskHost for FakeHost {
        fn call_json(&mut self, ffqn: &str, params_json: &str) -> Result<Option<String>, String> {
            self.calls.push((ffqn.to_string(), params_json.to_string()));
            let queue = self
                .responses
                .get_mut(ffqn)
                .ok_or_else(|| format!("no fixture for {ffqn}"))?;
            let response = if queue.len() > 1 {
                queue.pop_front().unwrap()
            } else {
                queue
                    .front()
                    .cloned()
                    .ok_or_else(|| format!("no fixture for {ffqn}"))?
            };
            response.map(Some)
        }
    }

    /// A digest-addressed blob loader for the lazy-mount tests: mount now only
    /// registers file *structure*, so a test that wants a file's bytes installs
    /// one of these (mirroring the real CAS, keyed by content digest).
    struct FixtureLoader(BTreeMap<String, Vec<u8>>);

    impl FixtureLoader {
        fn rc(entries: &[(&str, &[u8])]) -> Rc<dyn BlobLoader> {
            Rc::new(FixtureLoader(
                entries
                    .iter()
                    .map(|(d, b)| (d.to_string(), b.to_vec()))
                    .collect(),
            ))
        }
    }

    impl BlobLoader for FixtureLoader {
        fn load(&self, digest: &str) -> Result<Vec<u8>, String> {
            self.0
                .get(digest)
                .cloned()
                .ok_or_else(|| format!("no blob for {digest}"))
        }
    }

    fn words(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn interp(cwd: &str) -> Interpreter {
        Interpreter::new(
            BTreeMap::new(),
            cwd.to_string(),
            Vfs::new(),
            || 0,
            CustomCommands::new(),
        )
    }

    // -- subcommand routing / argument parsing (direct calls, bypassing the
    // shell so test args don't have to survive quoting/splitting) --

    #[test]
    fn bare_obelisk_prints_command_list() {
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &[], "", &mut host);
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.starts_with("Usage: obelisk <command>"));
    }

    #[test]
    fn help_flags_print_usage_at_every_level() {
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        // Top level.
        for case in [words(&["--help"]), words(&["-h"])] {
            let out = execute_obelisk(&mut i, &case, "", &mut host);
            assert_eq!(out.exit_code, 0);
            assert!(out.stdout.starts_with("Usage: obelisk <command>"));
        }
        // Group help (`obelisk deployment -h`).
        let out = execute_obelisk(&mut i, &words(&["deployment", "-h"]), "", &mut host);
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.starts_with("Usage: obelisk deployment"));
        // Subcommand help (`obelisk deployment submit --help`).
        let out = execute_obelisk(
            &mut i,
            &words(&["deployment", "submit", "--help"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.contains("PATH-TO-DEPLOYMENT.TOML"));
        // `call -h` reaches the call help even though the ffqn sits in the
        // action slot, but a help flag after `--` is a positional parameter.
        let out = execute_obelisk(&mut i, &words(&["call", "-h"]), "", &mut host);
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.starts_with("Usage: obelisk call"));
        // No help path ever hits the host.
        assert!(host.calls.is_empty());
    }

    #[test]
    fn command_groups_require_an_action() {
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        for group in ["functions", "executions", "deployment"] {
            let out = execute_obelisk(&mut i, &words(&[group]), "", &mut host);
            assert_eq!(out.exit_code, 2);
            assert!(!out.stderr.is_empty());
        }
        assert!(host.calls.is_empty());
    }

    #[test]
    fn unknown_command_reports_help() {
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["nonsense"]), "", &mut host);
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("unknown command 'nonsense'"));
        assert!(out.stderr.contains("Usage: obelisk <command>"));
    }

    #[test]
    fn functions_list_forwards_prefix_and_length() {
        let mut host = FakeHost::new().with(
            "obelisk-agent:tools/webapi.list-functions",
            r#"[
                {
                    "ffqn":"foo:bar/api.run",
                    "parameter_types":[
                        {"name":"input","wit_type":"string"},
                        {"name":"retries","wit_type":"u32"}
                    ],
                    "return_type":"result<string, error>",
                    "extension":null,
                    "wit":"unused"
                },
                {
                    "ffqn":"foo:bar/api.run-submit",
                    "parameter_types":[],
                    "return_type":"execution-id",
                    "extension":"submit",
                    "wit":"unused"
                }
            ]"#,
        );
        let mut i = interp("/workspace");
        let out = execute_obelisk(
            &mut i,
            &words(&["functions", "list", "--prefix", "foo", "--length", "5"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 0);
        assert_eq!(
            out.stdout,
            "foo:bar/api.run : func(input: string, retries: u32) -> result<string, error>\n"
        );
        assert_eq!(
            host.calls,
            vec![(
                "obelisk-agent:tools/webapi.list-functions".to_string(),
                "[\"foo\",5]".to_string()
            )]
        );
    }

    #[test]
    fn functions_list_json_preserves_structured_output() {
        let mut host = FakeHost::new().with(
            "obelisk-agent:tools/webapi.list-functions",
            r#"[{"ffqn":"a","extension":null}]"#,
        );
        let mut i = interp("/workspace");
        let out = execute_obelisk(
            &mut i,
            &words(&["functions", "list", "--json"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 0);
        assert_eq!(
            out.stdout,
            "[\n  {\n    \"ffqn\": \"a\",\n    \"extension\": null\n  }\n]\n"
        );
    }

    #[test]
    fn functions_list_defaults_when_flags_absent() {
        let mut host = FakeHost::new().with("obelisk-agent:tools/webapi.list-functions", "[]");
        let mut i = interp("/workspace");
        execute_obelisk(&mut i, &words(&["functions", "list"]), "", &mut host);
        assert_eq!(host.calls[0].1, "[\"\",100]");
    }

    #[test]
    fn functions_list_formats_a_json_string_body() {
        // backcompat: 0.1.0 list-functions returned its array as a JSON string.
        let mut host = FakeHost::new().with(
            "obelisk-agent:tools/webapi.list-functions",
            "\"[{\\\"ffqn\\\":\\\"a\\\",\\\"parameter_types\\\":[],\\\"return_type\\\":\\\"string\\\",\\\"extension\\\":null}]\"",
        );
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["functions", "list"]), "", &mut host);
        assert_eq!(out.exit_code, 0);
        assert_eq!(out.stdout, "a : func() -> string\n");
    }

    #[test]
    fn functions_wit_prints_non_json_text_verbatim() {
        // A WIT body is plain text, not JSON: it must pass through untouched
        // rather than being mangled by the JSON pretty-printer.
        let wit = "\"interface foo { bar: func() }\"";
        let mut host = FakeHost::new().with("obelisk-agent:tools/webapi.get-function-wit", wit);
        let mut i = interp("/workspace");
        let out = execute_obelisk(
            &mut i,
            &words(&["functions", "wit", "a:b/c.d"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 0);
        assert_eq!(out.stdout, "interface foo { bar: func() }\n");
    }

    #[test]
    fn functions_wit_requires_ffqn() {
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["functions", "wit"]), "", &mut host);
        assert_eq!(out.exit_code, 2);
        assert_eq!(out.stderr, "obelisk: ffqn is required\n");
    }

    #[test]
    fn executions_list_forwards_all_flags_in_order() {
        let mut host = FakeHost::new().with("obelisk-agent:tools/webapi.list-executions", "[]");
        let mut i = interp("/workspace");
        execute_obelisk(
            &mut i,
            &words(&[
                "executions",
                "list",
                "--ffqn-prefix",
                "pfx",
                "--show-derived",
                "--length",
                "7",
            ]),
            "",
            &mut host,
        );
        assert_eq!(
            host.calls[0].1,
            "[\"pfx\",\"\",true,false,\"\",\"\",\"\",\"\",false,7]"
        );
    }

    #[test]
    fn executions_get_requires_id() {
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["executions", "get"]), "", &mut host);
        assert_eq!(out.exit_code, 2);
        assert_eq!(out.stderr, "obelisk: execution id is required\n");
    }

    #[test]
    fn executions_logs_forwards_id_and_length() {
        let mut host = FakeHost::new().with("obelisk-agent:tools/webapi.get-logs", "\"log\"");
        let mut i = interp("/workspace");
        let out = execute_obelisk(
            &mut i,
            &words(&["executions", "logs", "exec-1", "--length", "50"]),
            "",
            &mut host,
        );
        // The string body prints verbatim; the `call_json` JSON layer is peeled.
        assert_eq!(out.stdout, "log\n");
        assert_eq!(
            host.calls[0].1,
            "[\"exec-1\",true,true,true,[],[],\"\",\"\",false,50]"
        );
    }

    #[test]
    fn executions_result_forwards_id() {
        let mut host =
            FakeHost::new().with("obelisk-agent:tools/webapi.get-result-json", "{\"ok\":1}");
        let mut i = interp("/workspace");
        let out = execute_obelisk(
            &mut i,
            &words(&["executions", "result", "exec-1"]),
            "",
            &mut host,
        );
        assert_eq!(out.stdout, "{\n  \"ok\": 1\n}\n");
    }

    #[test]
    fn call_uses_explicit_params_over_stdin() {
        let mut host = FakeHost::new().with("obelisk-control:tools/native.call", "42");
        let mut i = interp("/workspace");
        let out = execute_obelisk(
            &mut i,
            &words(&["call", "some:ffqn", "[1]"]),
            "[2]",
            &mut host,
        );
        assert_eq!(out.stdout, "42\n");
        assert_eq!(host.calls[0].1, "[\"some:ffqn\",\"[1]\"]");
    }

    #[test]
    fn call_prints_only_the_target_result() {
        let mut host =
            FakeHost::new().with("obelisk-control:tools/native.call", r#""{\"answer\":42}""#);
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["call", "some:ffqn", "[]"]), "", &mut host);
        assert_eq!(out.stdout, "{\n  \"answer\": 42\n}\n");

        let mut host =
            FakeHost::new().with("obelisk-control:tools/native.call", r#""\"plain result\"""#);
        let out = execute_obelisk(&mut i, &words(&["call", "some:ffqn", "[]"]), "", &mut host);
        assert_eq!(out.stdout, "plain result\n");
    }

    #[test]
    fn call_failure_is_a_command_error_not_a_result() {
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["call", "some:ffqn", "[]"]), "", &mut host);
        assert_eq!(out.exit_code, 2);
        assert!(out.stdout.is_empty());
        assert!(out.stderr.starts_with("obelisk: no fixture for"));
    }

    #[test]
    fn call_falls_back_to_stdin_then_to_empty_array() {
        let mut host = FakeHost::new().with("obelisk-control:tools/native.call", "1");
        let mut i = interp("/workspace");
        execute_obelisk(&mut i, &words(&["call", "some:ffqn"]), "[9]", &mut host);
        assert_eq!(host.calls[0].1, "[\"some:ffqn\",\"[9]\"]");

        let mut host = FakeHost::new().with("obelisk-control:tools/native.call", "1");
        execute_obelisk(&mut i, &words(&["call", "some:ffqn"]), "", &mut host);
        assert_eq!(host.calls[0].1, "[\"some:ffqn\",\"[]\"]");
    }

    #[test]
    fn call_accepts_positional_params_after_separator() {
        let mut host = FakeHost::new().with("obelisk-control:tools/native.call", "1");
        let mut i = interp("/workspace");
        execute_obelisk(
            &mut i,
            &words(&[
                "call",
                "some:ffqn",
                "--",
                "1",
                "true",
                "null",
                r#"{"field":2}"#,
                "plain text",
                r#""42""#,
            ]),
            "ignored stdin",
            &mut host,
        );
        assert_eq!(
            host.calls[0].1,
            r#"["some:ffqn","[1,true,null,{\"field\":2},\"plain text\",\"42\"]"]"#
        );
    }

    #[test]
    fn call_rejects_multiple_arguments_without_separator() {
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        let out = execute_obelisk(
            &mut i,
            &words(&["call", "some:ffqn", "1", "2"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("expected one params JSON array"));
        assert!(host.calls.is_empty());
    }

    #[test]
    fn call_rejects_explicitly_empty_params_arg() {
        // `obelisk call ffqn "$(cat missing.json)"` where the substitution is
        // empty: reject instead of silently sending `[]` (which the server then
        // rejects with a confusing cardinality mismatch).
        let mut host = FakeHost::new().with("obelisk-control:tools/native.call", "1");
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["call", "some:ffqn", ""]), "", &mut host);
        assert_eq!(out.exit_code, 2);
        assert!(
            out.stderr.contains("params-json argument is empty"),
            "{}",
            out.stderr
        );
        assert!(host.calls.is_empty());
    }

    #[test]
    fn call_requires_ffqn() {
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["call"]), "", &mut host);
        assert_eq!(out.exit_code, 2);
        assert_eq!(out.stderr, "obelisk: ffqn is required\n");
    }

    #[test]
    fn deployment_current_calls_host() {
        let mut host = FakeHost::new().with(
            "obelisk-agent:tools/webapi.current-deployment-id",
            "\"dep-1\"",
        );
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["deployment", "current"]), "", &mut host);
        assert_eq!(out.stdout, "dep-1\n");
    }

    #[test]
    fn deployment_switch_requires_id_and_forwards_flag() {
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["deployment", "switch"]), "", &mut host);
        assert_eq!(out.exit_code, 2);
        assert_eq!(out.stderr, "obelisk: deployment id is required\n");

        let mut host = FakeHost::new().with("obelisk-agent:tools/webapi.deployment-switch", "null");
        execute_obelisk(
            &mut i,
            &words(&[
                "deployment",
                "switch",
                "dep-2",
                "--allow-missing-runtime-config",
            ]),
            "",
            &mut host,
        );
        assert_eq!(host.calls[0].1, "[\"dep-2\",true]");
    }

    #[test]
    fn deployment_apply_requires_id() {
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["deployment", "apply"]), "", &mut host);
        assert_eq!(out.exit_code, 2);
        assert_eq!(out.stderr, "obelisk: deployment id is required\n");
    }

    #[test]
    fn deployment_unknown_action() {
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["deployment", "bogus"]), "", &mut host);
        assert_eq!(out.exit_code, 2);
        assert_eq!(out.stderr, "obelisk deployment: unknown action 'bogus'\n");
    }

    #[test]
    fn generate_deployment_prints_the_embedded_template() {
        // The template is captured from the real `obelisk generate deployment` at
        // build time; assert on a stable marker rather than the whole body, and
        // that it never touches the host (it is a purely local echo).
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["generate", "deployment"]), "", &mut host);
        assert_eq!(out.exit_code, 0);
        assert!(out.stdout.contains("[[activity_wasm]]"), "{}", out.stdout);
        assert!(out.stdout.ends_with('\n'));
        assert!(host.calls.is_empty());
    }

    #[test]
    fn generate_requires_a_known_subcommand() {
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["generate"]), "", &mut host);
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.contains("a subcommand is required"));

        let out = execute_obelisk(&mut i, &words(&["generate", "bogus"]), "", &mut host);
        assert_eq!(out.exit_code, 2);
        assert_eq!(out.stderr, "obelisk generate: unknown action 'bogus'\n");
        assert!(host.calls.is_empty());
    }

    #[test]
    fn host_error_propagates_with_obelisk_prefix() {
        let mut host = FakeHost::new(); // no fixtures registered
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["functions", "list"]), "", &mut host);
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.starts_with("obelisk: no fixture for"));
    }

    // -- owned_source_locations, over a parsed document --

    #[test]
    fn owned_source_locations_scans_tables_and_skips_oci_and_nested() {
        let toml = "[[activity_wasm]]\n\
location = \"a.wasm\"\n\
content_digest = \"sha256:1\"\n\
\n\
[[activity_wasm]]\n\
location = \"oci://example/img\"\n\
content_digest = \"sha256:2\"\n\
\n\
[[webhook_endpoint.other]]\n\
location = \"nested.wasm\"\n\
content_digest = \"sha256:3\"\n";
        // Only the top-level, non-oci location is owned; the oci entry and the
        // nested `[[webhook_endpoint.other]]` array-of-tables are skipped.
        assert_eq!(owned_source_locations(toml), vec!["a.wasm".to_string()]);
    }

    #[test]
    fn owned_source_locations_read_nested_table_and_inline_backtrace() {
        // Nested-table form (obelisk's stored shape): the wasm location plus both
        // backtrace sources, deduped.
        let table = "[[workflow_wasm]]\n\
name = \"wf\"\n\
location = \"w.wasm\"\n\
content_digest = \"sha256:9\"\n\
\n\
[workflow_wasm.backtrace.sources]\n\
\".../src/lib.rs\" = { path = \"src/lib.rs\", content_digest = \"sha256:1\" }\n\
\".../src/util.rs\" = { path = \"src/util.rs\", content_digest = \"sha256:2\" }\n";
        assert_eq!(
            owned_source_locations(table),
            vec![
                "w.wasm".to_string(),
                "src/lib.rs".to_string(),
                "src/util.rs".to_string(),
            ]
        );

        // Inline form within the `[[workflow_wasm]]` table (nested inline table).
        let inline = "[[workflow_wasm]]\n\
name = \"wf\"\n\
location = \"w.wasm\"\n\
content_digest = \"sha256:9\"\n\
backtrace.sources = { \".../src/lib.rs\" = { path = \"src/lib.rs\", content_digest = \"sha256:1\" } }\n";
        assert_eq!(
            owned_source_locations(inline),
            vec!["w.wasm".to_string(), "src/lib.rs".to_string()]
        );
    }

    #[test]
    fn simplify_manifest_tolerates_reformatted_component_files() {
        // The old line-based scanner assumed `component_files` sat on a single
        // line; toml_edit parses the document, so a multi-line inline table (valid
        // TOML the agent might hand-write) is handled the same. Regression guard
        // for the parser swap.
        let stored = concat!(
            "[[webhook_endpoint]]\n",
            "location = \"webhook/ui-api.js\"\n",
            "content_digest = \"sha256:aa\"\n",
            "component_files = {\n",
            "  \"webhook/ui-api.js\" = \"sha256:aa\",\n",
            "  \"webhook/ui/shell.js\" = \"sha256:bb\",\n",
            "}\n",
        );
        let simplified = simplify_manifest(stored);
        assert!(!simplified.contains("sha256:aa"), "{simplified}");
        assert!(!simplified.contains("sha256:bb"), "{simplified}");
        assert!(!simplified.contains("content_digest"), "{simplified}");
        assert_eq!(simplified.matches("\"auto\"").count(), 2, "{simplified}");
    }

    // -- the deployment-mount VFS layout --

    #[test]
    fn mount_checks_out_deployment_and_symlinks_current() {
        let manifest = "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:1\"\n";
        let mut host = FakeHost::new()
            .with(
                "obelisk-agent:tools/webapi.current-deployment-id",
                "\"dep-1\"",
            )
            .with(
                "obelisk-agent:tools/webapi.deployment-checkout",
                &json!({
                    "deployment_toml": manifest,
                    "files": [{"path": "a.wasm", "digest": "sha256:1", "size": 12}]
                })
                .to_string(),
            );
        let mut fs = Vfs::new();
        let result = mount(&mut fs, &mut host).unwrap();
        assert_eq!(
            result,
            MountResult {
                deployment_id: Some("dep-1".to_string()),
                files: 2
            }
        );
        // Mount fetches only the manifest; the blob endpoint is never called.
        assert!(
            !host
                .calls
                .iter()
                .any(|(ffqn, _)| ffqn == "obelisk-agent:tools/webapi.deployment-read-blob")
        );
        assert!(fs.is_dir("/workspace/deployment/current"));
        // The mounted manifest is the digest-free view the agent edits.
        assert_eq!(
            fs.read_file("/workspace/deployment/current/deployment.toml")
                .as_deref(),
            Some(simplify_manifest(manifest).as_bytes())
        );
        // The owned source lists immediately but holds no bytes until a loader
        // is installed and the file is read.
        assert!(fs.is_file("/workspace/deployment/current/a.wasm"));
        fs.set_blob_loader(FixtureLoader::rc(&[("sha256:1", b"binary-bytes")]));
        assert_eq!(
            fs.read_file("/workspace/deployment/current/a.wasm")
                .as_deref(),
            Some(&b"binary-bytes"[..])
        );
        assert_eq!(
            fs.read_file("/workspace/deployment/dep-1/a.wasm")
                .as_deref(),
            Some(&b"binary-bytes"[..])
        );
    }

    #[test]
    fn mount_registers_backtrace_sources_from_the_nested_table() {
        // Obelisk stores backtrace sources in a nested table with inline
        // `{ path, content_digest }` values; the component scanner never sees
        // them, so this exercises the dedicated backtrace scan.
        let manifest = "[[workflow_wasm]]\n\
name = \"wf\"\n\
location = \"components/w.wasm\"\n\
content_digest = \"sha256:1\"\n\
\n\
[workflow_wasm.backtrace.sources]\n\
\".../src/lib.rs\" = { path = \"workflow/workflow-rs/src/lib.rs\", content_digest = \"sha256:2\" }\n";
        let mut host = FakeHost::new()
            .with(
                "obelisk-agent:tools/webapi.current-deployment-id",
                "\"dep-1\"",
            )
            .with(
                "obelisk-agent:tools/webapi.deployment-checkout",
                &json!({
                    "deployment_toml": manifest,
                    "files": [
                        {"path": "components/w.wasm", "digest": "sha256:1", "size": 12},
                        {"path": "workflow/workflow-rs/src/lib.rs", "digest": "sha256:2", "size": 16}
                    ]
                })
                .to_string(),
            );
        let mut fs = Vfs::new();
        let result = mount(&mut fs, &mut host).unwrap();
        // manifest + the wasm component + the backtrace source.
        assert_eq!(result.files, 3);
        assert!(fs.is_file("/workspace/deployment/current/workflow/workflow-rs/src/lib.rs"));
        fs.set_blob_loader(FixtureLoader::rc(&[("sha256:2", b"fn workflow() {}")]));
        assert_eq!(
            fs.read_file("/workspace/deployment/current/workflow/workflow-rs/src/lib.rs")
                .as_deref(),
            Some(&b"fn workflow() {}"[..])
        );
    }

    #[test]
    fn mount_peels_double_quoted_deployment_id_before_checkout() {
        // Regression for port-findings.md A: `current-deployment-id` is
        // `resp.text()` of an application/json body, so its WIT string value is
        // itself a quoted JSON string. `call_json` re-encodes that, arriving
        // double-quoted (`"\"Dep_X\""`); the id must be peeled to `Dep_X`
        // before it is forwarded to `deployment-checkout`.
        let manifest = "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:1\"\n";
        let mut host = FakeHost::new()
            .with(
                "obelisk-agent:tools/webapi.current-deployment-id",
                "\"\\\"Dep_X\\\"\"",
            )
            .with(
                "obelisk-agent:tools/webapi.deployment-checkout",
                &json!(
                    json!({
                        "deployment_toml": manifest,
                        "files": [{"path": "a.wasm", "digest": "sha256:1", "size": 5}]
                    })
                    .to_string()
                )
                .to_string(),
            )
            .with(
                "obelisk-agent:tools/webapi.deployment-read-blob",
                &json!("bytes").to_string(),
            );
        let mut fs = Vfs::new();
        let result = mount(&mut fs, &mut host).unwrap();
        assert_eq!(result.deployment_id.as_deref(), Some("Dep_X"));
        // The checkout call gets the unwrapped id, not the still-quoted string.
        assert_eq!(
            host.calls[1],
            (
                "obelisk-agent:tools/webapi.deployment-checkout".to_string(),
                "[\"Dep_X\"]".to_string()
            )
        );
        assert!(fs.is_dir("/workspace/deployment/Dep_X"));
    }

    #[test]
    fn mount_with_no_active_deployment_is_a_no_op() {
        let mut host =
            FakeHost::new().with("obelisk-agent:tools/webapi.current-deployment-id", "\"\"");
        let mut fs = Vfs::new();
        let result = mount(&mut fs, &mut host).unwrap();
        assert_eq!(
            result,
            MountResult {
                deployment_id: None,
                files: 0
            }
        );
        assert!(!fs.exists("/workspace/deployment"));
    }

    #[test]
    fn refresh_replaces_manifest_and_repoints_current_at_the_new_dir() {
        let manifest_v1 =
            "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:1\"\n";
        let manifest_v2 =
            "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:2\"\n";
        let mut host_v1 = FakeHost::new()
            .with(
                "obelisk-agent:tools/webapi.current-deployment-id",
                "\"dep-1\"",
            )
            .with(
                "obelisk-agent:tools/webapi.deployment-checkout",
                &json!({
                    "deployment_toml": manifest_v1,
                    "files": [{"path": "a.wasm", "digest": "sha256:1", "size": 2}]
                })
                .to_string(),
            );
        let mut fs = Vfs::new();
        // A single digest-addressed loader stands in for the CAS across both
        // deployments (the real HostBlobLoader is likewise one per session).
        fs.set_blob_loader(FixtureLoader::rc(&[
            ("sha256:1", b"v1"),
            ("sha256:2", b"v2"),
        ]));
        mount(&mut fs, &mut host_v1).unwrap();

        let mut host_v2 = FakeHost::new()
            .with(
                "obelisk-agent:tools/webapi.current-deployment-id",
                "\"dep-2\"",
            )
            .with(
                "obelisk-agent:tools/webapi.deployment-checkout",
                &json!({
                    "deployment_toml": manifest_v2,
                    "files": [{"path": "a.wasm", "digest": "sha256:2", "size": 2}]
                })
                .to_string(),
            );
        let result = refresh_deployment_mount(&mut fs, &mut host_v2, true).unwrap();
        assert_eq!(result.deployment_id.as_deref(), Some("dep-2"));
        // The old deployment dir is untouched; `current` now resolves to the new
        // one and reads the new digest (sha256:2).
        assert_eq!(
            fs.read_file("/workspace/deployment/dep-1/a.wasm")
                .as_deref(),
            Some(&b"v1"[..])
        );
        assert_eq!(
            fs.read_file("/workspace/deployment/current/a.wasm")
                .as_deref(),
            Some(&b"v2"[..])
        );
    }

    #[test]
    fn deployment_refresh_action_calls_mount_and_reports_json() {
        let manifest = "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:1\"\n";
        let mut host = FakeHost::new()
            .with(
                "obelisk-agent:tools/webapi.current-deployment-id",
                "\"dep-1\"",
            )
            .with(
                "obelisk-agent:tools/webapi.deployment-checkout",
                &json!({
                    "deployment_toml": manifest,
                    "files": [{"path": "a.wasm", "digest": "sha256:1", "size": 5}]
                })
                .to_string(),
            )
            .with(
                "obelisk-agent:tools/webapi.deployment-read-blob",
                &json!("bytes").to_string(),
            );
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["deployment", "refresh"]), "", &mut host);
        assert_eq!(out.exit_code, 0);
        assert_eq!(
            out.stdout,
            "{\n  \"deployment_id\": \"dep-1\",\n  \"files\": 2\n}\n"
        );
    }

    #[test]
    fn deployment_check_reports_manifest_and_owned_sources() {
        let manifest = "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:1\"\n";
        let mut i = interp("/workspace");
        i.fs.write_file(
            "/workspace/deployment/dep-1/deployment.toml",
            manifest.as_bytes(),
        )
        .unwrap();
        i.fs.write_file("/workspace/deployment/dep-1/a.wasm", b"bytes")
            .unwrap();
        let mut host = FakeHost::new();
        let out = execute_obelisk(
            &mut i,
            &words(&["deployment", "check", "/workspace/deployment/dep-1"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        let parsed: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(parsed["directory"], "/workspace/deployment/dep-1");
        assert_eq!(parsed["owned_sources"], json!(["a.wasm"]));
    }

    #[test]
    fn deployment_check_defaults_directory_to_cwd() {
        let manifest = "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:1\"\n";
        let mut i = interp("/workspace/deployment/current");
        i.fs.write_file(
            "/workspace/deployment/current/deployment.toml",
            manifest.as_bytes(),
        )
        .unwrap();
        let mut host = FakeHost::new();
        let out = execute_obelisk(&mut i, &words(&["deployment", "check"]), "", &mut host);
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        let parsed: Value = serde_json::from_str(&out.stdout).unwrap();
        assert_eq!(parsed["directory"], "/workspace/deployment/current");
    }

    #[test]
    fn deployment_submit_preflights_then_attaches_the_missing_blob() {
        let manifest = "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:1\"\n";
        let mut i = interp("/workspace");
        i.fs.write_file(
            "/workspace/deployment/dep-1/deployment.toml",
            manifest.as_bytes(),
        )
        .unwrap();
        // A locally-written (non-lazy) file whose new digest is not yet in the CAS.
        i.fs.write_file("/workspace/deployment/dep-1/a.wasm", b"bytes")
            .unwrap();
        let digest = format!("sha256:{}", sha256_hex(b"bytes"));
        let mut host = FakeHost::new()
            .with_err(
                SUBMIT_FFQN,
                &format!(
                    r#"{{"permanent_missing_files":[{{"path":"a.wasm","digest":"{digest}"}}]}}"#
                ),
            )
            .with(SUBMIT_FFQN, "\"Dep_new\"");
        let out = execute_obelisk(
            &mut i,
            &words(&["deployment", "submit", "/workspace/deployment/dep-1"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        assert!(out.stdout.contains("Dep_new"), "stdout: {}", out.stdout);
        // Preflight: manifest re-pins a.wasm from the bytes, carries no
        // attachments, and takes the deployment id from the directory name.
        let preflight: Value = serde_json::from_str(&host.calls[0].1).unwrap();
        let expected =
            format!("[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"{digest}\"\n");
        assert_eq!(preflight[0], expected);
        assert_eq!(preflight[1], json!([]));
        assert_eq!(preflight[2], "Submitted from workflow-agent VFS");
        assert_eq!(preflight[3], false);
        assert_eq!(preflight[4], "dep-1");
        // Retry: exactly the missing file, read from the VFS, tagged with the
        // digest the server asked for.
        let retry: Value = serde_json::from_str(&host.calls[1].1).unwrap();
        assert_eq!(
            retry[1],
            json!([{"path": "a.wasm", "digest": digest, "content": "bytes"}])
        );
    }

    #[test]
    fn deployment_submit_from_current_sends_empty_deployment_id() {
        let manifest = "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:1\"\n";
        let mut i = interp("/workspace");
        i.fs.write_file(
            "/workspace/deployment/current/deployment.toml",
            manifest.as_bytes(),
        )
        .unwrap();
        let mut host = FakeHost::new().with(SUBMIT_FFQN, "\"Dep_x\"");
        execute_obelisk(
            &mut i,
            &words(&["deployment", "submit", "/workspace/deployment/current"]),
            "",
            &mut host,
        );
        let params: Value = serde_json::from_str(&host.calls[0].1).unwrap();
        assert_eq!(params[4], "");
    }

    #[test]
    fn deployment_submit_options_do_not_shadow_the_path() {
        // Regression: `submit --description wh` used to read `--description` as
        // the deployment directory (`.../current/--description/deployment.toml`).
        let manifest = "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:1\"\n";
        let mut i = interp("/workspace/deployment/current");
        i.fs.write_file(
            "/workspace/deployment/current/deployment.toml",
            manifest.as_bytes(),
        )
        .unwrap();
        let mut host = FakeHost::new().with(SUBMIT_FFQN, "\"Dep_x\"");
        let out = execute_obelisk(
            &mut i,
            &words(&["deployment", "submit", "--description", "wh"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        let params: Value = serde_json::from_str(&host.calls[0].1).unwrap();
        // Description forwarded; PATH defaulted to the cwd (`current`), so the
        // deployment id is empty.
        assert_eq!(params[2], "wh");
        assert_eq!(params[4], "");
    }

    #[test]
    fn deployment_submit_accepts_a_path_to_the_toml_file() {
        let manifest = "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:1\"\n";
        let mut i = interp("/workspace");
        i.fs.write_file(
            "/workspace/deployment/dep-1/deployment.toml",
            manifest.as_bytes(),
        )
        .unwrap();
        let mut host = FakeHost::new().with(SUBMIT_FFQN, "\"Dep_new\"");
        let out = execute_obelisk(
            &mut i,
            &words(&[
                "deployment",
                "submit",
                "/workspace/deployment/dep-1/deployment.toml",
            ]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        // The file's parent directory supplies the deployment id.
        let params: Value = serde_json::from_str(&host.calls[0].1).unwrap();
        assert_eq!(params[4], "dep-1");
    }

    #[test]
    fn deployment_submit_skips_unmodified_lazy_sources() {
        // A freshly mounted deployment holds every owned source as a lazy
        // `pending` entry. A no-op redeploy must send no edited files: the
        // manifest already carries each digest and the blobs are in the CAS. A
        // loader that *would* return bytes is installed so this distinguishes
        // "skipped as unmodified" from "read failed". Regression: the WASM and
        // the `backtrace.sources` (`src/lib.rs`) used to be fetched and sent,
        // and the submit tool rejected the backtrace path it could not match by
        // `location`.
        let manifest = concat!(
            "[[workflow_wasm]]\n",
            "location = \"w.wasm\"\n",
            "content_digest = \"sha256:1\"\n",
            "[workflow_wasm.backtrace.sources]\n",
            "\"w.wasm\" = { path = \"src/lib.rs\", content_digest = \"sha256:2\" }\n",
        );
        let mut i = interp("/workspace");
        i.fs.set_blob_loader(FixtureLoader::rc(&[
            ("sha256:1", b"wasm-bytes"),
            ("sha256:2", b"rust source"),
        ]));
        i.fs.write_file(
            "/workspace/deployment/current/deployment.toml",
            manifest.as_bytes(),
        )
        .unwrap();
        i.fs.register_lazy("/workspace/deployment/current/w.wasm", "sha256:1", 10);
        i.fs.register_lazy("/workspace/deployment/current/src/lib.rs", "sha256:2", 11);

        let mut host = FakeHost::new().with(SUBMIT_FFQN, "\"Dep_x\"");
        let out = execute_obelisk(
            &mut i,
            &words(&["deployment", "submit", "/workspace/deployment/current"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        // Preflight only: unchanged lazy sources keep their CAS digest, so the
        // manifest round-trips unchanged and nothing is attached.
        assert_eq!(host.calls.len(), 1);
        let params: Value = serde_json::from_str(&host.calls[0].1).unwrap();
        assert_eq!(params[0], manifest);
        assert_eq!(params[1], json!([]));
    }

    #[test]
    fn deployment_submit_sends_only_locally_modified_sources() {
        let manifest = concat!(
            "[[workflow_js]]\n",
            "location = \"a.js\"\n",
            "content_digest = \"sha256:a\"\n",
            "[[workflow_js]]\n",
            "location = \"b.js\"\n",
            "content_digest = \"sha256:b\"\n",
        );
        let mut i = interp("/workspace");
        i.fs.set_blob_loader(FixtureLoader::rc(&[
            ("sha256:a", b"old-a"),
            ("sha256:b", b"old-b"),
        ]));
        i.fs.write_file(
            "/workspace/deployment/current/deployment.toml",
            manifest.as_bytes(),
        )
        .unwrap();
        i.fs.register_lazy("/workspace/deployment/current/a.js", "sha256:a", 5);
        i.fs.register_lazy("/workspace/deployment/current/b.js", "sha256:b", 5);
        // Edit a.js only; b.js stays lazy/unmodified and must not be sent.
        i.fs.write_file("/workspace/deployment/current/a.js", b"new-a")
            .unwrap();

        let a_digest = format!("sha256:{}", sha256_hex(b"new-a"));
        let mut host = FakeHost::new()
            .with_err(
                SUBMIT_FFQN,
                &format!(
                    r#"{{"permanent_missing_files":[{{"path":"a.js","digest":"{a_digest}"}}]}}"#
                ),
            )
            .with(SUBMIT_FFQN, "\"Dep_x\"");
        execute_obelisk(
            &mut i,
            &words(&["deployment", "submit", "/workspace/deployment/current"]),
            "",
            &mut host,
        );
        // Preflight sends no blobs; the retry attaches only the edited a.js, never
        // the unchanged lazy b.js.
        assert_eq!(host.calls.len(), 2);
        let preflight: Value = serde_json::from_str(&host.calls[0].1).unwrap();
        assert_eq!(preflight[1], json!([]));
        let retry: Value = serde_json::from_str(&host.calls[1].1).unwrap();
        assert_eq!(
            retry[1],
            json!([{"path": "a.js", "digest": a_digest, "content": "new-a"}])
        );
    }

    #[test]
    fn deployment_submit_pins_digest_for_a_new_activity_with_no_digest_line() {
        // The headline flow: the agent adds a component and its source but never
        // writes a `content_digest` (the mounted manifest has none to copy).
        // Submit must pin the digest itself from the file bytes, not reject.
        let manifest = concat!(
            "[[activity_js]]\n",
            "name = \"program_http\"\n",
            "location = \"activity/http.js\"\n",
        );
        let mut i = interp("/workspace");
        i.fs.write_file(
            "/workspace/deployment/current/deployment.toml",
            manifest.as_bytes(),
        )
        .unwrap();
        i.fs.write_file(
            "/workspace/deployment/current/activity/http.js",
            b"export default 1",
        )
        .unwrap();

        let digest = format!("sha256:{}", sha256_hex(b"export default 1"));
        let mut host = FakeHost::new()
            .with_err(
                SUBMIT_FFQN,
                &format!(r#"{{"permanent_missing_files":[{{"path":"activity/http.js","digest":"{digest}"}}]}}"#),
            )
            .with(SUBMIT_FFQN, "\"Dep_x\"");
        let out = execute_obelisk(
            &mut i,
            &words(&["deployment", "submit", "/workspace/deployment/current"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        let preflight: Value = serde_json::from_str(&host.calls[0].1).unwrap();
        let expected = format!(
            "[[activity_js]]\nname = \"program_http\"\nlocation = \"activity/http.js\"\ncontent_digest = \"{digest}\"\n"
        );
        assert_eq!(preflight[0], expected);
        assert_eq!(preflight[1], json!([]));
        let retry: Value = serde_json::from_str(&host.calls[1].1).unwrap();
        assert_eq!(
            retry[1],
            json!([{"path": "activity/http.js", "digest": digest, "content": "export default 1"}])
        );
    }

    #[test]
    fn simplify_manifest_collapses_all_digest_shapes() {
        let stored = concat!(
            "[[webhook_endpoint]]\n",
            "location = \"webhook/ui-api.js\"\n",
            "content_digest = \"sha256:aa\"\n",
            "component_files = { \"webhook/ui-api.js\" = \"sha256:aa\", \"webhook/ui/shell.js\" = \"sha256:bb\" }\n",
            "[webhook_endpoint.backtrace.sources]\n",
            "\"/abs/src/lib.rs\" = { path = \"src/lib.rs\", content_digest = \"sha256:cc\" }\n",
        );
        let expected = concat!(
            "[[webhook_endpoint]]\n",
            "location = \"webhook/ui-api.js\"\n",
            "component_files = { \"webhook/ui-api.js\" = \"auto\", \"webhook/ui/shell.js\" = \"auto\" }\n",
            "[webhook_endpoint.backtrace.sources]\n",
            "\"/abs/src/lib.rs\" = \"src/lib.rs\"\n",
        );
        assert_eq!(simplify_manifest(stored), expected);
    }

    #[test]
    fn manifest_with_digests_expands_component_files_and_backtrace() {
        // The inverse of `simplify_manifest`: the agent's digest-free view plus the
        // file bytes rebuilds every content_digest, component_files value, and
        // backtrace inline table. Regression for the `component_files` blind spot
        // that failed E_01M09ZWQ915HF6H60D3XFMTQWB.
        let collapsed = concat!(
            "[[webhook_endpoint]]\n",
            "location = \"webhook/ui-api.js\"\n",
            "component_files = { \"webhook/ui-api.js\" = \"auto\", \"webhook/ui/shell.js\" = \"auto\" }\n",
            "[webhook_endpoint.backtrace.sources]\n",
            "\"/abs/src/lib.rs\" = \"src/lib.rs\"\n",
        );
        let mut i = interp("/workspace");
        let dir = "/workspace/deployment/current";
        i.fs.write_file(&format!("{dir}/webhook/ui-api.js"), b"api")
            .unwrap();
        i.fs.write_file(&format!("{dir}/webhook/ui/shell.js"), b"shell")
            .unwrap();
        i.fs.write_file(&format!("{dir}/src/lib.rs"), b"rs")
            .unwrap();
        let api = format!("sha256:{}", sha256_hex(b"api"));
        let shell = format!("sha256:{}", sha256_hex(b"shell"));
        let rs = format!("sha256:{}", sha256_hex(b"rs"));
        // toml_edit appends the re-pinned `content_digest` at the end of the
        // component table (after `component_files`); order is cosmetic.
        let expected = format!(
            concat!(
                "[[webhook_endpoint]]\n",
                "location = \"webhook/ui-api.js\"\n",
                "component_files = {{ \"webhook/ui-api.js\" = \"{api}\", \"webhook/ui/shell.js\" = \"{shell}\" }}\n",
                "content_digest = \"{api}\"\n",
                "[webhook_endpoint.backtrace.sources]\n",
                "\"/abs/src/lib.rs\" = {{ path = \"src/lib.rs\", content_digest = \"{rs}\" }}\n",
            ),
            api = api,
            shell = shell,
            rs = rs,
        );
        assert_eq!(manifest_with_digests(&i.fs, dir, collapsed), expected);
    }

    #[test]
    fn deployment_submit_uploads_an_edited_component_file() {
        // The exact bug: a `component_files` source edited in the VFS must be
        // collected, re-hashed, and attached when the server reports it missing.
        let collapsed = concat!(
            "[[webhook_endpoint]]\n",
            "name = \"ui\"\n",
            "location = \"webhook/ui-api.js\"\n",
            "component_files = { \"webhook/ui-api.js\" = \"auto\", \"webhook/ui/shell.js\" = \"auto\" }\n",
        );
        let mut i = interp("/workspace");
        let dir = "/workspace/deployment/current";
        i.fs.write_file(&format!("{dir}/deployment.toml"), collapsed.as_bytes())
            .unwrap();
        i.fs.write_file(&format!("{dir}/webhook/ui-api.js"), b"api")
            .unwrap();
        i.fs.write_file(&format!("{dir}/webhook/ui/shell.js"), b"shell")
            .unwrap();
        let shell = format!("sha256:{}", sha256_hex(b"shell"));
        let mut host = FakeHost::new()
            .with_err(
                SUBMIT_FFQN,
                &format!(
                    r#"{{"permanent_missing_files":[{{"path":"webhook/ui/shell.js","digest":"{shell}"}}]}}"#
                ),
            )
            .with(SUBMIT_FFQN, "\"Dep_x\"");
        let out = execute_obelisk(
            &mut i,
            &words(&["deployment", "submit", "/workspace/deployment/current"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        let retry: Value = serde_json::from_str(&host.calls[1].1).unwrap();
        assert_eq!(
            retry[1],
            json!([{"path": "webhook/ui/shell.js", "digest": shell, "content": "shell"}])
        );
    }

    #[test]
    fn deployment_submit_propagates_a_terminal_error() {
        // A permanent/transient tool-error (not the missing-files arm) is not
        // recoverable: it surfaces to the agent and stops the loop.
        let manifest = "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:1\"\n";
        let mut i = interp("/workspace");
        i.fs.write_file(
            "/workspace/deployment/current/deployment.toml",
            manifest.as_bytes(),
        )
        .unwrap();
        let mut host = FakeHost::new().with_err(
            SUBMIT_FFQN,
            "deployment cannot be submitted: unexpected files: x",
        );
        let out = execute_obelisk(
            &mut i,
            &words(&["deployment", "submit", "/workspace/deployment/current"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 2);
        assert!(
            out.stderr.contains("unexpected files"),
            "stderr: {}",
            out.stderr
        );
        assert_eq!(host.calls.len(), 1);
    }

    #[test]
    fn deployment_submit_errors_when_a_blob_stays_missing_after_attaching() {
        // If the server keeps reporting the same file after it was attached (a
        // digest mismatch it cannot fix by resending), the loop stops instead of
        // spinning forever.
        let manifest = "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:1\"\n";
        let mut i = interp("/workspace");
        i.fs.write_file(
            "/workspace/deployment/current/deployment.toml",
            manifest.as_bytes(),
        )
        .unwrap();
        i.fs.write_file("/workspace/deployment/current/a.wasm", b"bytes")
            .unwrap();
        let missing = r#"{"permanent_missing_files":[{"path":"a.wasm","digest":"sha256:zz"}]}"#;
        let mut host = FakeHost::new()
            .with_err(SUBMIT_FFQN, missing)
            .with_err(SUBMIT_FFQN, missing);
        let out = execute_obelisk(
            &mut i,
            &words(&["deployment", "submit", "/workspace/deployment/current"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 2);
        assert!(
            out.stderr.contains("still missing"),
            "stderr: {}",
            out.stderr
        );
        assert_eq!(host.calls.len(), 2);
    }

    // -- wiring: registered via `Bash::register_command`, dispatched through
    // the ordinary shell (proves the custom-command mechanism itself works,
    // not just the pack's internal functions) --

    #[test]
    fn registered_as_a_bash_custom_command() {
        let host = FakeHost::new().with("obelisk-agent:tools/webapi.list-functions", "[]");
        let mut bash = Bash::new(BashOptions {
            cwd: "/workspace".into(),
            ..Default::default()
        });
        bash.register_command("obelisk", command_handler(Box::new(host)));
        let out = bash.exec("obelisk functions list | cat", Default::default());
        assert_eq!(out.exit_code, 0);
        assert_eq!(out.stdout, "");
    }

    #[test]
    fn deployment_mount_is_deferred_until_the_tree_is_accessed() {
        let manifest = "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:1\"\n";
        let host = FakeHost::new()
            .with(
                "obelisk-agent:tools/webapi.current-deployment-id",
                "\"dep-1\"",
            )
            .with(
                "obelisk-agent:tools/webapi.deployment-checkout",
                &json!({
                    "deployment_toml": manifest,
                    "files": [{"path": "a.wasm", "digest": "sha256:1", "size": 12}]
                })
                .to_string(),
            );
        let mut bash = Bash::new(BashOptions {
            cwd: "/workspace".into(),
            ..Default::default()
        });
        register_deferred_mount(bash.fs_mut(), Box::new(host));

        // A session that never references the deployment never checks it out:
        // the manifest is absent until first access.
        let out = bash.exec("echo hi; ls /workspace", Default::default());
        assert_eq!(out.exit_code, 0);
        assert!(
            !bash
                .fs_mut()
                .exists("/workspace/deployment/current/deployment.toml")
        );

        // The first command that references the deployment path fires the
        // checkout and materializes the tree.
        let out = bash.exec(
            "cat /workspace/deployment/current/deployment.toml",
            Default::default(),
        );
        assert_eq!(out.exit_code, 0, "{}", out.stderr);
        assert_eq!(out.stdout, simplify_manifest(manifest));
        assert!(bash.fs_mut().is_dir("/workspace/deployment/current"));
    }

    #[test]
    fn unregistered_command_still_falls_through_to_command_not_found() {
        let mut bash = Bash::new(BashOptions::default());
        let out = bash.exec("obelisk functions list", Default::default());
        assert_eq!(out.exit_code, 127);
        assert!(out.stderr.contains("command not found"));
    }
}
