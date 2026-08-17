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
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Value, json};

use crate::commands::{normalize_path, sha256_hex};
use crate::custom_command::CustomCommandHandler;
use crate::fs::{BlobLoader, FsError, Vfs};
use crate::interpreter::{CommandOutput, Interpreter};

const READ_BLOB_FFQN: &str = "obelisk-agent:tools/webapi.deployment-read-blob";

const DEPLOYMENT_ROOT: &str = "/workspace/deployment";

/// PORT: `packs/obelisk-control/workflow-pack.js`'s `descriptor.systemPrompt`.
/// Appended to the session system prompt by the workflow (`session.rs`).
pub const SYSTEM_PROMPT: &str =
    "You are on a persistent virtual machine with a filesystem rooted at
/workspace. The active Obelisk deployment has been fetched into
/workspace/deployment/current; read and edit its deployment.toml and component
sources with ordinary shell commands. Use the obelisk command for operations
against the running server (functions, executions, call, and deployment
current/refresh/check/submit/switch/apply). Edits under the deployment folder
are local until you run `obelisk deployment submit` (store a new inactive
deployment) or `obelisk deployment apply` (hot-redeploy); `obelisk deployment
refresh` discards local edits and re-fetches the current deployment. Do not set
or maintain `content_digest` in deployment.toml: submit computes each digest
from the file bytes for you. Add a component by writing its source and its
[[activity_js]]/[[workflow_js]] table (name, location, params, return_type),
nothing more.";

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
    // The agent edits and re-submits this manifest by hand, so hide the pinned
    // `content_digest` lines it never needs to maintain: `deployment submit`
    // recomputes each digest from the file's current bytes.
    let manifest_path = format!("{dir}/deployment.toml");
    if replace || !fs.exists(&manifest_path) {
        fs.write_file(&manifest_path, strip_owned_digests(&manifest).as_bytes())
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

    if group.is_empty() {
        return Ok(ok(help()));
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
            return target_call(
                host,
                json!([ffqn, Value::Array(params).to_string()]),
            );
        }
        if rest.len() > 1 {
            return Err("call: expected one params JSON array, or `--` followed by positional parameters".to_string());
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
    if group == "deployment" {
        return execute_deployment(interp, action, rest, host);
    }
    Ok(fail(format!(
        "obelisk: unknown command '{}'\n{}",
        args.join(" "),
        help()
    )))
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
            let refreshed = refresh_deployment_mount(&mut interp.fs, host, true)?;
            Ok(ok(format!("{}\n", mount_result_json(&refreshed))))
        }
        "check" => {
            let dir = resolve_deployment_dir(interp, args.first().map(String::as_str));
            let manifest = read_manifest(&interp.fs, &dir)?;
            let sources = deployment_sources(&interp.fs, &dir, &manifest);
            let payload = json!({
                "directory": dir,
                "manifest_bytes": manifest.len(),
                "owned_sources": sources.iter().map(|s| s.path.clone()).collect::<Vec<_>>(),
            });
            Ok(ok(format!(
                "{}\n",
                serde_json::to_string_pretty(&payload).expect("json")
            )))
        }
        "submit" => {
            let dir = resolve_deployment_dir(interp, args.first().map(String::as_str));
            let manifest = read_manifest(&interp.fs, &dir)?;
            let sources = deployment_sources(&interp.fs, &dir, &manifest);
            let sources = sources
                .iter()
                .map(|s| json!({"path": s.path, "content": s.content}))
                .collect::<Vec<_>>();
            // The server pins a `content_digest` for every owned source, so put
            // them back (stripped from the mounted copy the agent edits): each
            // unchanged file keeps its CAS digest, each changed one is re-hashed.
            let manifest = manifest_with_digests(&interp.fs, &dir, &manifest);
            let deployment_id = if basename(&dir) == "current" {
                String::new()
            } else {
                basename(&dir)
            };
            json_call(
                host,
                "obelisk-agent:tools/webapi.deployment-submit",
                json!([
                    manifest,
                    sources,
                    option(args, "--description", "Submitted from workflow-agent VFS"),
                    flag(args, "--allow-missing-runtime-config"),
                    deployment_id,
                ]),
            )
        }
        "switch" => json_call(
            host,
            "obelisk-agent:tools/webapi.deployment-switch",
            json!([
                required(args.first().map(String::as_str), "deployment id")?,
                flag(args, "--allow-missing-runtime-config"),
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

/// Every deployment-owned source location the submit pipeline tracks: `location`
/// keys in the top-level component tables (`top_level_source_locations`) plus
/// `path` keys in each `backtrace.sources` entry (`backtrace_source_locations`),
/// which the component scanner does not see because they live in a nested table.
/// Digests are deliberately not read here: the mounted manifest has them
/// stripped, and `deployment submit` recomputes each from the file's current
/// bytes. `oci://` refs are skipped; deduplicated on location, first wins.
fn owned_source_locations(toml: &str) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    top_level_source_locations(toml)
        .into_iter()
        .chain(backtrace_source_locations(toml))
        .filter(|loc| seen.insert(loc.clone()))
        .collect()
}

/// The `path` entries the top-level scanner misses, under a
/// `[<section>.backtrace.sources]` header or an inline `backtrace.sources =
/// { ... }`. Obelisk stores each as an inline table `{ path = "<loc>",
/// content_digest = "sha256:..." }` (see `obelisk/src/config/manifest.rs`); we
/// read the `path` from every `{ ... }` chunk in a backtrace region.
fn backtrace_source_locations(toml: &str) -> Vec<String> {
    static ENTRY: OnceLock<Regex> = OnceLock::new();
    static PATH: OnceLock<Regex> = OnceLock::new();
    let entry = ENTRY.get_or_init(|| Regex::new(r"\{[^{}]*\}").unwrap());
    let path = PATH.get_or_init(|| Regex::new(r#"\bpath\s*=\s*"([^"]+)""#).unwrap());

    let mut locations = Vec::new();
    let mut in_table = false;
    for line in toml.split('\n') {
        let text = line.trim();
        if text.starts_with('[') {
            // A `[section.backtrace.sources]` header opens a region; any other
            // table header (including `[[...]]`) closes it.
            in_table = text.ends_with(".backtrace.sources]");
            continue;
        }
        if !in_table && !text.contains("backtrace.sources") {
            continue;
        }
        for chunk in entry.find_iter(line) {
            let Some(loc) = path.captures(chunk.as_str()) else {
                continue;
            };
            let location = loc[1].to_string();
            if location.starts_with("oci://") {
                continue;
            }
            locations.push(location);
        }
    }
    locations
}

/// A tiny hand-rolled TOML scanner, line-based and deliberately minimal (not a
/// real TOML parser - see the design doc): the `location` keys inside the
/// manifest's top-level `[[...]]` array-of-tables (`[[activity_wasm]]`-style),
/// skipping any `oci://`-located entry (not a locally-owned source file).
fn top_level_source_locations(toml: &str) -> Vec<String> {
    let mut locations = Vec::new();
    let mut in_main = false;
    for line in toml.split('\n') {
        let text = line.trim();
        if text.starts_with("[[") && !text.contains('.') {
            in_main = true;
            continue;
        }
        if text.starts_with('[') {
            in_main = false;
            continue;
        }
        if !in_main {
            continue;
        }
        if let Some(location) = toml_value(text, "location")
            && !location.starts_with("oci://")
        {
            locations.push(location);
        }
    }
    locations
}

/// Drop the pinned `content_digest = "..."` lines from a manifest. These are the
/// standalone digest lines in top-level component tables; the inline digests in
/// `backtrace.sources` tables sit on `{ ... }` lines and are left intact.
fn strip_owned_digests(manifest: &str) -> String {
    let mut out = String::with_capacity(manifest.len());
    for line in manifest.split_inclusive('\n') {
        if toml_value(line.trim(), "content_digest").is_some() {
            continue;
        }
        out.push_str(line);
    }
    out
}

/// Rebuild the manifest the server expects from the digest-stripped copy the
/// agent edits: re-emit a `content_digest` line after each top-level `location`.
/// An unchanged (still-lazy) file keeps its CAS digest; a changed one is
/// re-hashed from the exact bytes `deployment_sources` uploads.
fn manifest_with_digests(fs: &Vfs, dir: &str, manifest: &str) -> String {
    let stripped = strip_owned_digests(manifest);
    let mut out = String::with_capacity(stripped.len() + 128);
    let mut in_main = false;
    for line in stripped.split_inclusive('\n') {
        let text = line.trim();
        if text.starts_with("[[") && !text.contains('.') {
            in_main = true;
        } else if text.starts_with('[') {
            in_main = false;
        }
        out.push_str(line);
        if in_main
            && let Some(location) = toml_value(text, "location")
            && !location.starts_with("oci://")
            && let Some(digest) = owned_source_digest(fs, &format!("{dir}/{location}"))
        {
            if !line.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&format!("content_digest = \"{digest}\"\n"));
        }
    }
    out
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

fn toml_value(line: &str, key: &str) -> Option<String> {
    if !line.starts_with(key) {
        return None;
    }
    let separator = line.find('=')?;
    let value = line[separator + 1..].trim();
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        Some(value[1..value.len() - 1].to_string())
    } else {
        None
    }
}

struct SourceEntry {
    path: String,
    content: String,
}

/// The deployment-owned source files a submit must carry: only those the
/// session modified locally. An unmodified file stays a lazy `pending` VFS entry
/// whose blob is already in the CAS, so `manifest_with_digests` re-pins its
/// existing digest without the agent reading or re-uploading it (the same
/// "upload only what the server is missing" contract the real `obelisk
/// deployment submit` follows). Skipping unmodified files keeps a redeploy from
/// fetching every component back out of the CAS just to hand it straight back -
/// notably the multi-MB workflow and activity WASM (which lossy-decoded to a
/// string and re-hashed would carry a wrong digest).
fn deployment_sources(fs: &Vfs, dir: &str, manifest: &str) -> Vec<SourceEntry> {
    let mut files = Vec::new();
    for location in owned_source_locations(manifest) {
        let path = format!("{dir}/{location}");
        // A local write clears the pending flag; a mere read does not. So a file
        // still pending is unmodified and already in the CAS - skip it.
        if fs.is_pending(&path) {
            continue;
        }
        if let Some(bytes) = fs.read_file(&path) {
            files.push(SourceEntry {
                path: location,
                content: String::from_utf8_lossy(&bytes).into_owned(),
            });
        }
    }
    files
}

fn resolve_deployment_dir(interp: &Interpreter, value: Option<&str>) -> String {
    let value = value.filter(|s| !s.is_empty()).unwrap_or(".");
    normalize_path(&interp.cwd, value)
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

fn help() -> String {
    "Usage: obelisk <command>\n\
\n\
Commands:\n\
  functions list [--prefix PREFIX] [--length N] [--json]\n\
  functions wit FFQN\n\
  executions list [--ffqn-prefix PREFIX] [--length N]\n\
  executions get ID\n\
  executions logs ID [--length N]\n\
  executions result ID\n\
  call FFQN [PARAMS_JSON | -- PARAM...]\n\
  deployment current\n\
  deployment refresh\n\
  deployment check [DIRECTORY]\n\
  deployment submit [DIRECTORY] [--description TEXT]\n\
  deployment switch ID\n\
  deployment apply ID\n"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bash::Bash;
    use crate::custom_command::CustomCommands;
    use crate::types::BashOptions;
    use std::collections::BTreeMap;

    /// A fake host backed by an in-memory ffqn -> canned-JSON-response map,
    /// for tests only. A call to an ffqn with no fixture errors, mirroring a
    /// call to something nothing implements. Records every call so tests can
    /// assert on the exact params sent.
    struct FakeHost {
        responses: BTreeMap<String, String>,
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
                .insert(ffqn.to_string(), response_json.to_string());
            self
        }
    }

    impl ObeliskHost for FakeHost {
        fn call_json(&mut self, ffqn: &str, params_json: &str) -> Result<Option<String>, String> {
            self.calls.push((ffqn.to_string(), params_json.to_string()));
            self.responses
                .get(ffqn)
                .cloned()
                .map(Some)
                .ok_or_else(|| format!("no fixture for {ffqn}"))
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
    fn help_aliases_are_not_commands() {
        let mut host = FakeHost::new();
        let mut i = interp("/workspace");
        for case in [words(&["--help"]), words(&["help"])] {
            let out = execute_obelisk(&mut i, &case, "", &mut host);
            assert_eq!(out.exit_code, 2);
            assert!(out.stderr.contains("unknown command"));
        }
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
        let mut host = FakeHost::new().with(
            "obelisk-control:tools/native.call",
            r#""{\"answer\":42}""#,
        );
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["call", "some:ffqn", "[]"]), "", &mut host);
        assert_eq!(out.stdout, "{\n  \"answer\": 42\n}\n");

        let mut host = FakeHost::new().with(
            "obelisk-control:tools/native.call",
            r#""\"plain result\"""#,
        );
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
    fn host_error_propagates_with_obelisk_prefix() {
        let mut host = FakeHost::new(); // no fixtures registered
        let mut i = interp("/workspace");
        let out = execute_obelisk(&mut i, &words(&["functions", "list"]), "", &mut host);
        assert_eq!(out.exit_code, 2);
        assert!(out.stderr.starts_with("obelisk: no fixture for"));
    }

    // -- the TOML scanner --

    #[test]
    fn top_level_source_locations_scans_tables_and_skips_oci_and_nested() {
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
        assert_eq!(top_level_source_locations(toml), vec!["a.wasm".to_string()]);
    }

    #[test]
    fn backtrace_source_locations_read_nested_table_and_inline_forms() {
        // Nested-table form (obelisk's stored shape) with two entries.
        let table = "[[workflow_wasm]]\n\
name = \"wf\"\n\
location = \"w.wasm\"\n\
content_digest = \"sha256:9\"\n\
\n\
[workflow_wasm.backtrace.sources]\n\
\".../src/lib.rs\" = { path = \"src/lib.rs\", content_digest = \"sha256:1\" }\n\
\".../src/util.rs\" = { path = \"src/util.rs\", content_digest = \"sha256:2\" }\n";
        assert_eq!(
            backtrace_source_locations(table),
            vec!["src/lib.rs".to_string(), "src/util.rs".to_string()]
        );
        // The wasm location plus both backtrace sources, deduped.
        assert_eq!(owned_source_locations(table).len(), 3);

        // Inline form within the `[[workflow_wasm]]` table (nested inline table).
        let inline = "[[workflow_wasm]]\n\
name = \"wf\"\n\
location = \"w.wasm\"\n\
content_digest = \"sha256:9\"\n\
backtrace.sources = { \".../src/lib.rs\" = { path = \"src/lib.rs\", content_digest = \"sha256:1\" } }\n";
        assert_eq!(
            backtrace_source_locations(inline),
            vec!["src/lib.rs".to_string()]
        );
    }

    #[test]
    fn strip_owned_digests_drops_standalone_lines_keeps_backtrace_inline() {
        let toml = "[[activity_wasm]]\n\
location = \"a.wasm\"\n\
content_digest = \"sha256:1\"\n\
\n\
[workflow_wasm.backtrace.sources]\n\
\".../src/lib.rs\" = { path = \"src/lib.rs\", content_digest = \"sha256:2\" }\n";
        let stripped = strip_owned_digests(toml);
        assert!(!stripped.contains("content_digest = \"sha256:1\""));
        // Inline backtrace digest is on a `{ ... }` line and survives.
        assert!(stripped.contains("path = \"src/lib.rs\", content_digest = \"sha256:2\""));
        assert!(stripped.contains("location = \"a.wasm\""));
    }

    #[test]
    fn toml_value_matches_a_quoted_string_value() {
        assert_eq!(
            toml_value("location = \"a.wasm\"", "location"),
            Some("a.wasm".to_string())
        );
        assert_eq!(toml_value("other = \"a.wasm\"", "location"), None);
        // Not a real TOML parser (matches upstream's own minimal scanner): a
        // non-string value or a missing `=` simply isn't recognized.
        assert_eq!(toml_value("location = 5", "location"), None);
        assert_eq!(toml_value("location", "location"), None);
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
        // The mounted manifest has the pinned `content_digest` stripped so the
        // agent never has to maintain it.
        assert_eq!(
            fs.read_file("/workspace/deployment/current/deployment.toml")
                .as_deref(),
            Some(strip_owned_digests(manifest).as_bytes())
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
    fn deployment_submit_sends_manifest_sources_and_id_from_dirname() {
        let manifest = "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:1\"\n";
        let mut i = interp("/workspace");
        i.fs.write_file(
            "/workspace/deployment/dep-1/deployment.toml",
            manifest.as_bytes(),
        )
        .unwrap();
        i.fs.write_file("/workspace/deployment/dep-1/a.wasm", b"bytes")
            .unwrap();
        let mut host =
            FakeHost::new().with("obelisk-agent:tools/webapi.deployment-submit", "\"ok\"");
        let out = execute_obelisk(
            &mut i,
            &words(&["deployment", "submit", "/workspace/deployment/dep-1"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        let params: Value = serde_json::from_str(&host.calls[0].1).unwrap();
        // a.wasm is a plain (non-lazy) local file, so submit re-pins its digest
        // from the bytes it uploads rather than trusting the stale manifest.
        let expected = format!(
            "[[activity_wasm]]\nlocation = \"a.wasm\"\ncontent_digest = \"sha256:{}\"\n",
            sha256_hex(b"bytes")
        );
        assert_eq!(params[0], expected);
        assert_eq!(params[1], json!([{"path": "a.wasm", "content": "bytes"}]));
        assert_eq!(params[2], "Submitted from workflow-agent VFS");
        assert_eq!(params[3], false);
        assert_eq!(params[4], "dep-1");
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
        let mut host =
            FakeHost::new().with("obelisk-agent:tools/webapi.deployment-submit", "\"ok\"");
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

        let mut host =
            FakeHost::new().with("obelisk-agent:tools/webapi.deployment-submit", "\"ok\"");
        let out = execute_obelisk(
            &mut i,
            &words(&["deployment", "submit", "/workspace/deployment/current"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
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

        let mut host =
            FakeHost::new().with("obelisk-agent:tools/webapi.deployment-submit", "\"ok\"");
        execute_obelisk(
            &mut i,
            &words(&["deployment", "submit", "/workspace/deployment/current"]),
            "",
            &mut host,
        );
        let params: Value = serde_json::from_str(&host.calls[0].1).unwrap();
        assert_eq!(params[1], json!([{"path": "a.js", "content": "new-a"}]));
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

        let mut host =
            FakeHost::new().with("obelisk-agent:tools/webapi.deployment-submit", "\"ok\"");
        let out = execute_obelisk(
            &mut i,
            &words(&["deployment", "submit", "/workspace/deployment/current"]),
            "",
            &mut host,
        );
        assert_eq!(out.exit_code, 0, "stderr: {}", out.stderr);
        let params: Value = serde_json::from_str(&host.calls[0].1).unwrap();
        let expected = format!(
            "[[activity_js]]\nname = \"program_http\"\nlocation = \"activity/http.js\"\ncontent_digest = \"sha256:{}\"\n",
            sha256_hex(b"export default 1")
        );
        assert_eq!(params[0], expected);
        assert_eq!(
            params[1],
            json!([{"path": "activity/http.js", "content": "export default 1"}])
        );
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
    fn unregistered_command_still_falls_through_to_command_not_found() {
        let mut bash = Bash::new(BashOptions::default());
        let out = bash.exec("obelisk functions list", Default::default());
        assert_eq!(out.exit_code, 127);
        assert!(out.stderr.contains("command not found"));
    }
}
