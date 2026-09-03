// PORT: vendor/just-bash-rs/src/obelisk_pack.rs
//
// The obelisk-control pack: one custom command, `obelisk`, whose subcommands
// (`functions`, `executions`, `call`, `deployment`) all bottom out in a
// single primitive - calling a deployed Obelisk FFQN and getting back its
// JSON result - via the `host.callJson` seam below. Everything under
// packs/obelisk-control/tools/*.js and packs/obelisk-control/github/*.js
// stays a separately-deployed JS activity/workflow reached *through* one of
// these FFQN calls (e.g. `obelisk-agent:tools/webapi.list-functions`); this
// module only ports the shell-command dispatcher that runs inside the
// session's own bash, not those targets, so it never needs to know how they
// are implemented.
//
// `host` is duck-typed as `{ callJson(ffqn, paramsJson) -> string|null }`
// (throws a string, or an Error, on failure), matching workflow-rs's
// `ObeliskHost` trait so this module is host-implementation-agnostic and
// testable with a plain fake object (see obelisk-pack.test.js) - the real
// implementation lives in workflow/workflow-js/src/host.js, never imported
// here. `paramsJson` is a JSON-encoded array (a string, matching Rust's
// `params_json: &str`); the return value is the JSON *text* of the decoded
// result (quoted for a string result, `null` for a void result), mirroring
// the `obelisk:workflow/workflow-support.call-json` WIT host import exactly.
// `obelisk-control:tools/native.call` needs no special-casing: it is called
// through this exact same seam like any other ffqn (see `targetCall`).
//
// Custom-command handlers receive the full argv including argv[0] (see
// interpreter.js's `invoke`), unlike workflow-rs's `CustomCommandHandler`
// (argv[0] already stripped) - `commandHandler`'s `args.slice(1)` accounts
// for that, same as obelisk-program.js.

import { sha256Hex } from "./commands/hash.js";
import { utf8Encode } from "./utf8.js";
import { DEPLOYMENT_TEMPLATE } from "./obelisk-deployment-template.js";
import { isCasNamespacedDigest } from "./fs.js";

const READ_BLOB_FFQN = "obelisk-agent:tools/webapi.deployment-read-blob";
const SUBMIT_FFQN = "obelisk-agent:tools/webapi.deployment-submit";

const DEPLOYMENT_ROOT = "/workspace/deployment";

// The placeholder value the agent sees in `component_files` maps in place of
// a pinned digest; `deployment submit` replaces each with the file's real
// digest.
const AUTO_DIGEST = "auto";

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

// Build the `obelisk` custom-command handler. Register it with
// `commands.set("obelisk", obelisk.commandHandler(host))`. The handler owns
// `host` for the life of the session (a plain closure capture, not an
// Rc<RefCell<_>> as in the Rust port, since JS closures already close over a
// shared mutable reference).
export function commandHandler(host) {
    return (interp, args, stdin) => executeObelisk(interp, args.slice(1), stdin, host);
}

// ---------------------------------------------------------------------------
// Deployment mounting
// ---------------------------------------------------------------------------

// Check out the active deployment's `deployment.toml` plus the metadata
// index of its owned source files into `/workspace/deployment/<id>/`, then
// symlink `/workspace/deployment/current` to it. Only the manifest is
// fetched here; each owned source (component scripts/wasm and
// `backtrace.sources`) is registered as a lazy VFS entry (fs.js's
// `registerLazy`), fetched from the CAS on first read, so mounting costs two
// host calls regardless of how many files the deployment owns.
//
// Called once at session mount (`replace = false`, via `mount`) and again by
// `obelisk deployment refresh` (`replace = true`, re-registering every file
// so a locally-read/edited copy is dropped for the current digest; the
// initial mount instead leaves an already-present file alone).
export function refreshDeploymentMount(fs, host, replace) {
    const current = callValue(host, "obelisk-agent:tools/webapi.current-deployment-id", "[]");
    const deploymentId = decodeString(current);
    if (deploymentId === "") return { deploymentId: null, files: 0 };

    const checkout = decodeJson(
        callValue(host, "obelisk-agent:tools/webapi.deployment-checkout", JSON.stringify([deploymentId])),
    );
    const manifest = checkout && typeof checkout === "object" ? checkout.deployment_toml : undefined;
    if (typeof manifest !== "string") throw "deployment checkout returned no deployment_toml";
    const indexedFiles = checkoutFileRefs(checkout);

    const dir = `${DEPLOYMENT_ROOT}/${deploymentId}`;
    fs.mkdirp(dir);
    // The agent edits and re-submits this manifest by hand, so hide every
    // pinned digest it never needs to maintain (standalone `content_digest`,
    // `component_files` values, `backtrace.sources` tables): `deployment
    // submit` recomputes each from the file's current bytes.
    const manifestPath = `${dir}/deployment.toml`;
    if (replace || !fs.exists(manifestPath)) {
        fs.writeFile(manifestPath, simplifyManifest(manifest));
    }

    let files = 1;
    for (const reference of indexedFiles) {
        const path = `${dir}/${reference.path}`;
        if (!replace && fs.exists(path)) continue;
        fs.registerLazy(path, reference.digest, reference.size);
        files += 1;
    }

    const currentPath = `${DEPLOYMENT_ROOT}/current`;
    if (fs.exists(currentPath)) fs.remove(currentPath, { recursive: true });
    fs.symlink(dir, currentPath);
    return { deploymentId, files };
}

// Convenience entry point for session mount: `refreshDeploymentMount` with
// `replace = false`.
export function mount(fs, host) {
    return refreshDeploymentMount(fs, host, false);
}

// Register the deployment tree as a deferred mount instead of fetching it at
// session start: the checkout (`current-deployment-id` + `deployment-
// checkout`) runs only when the session first references a path under
// `/workspace/deployment`, so a bash-only session never touches the target.
// A failed mount records the reason in `/workspace/.mount-error`, matching
// the old eager path.
export function registerDeferredMount(fs, host) {
    fs.registerDeferredMount(DEPLOYMENT_ROOT, (vfs) => {
        try {
            refreshDeploymentMount(vfs, host, false);
        } catch (error) {
            const message = typeof error === "string" ? error : String(error?.message ?? error);
            try {
                vfs.writeFile("/workspace/.mount-error", message);
            } catch {
                /* best-effort; nothing else to report to */
            }
        }
    });
}

// The `Vfs` blob loader for a mounted session: fetch a deployment file's
// bytes by content digest via `deployment-read-blob`, decoding the same way
// the old eager mount did (`callValue` peels `callJson`'s JSON layer,
// `coerceText` takes the verbatim string body). Install with
// `fs.setBlobLoader(obelisk.blobLoader(host))`.
export function blobLoader(host) {
    return (digest) => coerceText(callValue(host, READ_BLOB_FFQN, JSON.stringify([digest])));
}

function checkoutFileRefs(checkout) {
    const files = checkout && typeof checkout === "object" ? checkout.files : undefined;
    if (!Array.isArray(files)) throw "deployment checkout returned no files index";
    return files.map((file) => {
        const path = file?.path;
        if (typeof path !== "string") throw "deployment checkout file has no path";
        const digest = file?.digest;
        if (typeof digest !== "string") throw `deployment checkout file ${path} has no digest`;
        const size = file?.size;
        if (typeof size !== "number" || !Number.isFinite(size)) throw `deployment checkout file ${path} has no size`;
        return { path, digest, size };
    });
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

// Directly callable by tests, mirroring the Rust test module's
// `execute_obelisk(&mut interp, &words(...), stdin, &mut host)` - `args`
// here does NOT include the command name itself (see `commandHandler`).
export function executeObelisk(interp, args, stdin, host) {
    try {
        return tryExecuteObelisk(interp, args, stdin, host);
    } catch (message) {
        return fail(`obelisk: ${typeof message === "string" ? message : String(message?.message ?? message)}\n`);
    }
}

function tryExecuteObelisk(interp, args, stdin, host) {
    const group = args[0] ?? "";
    const action = args[1] ?? "";
    const rest = args.length > 2 ? args.slice(2) : [];

    if (group === "" || isHelpFlag(group)) return ok(helpText);
    // `-h`/`--help` at any level prints the matching usage and exits 0: as
    // the action (`obelisk deployment -h`) it is the group help, further
    // right (`obelisk deployment submit -h`) the subcommand help. For
    // `call`, only a help flag before `--` is help; after it, it is a
    // positional parameter.
    if (isHelpFlag(action)) return ok(groupHelp(group));
    const sepIdx = rest.indexOf("--");
    const helpScan = group === "call" ? rest.slice(0, sepIdx === -1 ? rest.length : sepIdx) : rest;
    if (helpRequested(helpScan)) return ok(actionHelp(group, action));

    if (group === "functions" && action === "list") {
        const params = [option(rest, "--prefix", ""), integerOption(rest, "--length", 100)];
        if (flag(rest, "--json")) return jsonCall(host, "obelisk-agent:tools/webapi.list-functions", params);
        return listFunctions(host, params);
    }
    if (group === "functions" && action === "wit") {
        return jsonCall(host, "obelisk-agent:tools/webapi.get-function-wit", [required(rest[0], "ffqn")]);
    }
    if (group === "executions" && action === "list") {
        return jsonCall(host, "obelisk-agent:tools/webapi.list-executions", [
            option(rest, "--ffqn-prefix", ""),
            option(rest, "--id-prefix", ""),
            flag(rest, "--show-derived"),
            flag(rest, "--hide-finished"),
            "",
            "",
            "",
            "",
            false,
            integerOption(rest, "--length", 20),
        ]);
    }
    if (group === "executions" && action === "get") {
        return jsonCall(host, "obelisk-agent:tools/webapi.get-execution", [required(rest[0], "execution id")]);
    }
    if (group === "executions" && action === "logs") {
        return jsonCall(host, "obelisk-agent:tools/webapi.get-logs", [
            required(rest[0], "execution id"),
            true,
            true,
            true,
            [],
            [],
            "",
            "",
            false,
            integerOption(rest, "--length", 200),
        ]);
    }
    if (group === "executions" && action === "result") {
        return jsonCall(host, "obelisk-agent:tools/webapi.get-result-json", [required(rest[0], "execution id")]);
    }
    if (group === "call") {
        const ffqn = required(action, "ffqn");
        if (rest[0] === "--") {
            const params = rest.slice(1).map((argument) => {
                try {
                    return JSON.parse(argument);
                } catch {
                    return argument;
                }
            });
            return targetCall(host, [ffqn, JSON.stringify(params)]);
        }
        if (rest.length > 1) {
            throw "call: expected one params JSON array, or `--` followed by positional parameters";
        }
        // A params-json positional that is present but empty is almost
        // always a shell expansion that produced nothing (e.g.
        // `"$(cat missing.json)"`). Silently defaulting it to `[]`
        // dispatches zero arguments and surfaces as a confusing server-side
        // cardinality mismatch, so reject it here. Only a genuinely absent
        // argument (with empty stdin) defaults to `[]`, which is correct for
        // a target that takes no parameters.
        if (rest[0] === "") {
            throw "call: params-json argument is empty (a shell expansion likely produced nothing); pass a JSON array such as [] explicitly";
        }
        const paramsJson = rest[0] !== undefined && rest[0] !== "" ? rest[0] : stdin && stdin !== "" ? stdin : "[]";
        return targetCall(host, [ffqn, paramsJson]);
    }
    if (group === "generate") return executeGenerate(action);
    if (group === "deployment") return executeDeployment(interp, action, rest, host);
    return fail(`obelisk: unknown command '${args.join(" ")}'\n${helpText}`);
}

// Print a starter config file. Purely local: unlike the other groups it
// never touches the target server, it just echoes a template baked in at
// build time.
function executeGenerate(action) {
    if (action === "deployment") return ok(ensureTrailingNewline(DEPLOYMENT_TEMPLATE));
    if (action === "") return fail(`obelisk generate: a subcommand is required\n${generateHelp}`);
    return fail(`obelisk generate: unknown action '${action}'\n`);
}

function executeDeployment(interp, action, args, host) {
    if (action === "current") {
        return jsonCall(host, "obelisk-agent:tools/webapi.current-deployment-id", []);
    }
    if (action === "refresh") {
        // An explicit refresh populates the tree now, so drop the deferred
        // mount to keep a later deployment access from re-fetching it.
        interp.vfs.clearDeferredMount(DEPLOYMENT_ROOT);
        const refreshed = refreshDeploymentMount(interp.vfs, host, true);
        return ok(`${mountResultJson(refreshed)}\n`);
    }
    if (action === "check") {
        const dir = resolveDeploymentDir(interp, firstPositional(args, []));
        const manifest = readManifest(interp.vfs, dir);
        const sources = deploymentSources(interp.vfs, dir, manifest);
        const payload = { directory: dir, manifest_bytes: utf8Encode(manifest).length, owned_sources: sources };
        return ok(`${prettyJson(payload)}\n`);
    }
    if (action === "submit") {
        // The PATH is positional, so skip flags (and `--description`'s
        // value) when finding it; otherwise `submit --description X` reads
        // `X`, or even `--description` itself, as the deployment directory.
        const dir = resolveDeploymentDir(interp, firstPositional(args, ["--description"]));
        const manifest = readManifest(interp.vfs, dir);
        const prepared = manifestWithGeneratedFiles(interp.vfs, dir, manifest);
        // Expand the digest-free view back to what the server stores: every
        // `content_digest`, `component_files` value, and `backtrace.sources`
        // table, each digest recomputed from the file's current bytes (an
        // unchanged file keeps its CAS digest, a changed one is re-hashed).
        const expanded = manifestWithDigests(interp.vfs, dir, prepared);
        const deploymentId = basename(dir) === "current" ? "" : basename(dir);
        const description = option(args, "--description", "Submitted from workflow-agent VFS");
        const allowMissing = flagRuntimeConfig(args);
        return submitDeployment(interp.vfs, host, dir, expanded, description, allowMissing, deploymentId);
    }
    if (action === "switch") {
        return jsonCall(host, "obelisk-agent:tools/webapi.deployment-switch", [
            required(args[0], "deployment id"),
            flagRuntimeConfig(args),
        ]);
    }
    if (action === "apply") {
        return jsonCall(host, "obelisk-agent:tools/webapi.apply-deployment", [required(args[0], "deployment id")]);
    }
    return fail(`obelisk deployment: unknown action '${action}'\n`);
}

// The workflow half of the submit contract: drive the dumb
// `deployment-submit` activity's preflight/attach loop. The first call
// carries no blobs (a JSON preflight); each `permanent-missing-files` error
// names the blobs the CAS lacks, which we read straight from the VFS and
// resubmit as a multipart package, until the server accepts it. A run that
// keeps reporting the same files after they were attached is a digest
// mismatch we cannot fix by resending, so it errors instead of looping.
function submitDeployment(fs, host, dir, manifest, description, allowMissing, deploymentId) {
    let attachments = [];
    let previous = null;
    for (;;) {
        const params = [manifest, attachments, description, allowMissing, deploymentId];
        let missing;
        try {
            const value = callValue(host, SUBMIT_FFQN, JSON.stringify(params));
            return ok(`${prettyJson({ deployment_id: decodeString(value) })}\n`);
        } catch (message) {
            const parsed = parseMissingFiles(message);
            if (parsed === null) throw message;
            missing = parsed;
        }
        const paths = missing.map((m) => m?.path).filter((p) => typeof p === "string");
        if (previous !== null && arraysEqual(previous, paths)) {
            throw `server still missing ${paths.length} file(s) after they were attached (digest mismatch?): ${paths.join(", ")}`;
        }
        const next = [];
        for (const issue of missing) {
            const path = issue?.path;
            if (typeof path !== "string") throw "server reported a missing file with no path";
            const digest = typeof issue?.digest === "string" ? issue.digest : "";
            let content;
            try {
                content = fs.readFile(`${dir}/${path}`);
            } catch {
                throw `server needs ${path} but it is not in the deployment tree; write the file before submitting`;
            }
            next.push({ path, digest, content });
        }
        attachments = next;
        previous = paths;
    }
}

// Recover the `permanent-missing-files` error arm from the stringified
// submit error. The host seam collapses an activity's error to text: this
// arm arrives as verbatim JSON (`{"permanent_missing_files":[{path,digest},...]}`),
// while a terminal permanent/transient error arrives as its plain message.
// Returns the entries only for the former (accepting either key spelling),
// else `null`.
function parseMissingFiles(message) {
    if (typeof message !== "string") return null;
    let value;
    try {
        value = JSON.parse(message);
    } catch {
        return null;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = value.permanent_missing_files ?? value["permanent-missing-files"];
    return Array.isArray(entries) ? entries : null;
}

function arraysEqual(a, b) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

// The deployment-owned source paths a submit would carry: only those the
// session modified locally (`deployment check` reports them). An unmodified
// file stays a lazy `pending` VFS entry whose blob is already in the CAS, so
// `manifestWithDigests` re-pins its existing digest and `submitDeployment`
// never uploads it (the "upload only what the server is missing" contract).
// Skipping unmodified files keeps a redeploy from touching every component,
// notably the multi-MB workflow and activity WASM. A `pending` file with a
// foreign (non-CAS) digest, e.g. copied in from a git/web mount and never
// locally edited, is *not* skipped: its bytes were never uploaded here under
// that digest, so it must go out like a modified file (see
// `ownedSourceDigest`).
export function deploymentSources(fs, dir, manifest) {
    const files = [];
    for (const location of ownedSourceLocations(manifest)) {
        const path = `${dir}/${location}`;
        // A local write clears the pending flag; a mere read does not. So a
        // file still pending with a real CAS digest is unmodified and
        // already uploaded - skip it.
        const lazy = fs.lazyFileRef(path);
        if (lazy && isCasNamespacedDigest(lazy.digest)) continue;
        if (fs.exists(path)) files.push(location);
    }
    return files;
}

// Resolve the directory holding `deployment.toml` from a positional
// argument. Accepts a path to the `deployment.toml` file itself (obelisk's
// `submit PATH`; its parent is the directory), a directory, or nothing
// (defaults to the cwd).
function resolveDeploymentDir(interp, value) {
    const raw = value !== undefined && value !== "" ? value : ".";
    const resolved = interp.resolvePath(raw);
    return basename(resolved) === "deployment.toml" ? parentDir(resolved) : resolved;
}

function parentDir(path) {
    const idx = path.lastIndexOf("/");
    return idx <= 0 ? "/" : path.slice(0, idx);
}

// The first positional argument, skipping flags. A flag named in
// `valueFlags` also consumes the following token as its value; `--` ends
// flag parsing so the next token is positional. Keeps `submit --description
// X` from reading a flag (or its value) as the PATH.
function firstPositional(args, valueFlags) {
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "--") return args[i + 1];
        if (arg.startsWith("-") && arg.length > 1) {
            i += valueFlags.includes(arg) ? 2 : 1;
            continue;
        }
        return arg;
    }
    return undefined;
}

// The runtime-config override, accepting both the pack's original flag name
// and obelisk's `--allow-unavailable-runtime-config` spelling.
function flagRuntimeConfig(args) {
    return flag(args, "--allow-missing-runtime-config") || flag(args, "--allow-unavailable-runtime-config");
}

function readManifest(fs, dir) {
    const path = `${dir}/deployment.toml`;
    if (!fs.exists(path)) throw `${path}: No such file or directory`;
    return fs.readFile(path);
}

function jsonCall(host, ffqn, params) {
    const value = callValue(host, ffqn, JSON.stringify(params));
    return ok(ensureTrailingNewline(renderOutput(value)));
}

function targetCall(host, params) {
    const value = callValue(host, "obelisk-control:tools/native.call", JSON.stringify(params));
    return ok(ensureTrailingNewline(renderOutput(decodeJson(value))));
}

function listFunctions(host, params) {
    const value = callValue(host, "obelisk-agent:tools/webapi.list-functions", JSON.stringify(params));
    const functions = decodeJson(value);
    if (!Array.isArray(functions)) throw "functions list returned a non-array response";
    const lines = [];
    for (const fn of functions) {
        if (fn?.extension !== undefined && fn?.extension !== null) continue;
        const ffqn = fn?.ffqn;
        if (typeof ffqn !== "string") throw "function metadata has no ffqn";
        const parameterTypes = fn?.parameter_types;
        if (!Array.isArray(parameterTypes)) throw `function metadata for ${ffqn} has no parameter_types`;
        const parameters = parameterTypes
            .map((parameter) => {
                const name = parameter?.name;
                if (typeof name !== "string") throw `function parameter for ${ffqn} has no name`;
                const witType = parameter?.wit_type;
                if (typeof witType !== "string") throw `function parameter ${name} for ${ffqn} has no wit_type`;
                return `${name}: ${witType}`;
            })
            .join(", ");
        const returnType = fn?.return_type;
        if (typeof returnType !== "string") throw `function metadata for ${ffqn} has no return_type`;
        lines.push(`${ffqn} : func(${parameters}) -> ${returnType}`);
    }
    return ok(lines.length ? `${lines.join("\n")}\n` : "");
}

// Render an FFQN result for the shell. The endpoints return JSON *text*, so
// a structural result (array/object) is pretty-printed - one element/field
// per line - to stay readable and greppable rather than a single dense
// line. A string body that is not itself structural JSON (WIT text,
// execution logs, a bare deployment id) prints verbatim, as does a scalar.
// `null` (no body) stays `null`.
function renderOutput(value) {
    if (typeof value === "string") {
        try {
            const inner = JSON.parse(value);
            if (Array.isArray(inner) || (inner !== null && typeof inner === "object")) return prettyJson(inner);
            return value;
        } catch {
            return value;
        }
    }
    return prettyJson(value);
}

function prettyJson(value) {
    return JSON.stringify(value, null, 2);
}

// PORT: the JS `obelisk.call` builtin. `host.callJson` returns raw JSON text
// (one layer higher than the already-deserialized value every caller
// wants), so every pack consumer peels that single layer here before
// decoding. A missing body (`null`) becomes JS `null`; text that is not
// valid JSON (a non-JSON blob body) is kept as-is (a JS string).
function callValue(host, ffqn, paramsJson) {
    let text;
    try {
        text = host.callJson(ffqn, paramsJson);
    } catch (error) {
        throw typeof error === "string" ? error : String(error?.message ?? error);
    }
    if (text === null || text === undefined) return null;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function ensureTrailingNewline(text) {
    return text.endsWith("\n") ? text : `${text}\n`;
}

function mountResultJson(result) {
    return prettyJson({ deployment_id: result.deploymentId, files: result.files });
}

// PORT: `decodeString`. `value` is the already-peeled `callValue` result. A
// string that itself parses as a JSON string yields the inner contents (the
// `current-deployment-id` case, whose body is `resp.text()` of a JSON
// string, so it arrives double-quoted); a string that parses as an object
// falls back to its `deployment_id` field; anything else is the trimmed
// string. A non-string value coerces to text.
function decodeString(value) {
    if (typeof value !== "string") return coerceText(value);
    try {
        const inner = JSON.parse(value);
        if (typeof inner === "string") return inner;
        if (inner !== null && typeof inner === "object" && !Array.isArray(inner)) {
            return typeof inner.deployment_id === "string" ? inner.deployment_id : "";
        }
        return "";
    } catch {
        return value.trim();
    }
}

// PORT: `decodeJson`. An object/array passes through; a string is parsed
// once. backcompat: 0.1.0 deployment-checkout returned its record as a JSON
// string.
function decodeJson(value) {
    if (value !== null && typeof value === "object") return value;
    if (typeof value === "string") {
        try {
            return JSON.parse(value);
        } catch (error) {
            throw `invalid JSON: ${error.message}`;
        }
    }
    return value;
}

// PORT: JS `String(content)` for blob bodies: the peeled string verbatim (no
// re-parse, no trim, unlike `decodeString`), or a coercion of a non-string.
function coerceText(value) {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    return JSON.stringify(value);
}

function required(value, label) {
    if (typeof value === "string" && value !== "") return value;
    throw `${label} is required`;
}

function option(args, name, fallback) {
    const i = args.indexOf(name);
    if (i === -1 || i + 1 >= args.length) return fallback;
    return args[i + 1];
}

function integerOption(args, name, fallback) {
    const i = args.indexOf(name);
    const raw = i === -1 ? undefined : args[i + 1];
    if (raw === undefined) return fallback;
    const n = /^-?\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function flag(args, name) {
    return args.includes(name);
}

function basename(path) {
    const trimmed = path.replace(/\/+$/, "");
    const idx = trimmed.lastIndexOf("/");
    return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function ok(stdout = "") {
    return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr) {
    return { stdout: "", stderr, exitCode: 2 };
}

function isHelpFlag(arg) {
    return arg === "-h" || arg === "--help";
}

function helpRequested(args) {
    return args.some(isHelpFlag);
}

// Usage for a command group (`obelisk <group> --help`), or the top-level
// help for an unrecognized group.
function groupHelp(group) {
    switch (group) {
        case "functions":
            return functionsHelp;
        case "executions":
            return executionsHelp;
        case "call":
            return callHelp;
        case "deployment":
            return deploymentHelp;
        case "generate":
            return generateHelp;
        default:
            return helpText;
    }
}

// Usage for a specific subcommand (`obelisk <group> <action> --help`). Only
// the deployment subcommands (and `call`) carry their own option list;
// everything else falls back to the group help, which already lists each
// subcommand.
function actionHelp(group, action) {
    if (group === "call") return callHelp;
    if (group === "deployment" && action === "submit") return deploymentSubmitHelp;
    if (group === "deployment" && action === "check") return deploymentCheckHelp;
    if (group === "deployment" && action === "switch") return deploymentSwitchHelp;
    if (group === "deployment" && action === "apply") return deploymentApplyHelp;
    if (group === "generate" && action === "deployment") return generateDeploymentHelp;
    return groupHelp(group);
}

const helpText =
    "Usage: obelisk <command> [args]\n\nQuery and control the running Obelisk server, and edit the deployment checked\nout under /workspace/deployment/current.\n\nCommands:\n  functions    List deployed functions, or print a function's WIT.\n  executions   List executions, or show one execution's record, logs, or result.\n  call         Call a deployed function and print its result.\n  deployment   Inspect, edit, submit, and activate deployments.\n  generate     Print a starter configuration file.\n\nRun `obelisk <command> --help` (or `-h`) for a command's subcommands and options.\n";

const functionsHelp =
    "Usage: obelisk functions <subcommand>\n\nList deployed functions, or print a single function's WIT interface.\n\nSubcommands:\n  list [--prefix PREFIX] [--length N] [--json]   List functions and their signatures.\n  wit FFQN                                        Print the WIT interface for one function.\n";

const executionsHelp =
    "Usage: obelisk executions <subcommand>\n\nList executions, or show one execution's record, logs, or result.\n\nSubcommands:\n  list [--ffqn-prefix PREFIX] [--id-prefix PREFIX] [--show-derived] [--hide-finished] [--length N]\n                                                  List executions (most recent first).\n  get ID                                          Show an execution's record.\n  logs ID [--length N]                            Show an execution's logs.\n  result ID                                       Show an execution's result value.\n";

const callHelp =
    "Usage: obelisk call FFQN [PARAMS_JSON]\n       obelisk call FFQN -- PARAM...\n\nCall a deployed function and print its result. Pass parameters as one JSON array\nin WIT parameter order, or after `--` as positional values (each parsed as JSON\nwhen valid, otherwise as a string). With neither, parameters are read from stdin,\ndefaulting to `[]`.\n";

const deploymentHelp =
    "Usage: obelisk deployment <subcommand>\n\nInspect, edit, submit, and activate deployments. Edits under\n/workspace/deployment/current are local until `submit` or `apply`.\n\nSubcommands:\n  current                   Print the active deployment ID.\n  refresh                   Re-fetch the active deployment, discarding local edits.\n  check [PATH]              Report a deployment's manifest and locally-edited sources.\n  submit [PATH] [OPTIONS]   Store the edited deployment as a new inactive deployment.\n  switch ID [OPTIONS]       Activate a stored deployment (verified on next server restart).\n  apply ID                  Submit-and-apply: hot-redeploy a stored deployment now.\n\nRun `obelisk deployment <subcommand> --help` for a subcommand's options.\n";

const deploymentSubmitHelp =
    "Usage: obelisk deployment submit [OPTIONS] [PATH-TO-DEPLOYMENT.TOML]\n\nStore the edited deployment as a new inactive deployment and print its ID. PATH\nis the deployment.toml to submit, or the directory containing it; it defaults to\n./deployment.toml. Digests are recomputed from the files, so leave them out.\n\nOptions:\n      --description TEXT               Human-readable description for the new deployment.\n      --allow-missing-runtime-config  Tolerate runtime config unavailable on this server.\n                                       (alias: --allow-unavailable-runtime-config)\n";

const deploymentCheckHelp =
    "Usage: obelisk deployment check [PATH-TO-DEPLOYMENT.TOML]\n\nReport a deployment's manifest size and the owned sources edited locally (the\nfiles a submit would upload). PATH is the deployment.toml, or its directory; it\ndefaults to ./deployment.toml.\n";

const deploymentSwitchHelp =
    "Usage: obelisk deployment switch [OPTIONS] ID\n\nMark a stored deployment active; it is verified and applied on the next server\nrestart.\n\nOptions:\n      --allow-missing-runtime-config  Tolerate runtime config unavailable on this server.\n                                       (alias: --allow-unavailable-runtime-config)\n";

const deploymentApplyHelp =
    "Usage: obelisk deployment apply ID\n\nHot-redeploy a stored deployment now (fails if it cannot be applied live).\n";

const generateHelp =
    "Usage: obelisk generate <subcommand>\n\nPrint a starter Obelisk configuration file.\n\nSubcommands:\n  deployment   Print a default deployment.toml with every option documented.\n";

const generateDeploymentHelp =
    "Usage: obelisk generate deployment\n\nPrint a default deployment.toml with every option documented as comments.\nRedirect it to a file to scaffold a new deployment, e.g.\n`obelisk generate deployment > deployment.toml`.\n";

// ---------------------------------------------------------------------------
// TOML editor
//
// A hand-written, purpose-built editor scoped to exactly what
// `simplifyManifest`/`manifestWithDigests`/`ownedSourceLocations` need - not
// a general TOML parser (no bare npm dependency resolves in the deployed
// component, so a real TOML library is not an option; see
// docs/js-backend-migration.md). It works by locating byte ranges ("edits")
// to rewrite and applying them over the original text verbatim, so every
// other byte (comments, blank lines, unrelated keys, formatting, key
// ordering) survives untouched - a surgical value-level rewrite rather than
// a parse/mutate/re-serialize round trip like the Rust port's `toml_edit`.
//
// The scanner recognizes each top-level `[[array-of-tables]]` header
// generically (no fixed list of table names) and tracks, per block
// instance, its "root" scope (keys directly under the header, before any
// nested section) plus any nested `[name.sub...]` section by its dotted
// path relative to the block name - this correctly handles a block's own
// nested arrays-of-tables too (e.g. `[[activity_js.allowed_host]]`), which
// must NOT be mistaken for a new top-level block or for the block's root.
// ---------------------------------------------------------------------------

// A header line: 1 or 2 opening brackets, dotted name, matching closing
// brackets, nothing else on the line.
const HEADER_LINE_RE = /^(\[{1,2})([^[\]]+)(\]{1,2})\s*$/;

// Scan `text` into a flat, ordered list of `{blockName, relPath, start,
// end}` regions: `relPath === ""` is a block's root scope; any other
// `relPath` (e.g. "backtrace", "backtrace.sources", "allowed_host") is a
// nested section, dotted path relative to the block name. Text outside any
// recognized `[[name]]` block (unrelated top-level tables, or a nested
// array-of-tables with no matching top-level parent, e.g.
// `[[webhook_endpoint.other]]` with no preceding `[[webhook_endpoint]]`) is
// simply not captured by any region - left alone by every editor below.
function findRegions(text) {
    const regions = [];
    let cur = null;
    let pos = 0;
    const n = text.length;
    while (pos < n) {
        const nl = text.indexOf("\n", pos);
        const lineEnd = nl === -1 ? n : nl + 1;
        const raw = text.slice(pos, nl === -1 ? n : nl);
        const m = HEADER_LINE_RE.exec(raw.trim());
        if (m && m[1].length === m[3].length) {
            const brackets = m[1].length;
            const segs = m[2].split(".");
            const isNewSameBlock = brackets === 2 && segs.length === 1;
            if (cur && segs[0] === cur.blockName && !isNewSameBlock) {
                // A nested continuation of the current block (single or
                // double bracket, dotted path under the block name): closes
                // whatever section was open, opens a new one.
                regions.push({ blockName: cur.blockName, relPath: cur.relPath, start: cur.start, end: pos });
                cur = { blockName: cur.blockName, relPath: segs.slice(1).join("."), start: lineEnd };
            } else {
                if (cur) regions.push({ blockName: cur.blockName, relPath: cur.relPath, start: cur.start, end: pos });
                cur = isNewSameBlock ? { blockName: m[2], relPath: "", start: lineEnd } : null;
            }
        }
        pos = lineEnd;
    }
    if (cur) regions.push({ blockName: cur.blockName, relPath: cur.relPath, start: cur.start, end: n });
    return regions;
}

// Group `findRegions`' flat region list into per-instance blocks, each
// `{blockName, root, sections: Map<relPath, region>}`, in document order.
function groupBlocks(regions) {
    const blocks = [];
    let current = null;
    for (const r of regions) {
        if (r.relPath === "") {
            current = { blockName: r.blockName, root: r, sections: new Map() };
            blocks.push(current);
        } else if (current && r.blockName === current.blockName) {
            current.sections.set(r.relPath, r);
        }
    }
    return blocks;
}

// The `backtrace.sources` entries for one block, whichever of the three
// shapes it is written in: a nested `[name.backtrace.sources]` table (one
// `"key" = value` assignment per line), an inline `backtrace.sources = {
// ... }` key in the root scope, or a nested `[name.backtrace]` table with an
// inline `sources = { ... }` key. Returns `[]` if the block has no
// backtrace sources at all.
function backtraceEntries(manifest, block) {
    const sourcesRegion = block.sections.get("backtrace.sources");
    if (sourcesRegion) return scanEntries(manifest, sourcesRegion.start, sourcesRegion.end);
    const backtraceRegion = block.sections.get("backtrace");
    const sourcesAssign = backtraceRegion
        ? findAssignment(manifest, backtraceRegion.start, backtraceRegion.end, "sources")
        : findAssignment(manifest, block.root.start, block.root.end, "backtrace.sources");
    if (sourcesAssign && manifest[sourcesAssign.valueStart] === "{") {
        return scanEntries(manifest, sourcesAssign.valueStart + 1, sourcesAssign.valueEnd - 1);
    }
    return [];
}

// Collapse a stored manifest into the digest-free view the agent edits:
// drop `content_digest`, blank `component_files` values to `"auto"`, reduce
// each `backtrace.sources` entry to its path. Inverse of
// `manifestWithDigests`.
export function simplifyManifest(manifest) {
    const blocks = groupBlocks(findRegions(manifest));
    const edits = [];
    for (const block of blocks) {
        const digestAssign = findAssignment(manifest, block.root.start, block.root.end, "content_digest");
        if (digestAssign) {
            edits.push({ start: digestAssign.line.lineStart, end: digestAssign.line.lineEnd, text: "" });
        }

        const filesAssign = findAssignment(manifest, block.root.start, block.root.end, "component_files");
        if (filesAssign && manifest[filesAssign.valueStart] === "{") {
            for (const entry of scanEntries(manifest, filesAssign.valueStart + 1, filesAssign.valueEnd - 1)) {
                const key = unquoteString(manifest.slice(entry.keyStart, entry.keyEnd));
                if (key.startsWith("oci://")) continue;
                edits.push({ start: entry.valueStart, end: entry.valueEnd, text: quoteString(AUTO_DIGEST) });
            }
        }

        for (const entry of backtraceEntries(manifest, block)) {
            const valueText = manifest.slice(entry.valueStart, entry.valueEnd).trim();
            if (!valueText.startsWith("{")) continue; // already simplified (a plain path string); leave as-is
            const path = extractInlineField(manifest, entry.valueStart, entry.valueEnd, "path");
            if (path === null || path.startsWith("oci://")) continue;
            edits.push({ start: entry.valueStart, end: entry.valueEnd, text: quoteString(path) });
        }
    }
    return applyEdits(manifest, edits);
}

// Inverse of `simplifyManifest`: re-pin each `content_digest`,
// `component_files` value, and `backtrace.sources` entry from the file's
// current bytes (a missing file is left as-is).
export function manifestWithDigests(fs, dir, manifest) {
    const blocks = groupBlocks(findRegions(manifest));
    const edits = [];
    for (const block of blocks) {
        const locationAssign = findAssignment(manifest, block.root.start, block.root.end, "location");
        let digest = null;
        if (locationAssign) {
            const location = unquoteString(manifest.slice(locationAssign.valueStart, locationAssign.valueEnd));
            if (!location.startsWith("oci://")) digest = ownedSourceDigest(fs, `${dir}/${location}`);
        }
        if (digest !== null) {
            const digestAssign = findAssignment(manifest, block.root.start, block.root.end, "content_digest");
            if (digestAssign) {
                edits.push({ start: digestAssign.valueStart, end: digestAssign.valueEnd, text: quoteString(digest) });
            } else {
                const insertAt = lastContentEnd(manifest, block.root.start, block.root.end);
                const needsNewline = insertAt > 0 && manifest[insertAt - 1] !== "\n";
                edits.push({
                    start: insertAt,
                    end: insertAt,
                    text: `${needsNewline ? "\n" : ""}content_digest = ${quoteString(digest)}\n`,
                });
            }
        }

        const filesAssign = findAssignment(manifest, block.root.start, block.root.end, "component_files");
        if (filesAssign && manifest[filesAssign.valueStart] === "{") {
            for (const entry of scanEntries(manifest, filesAssign.valueStart + 1, filesAssign.valueEnd - 1)) {
                const key = unquoteString(manifest.slice(entry.keyStart, entry.keyEnd));
                if (key.startsWith("oci://")) continue;
                const fileDigest = ownedSourceDigest(fs, `${dir}/${key}`);
                if (fileDigest === null) continue;
                edits.push({ start: entry.valueStart, end: entry.valueEnd, text: quoteString(fileDigest) });
            }
        }

        for (const entry of backtraceEntries(manifest, block)) {
            const valueText = manifest.slice(entry.valueStart, entry.valueEnd).trim();
            if (valueText.startsWith("{")) continue; // already expanded; left untouched (matches the Rust port)
            const path = unquoteString(manifest.slice(entry.valueStart, entry.valueEnd));
            if (path.startsWith("oci://")) continue;
            const sourceDigest = ownedSourceDigest(fs, `${dir}/${path}`);
            if (sourceDigest === null) continue;
            edits.push({
                start: entry.valueStart,
                end: entry.valueEnd,
                text: `{ path = ${quoteString(path)}, content_digest = ${quoteString(sourceDigest)} }`,
            });
        }
    }
    return applyEdits(manifest, edits);
}

// Rebuild metadata that the native CLI derives from authored directories and
// module imports. Checked-out deployments already carry this map, while a
// from-scratch manifest does not.
export function manifestWithGeneratedFiles(fs, dir, manifest) {
    const edits = [];
    for (const block of groupBlocks(findRegions(manifest))) {
        const refs = new Map();
        const witAssign = findAssignment(manifest, block.root.start, block.root.end, "wit");
        if (witAssign) {
            const root = unquoteString(manifest.slice(witAssign.valueStart, witAssign.valueEnd));
            for (const path of recursiveFiles(fs, `${dir}/${root}`, root)) {
                if (path.endsWith(".wit")) addGeneratedRef(refs, fs, dir, path);
            }
        }

        if (["activity_js", "workflow_js", "webhook_endpoint_js"].includes(block.blockName)) {
            const locationAssign = findAssignment(manifest, block.root.start, block.root.end, "location");
            if (locationAssign) {
                const entry = unquoteString(manifest.slice(locationAssign.valueStart, locationAssign.valueEnd));
                if (!entry.startsWith("oci://")) {
                    const graph = collectJsGraph(fs, dir, entry);
                    if (graph.length > 1) {
                        for (const path of graph) addGeneratedRef(refs, fs, dir, path);
                    }
                }
            }
        }

        for (const entry of backtraceEntries(manifest, block)) {
            const raw = manifest.slice(entry.valueStart, entry.valueEnd).trim();
            const path = raw.startsWith("{")
                ? extractInlineField(manifest, entry.valueStart, entry.valueEnd, "path")
                : unquoteString(raw);
            if (path && !path.startsWith("oci://")) addGeneratedRef(refs, fs, dir, path);
        }

        const assignment = findAssignment(manifest, block.root.start, block.root.end, "component_files");
        if (refs.size > 0) {
            const value = `{ ${[...refs].sort(([a], [b]) => a.localeCompare(b))
                .map(([path, digest]) => `${quoteString(path)} = ${quoteString(digest)}`).join(", ")} }`;
            if (assignment) {
                edits.push({ start: assignment.valueStart, end: assignment.valueEnd, text: value });
            } else {
                const at = lastContentEnd(manifest, block.root.start, block.root.end);
                const newline = at > 0 && manifest[at - 1] !== "\n" ? "\n" : "";
                edits.push({ start: at, end: at, text: `${newline}component_files = ${value}\n` });
            }
        } else if (assignment) {
            edits.push({ start: assignment.line.lineStart, end: assignment.line.lineEnd, text: "" });
        }
    }
    return applyEdits(manifest, edits);
}

function addGeneratedRef(refs, fs, dir, path) {
    const digest = ownedSourceDigest(fs, `${dir}/${path}`);
    if (digest !== null) refs.set(path, digest);
}

function recursiveFiles(fs, absoluteRoot, relativeRoot) {
    const out = [];
    const visit = (absolute, relative) => {
        let names;
        try { names = fs.readdir(absolute); } catch { return; }
        for (const name of names) {
            const childAbsolute = `${absolute}/${name}`;
            const childRelative = `${relative}/${name}`;
            try {
                fs.readdir(childAbsolute);
                visit(childAbsolute, childRelative);
            } catch {
                if (fs.exists(childAbsolute)) out.push(childRelative);
            }
        }
    };
    visit(absoluteRoot, relativeRoot);
    return out;
}

function collectJsGraph(fs, dir, entry) {
    const files = [];
    const queued = [normalizeDeploymentPath(entry)];
    const seen = new Set();
    while (queued.length > 0) {
        const path = queued.shift();
        if (seen.has(path)) continue;
        const source = fs.readFile(`${dir}/${path}`);
        seen.add(path);
        files.push(path);
        for (const specifier of moduleSpecifiers(source)) {
            if (specifier.startsWith("./") || specifier.startsWith("../")) {
                const slash = path.lastIndexOf("/");
                const base = slash === -1 ? "" : path.slice(0, slash + 1);
                queued.push(normalizeDeploymentPath(base + specifier));
            } else if (!(specifier.includes(":") && specifier.includes("/"))) {
                throw `unsupported bare module specifier ${JSON.stringify(specifier)} in ${path}`;
            }
        }
    }
    return files;
}

function moduleSpecifiers(source) {
    const found = [];
    const patterns = [
        /\bimport\s*["']([^"']+)["']/g,
        /\b(?:import|export)\s+[\s\S]*?\sfrom\s*["']([^"']+)["']/g,
    ];
    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(source)) !== null) found.push(match[1]);
    }
    return found;
}

function normalizeDeploymentPath(path) {
    const parts = [];
    for (const part of path.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") {
            if (parts.length === 0) throw `deployment path escapes its root: ${path}`;
            parts.pop();
        } else {
            parts.push(part);
        }
    }
    if (parts.length === 0) throw `deployment path is empty: ${path}`;
    return parts.join("/");
}

// Every deployment-owned source location a submit tracks: each component's
// `location`, `component_files` keys, and (only when written in the
// EXPANDED `{ path = ..., content_digest = ... }` form - a plain simplified
// path string is not recognized here, matching the Rust port's
// `Item::as_table_like` check) `backtrace.sources` paths. `oci://` refs
// skipped, deduped first-wins.
export function ownedSourceLocations(manifest) {
    const blocks = groupBlocks(findRegions(manifest));
    const seen = new Set();
    const locations = [];
    const add = (loc) => {
        if (!loc.startsWith("oci://") && !seen.has(loc)) {
            seen.add(loc);
            locations.push(loc);
        }
    };
    for (const block of blocks) {
        const locationAssign = findAssignment(manifest, block.root.start, block.root.end, "location");
        if (locationAssign) add(unquoteString(manifest.slice(locationAssign.valueStart, locationAssign.valueEnd)));

        const filesAssign = findAssignment(manifest, block.root.start, block.root.end, "component_files");
        if (filesAssign && manifest[filesAssign.valueStart] === "{") {
            for (const entry of scanEntries(manifest, filesAssign.valueStart + 1, filesAssign.valueEnd - 1)) {
                add(unquoteString(manifest.slice(entry.keyStart, entry.keyEnd)));
            }
        }

        for (const entry of backtraceEntries(manifest, block)) {
            const valueText = manifest.slice(entry.valueStart, entry.valueEnd).trim();
            if (!valueText.startsWith("{")) continue;
            const path = extractInlineField(manifest, entry.valueStart, entry.valueEnd, "path");
            if (path !== null) add(path);
        }
    }
    return locations;
}

// The `content_digest` for a deployment-owned source at submit time: an
// unchanged file is still a lazy `pending` VFS entry and keeps its CAS
// digest; a changed or newly created file is re-hashed from the same
// string content `submitDeployment` transmits, so the server's re-hash
// matches. Returns null if the file is missing (or unreadable). A `pending`
// file whose digest isn't CAS-namespaced (e.g. a git/web mount's own foreign
// hash) is treated like a modified file instead: its bytes were never
// uploaded to this server's CAS under that digest, so it must be fetched and
// rehashed here rather than have the foreign hash reused as a bogus
// `content_digest`.
function ownedSourceDigest(fs, path) {
    const lazy = fs.lazyFileRef(path);
    if (lazy && isCasNamespacedDigest(lazy.digest)) {
        console.debug(`ownedSourceDigest(${path}): unchanged, reusing cached digest`);
        return lazy.digest;
    }
    let content;
    try {
        content = fs.readFile(path);
    } catch {
        return null;
    }
    const bytes = utf8Encode(content);
    console.debug(`ownedSourceDigest(${path}): hashing ${bytes.length} bytes (modified/new file)`);
    const digest = `sha256:${sha256Hex(bytes)}`;
    console.debug(`ownedSourceDigest(${path}): hashed, digest=${digest}`);
    return digest;
}

// The absolute offset right after the last non-blank, non-comment line
// within [start, end) - where `manifestWithDigests` appends a
// `content_digest` line when the block has none yet (matching toml_edit's
// "insert at the end of the table" semantics for a missing key). Falls back
// to `start` (right after the block's own header) if the scope has no real
// content at all.
function lastContentEnd(text, start, end) {
    const lines = regionLines(text, start, end);
    for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].content.trim();
        if (t !== "" && !t.startsWith("#")) return lines[i].lineEnd;
    }
    return start;
}

// Physical lines within [start, end), each `{lineStart, lineEnd, content}`
// (`content` excludes the trailing newline; `lineEnd` includes it, or is
// `end` for a final unterminated line).
function regionLines(text, start, end) {
    const lines = [];
    let pos = start;
    while (pos < end) {
        const nl = text.indexOf("\n", pos);
        const lineEnd = nl === -1 || nl >= end ? end : nl + 1;
        const contentEnd = nl === -1 || nl >= end ? end : nl;
        lines.push({ lineStart: pos, lineEnd, content: text.slice(pos, contentEnd) });
        pos = lineEnd;
    }
    return lines;
}

// Find a bare (unquoted, possibly dotted, e.g. "backtrace.sources") key
// assignment within [start, end): a line whose trimmed text starts with
// `key` followed by optional spaces/tabs and `=`. Returns
// `{line, valueStart, valueEnd}` (absolute offsets; the value may itself
// span multiple lines, e.g. a reformatted multi-line inline table) or null.
function findAssignment(text, start, end, key) {
    for (const line of regionLines(text, start, end)) {
        const raw = line.content;
        const trimmed = raw.trimStart();
        if (!trimmed.startsWith(key)) continue;
        const leading = raw.length - trimmed.length;
        let j = key.length;
        while (trimmed[j] === " " || trimmed[j] === "\t") j++;
        if (trimmed[j] !== "=") continue;
        j++;
        while (trimmed[j] === " " || trimmed[j] === "\t") j++;
        const valueStart = line.lineStart + leading + j;
        const valueEnd = scanValueEnd(text, valueStart);
        return { line, valueStart, valueEnd };
    }
    return null;
}

// Entries of a comma-separated inline table body (text between its `{` and
// `}`, exclusive) OR a newline-separated TOML table body (a
// `[name.backtrace.sources]` section) - the two are structurally
// interchangeable for this scanner since it treats both `,` and end-of-text
// as valid entry terminators and whitespace (including newlines) as
// insignificant between entries. Returns `[{keyStart, keyEnd, valueStart,
// valueEnd}]`, absolute offsets into `text`.
function scanEntries(text, start, end) {
    const entries = [];
    let i = start;
    while (i < end) {
        while (i < end && /\s/.test(text[i])) i++;
        if (i >= end) break;
        if (text[i] === ",") {
            i++;
            continue;
        }
        if (text[i] === "#") {
            const nl = text.indexOf("\n", i);
            i = nl === -1 || nl >= end ? end : nl + 1;
            continue;
        }
        const keyStart = i;
        if (text[i] === '"' || text[i] === "'") {
            const quote = text[i];
            i++;
            while (i < end && text[i] !== quote) {
                if (text[i] === "\\") i++;
                i++;
            }
            i++;
        } else {
            while (i < end && /[A-Za-z0-9_.-]/.test(text[i])) i++;
        }
        const keyEnd = i;
        while (i < end && /\s/.test(text[i])) i++;
        if (text[i] !== "=") break;
        i++;
        while (i < end && /\s/.test(text[i])) i++;
        const valueStart = i;
        i = scanValueEnd(text, i);
        const valueEnd = i;
        entries.push({ keyStart, keyEnd, valueStart, valueEnd });
        while (i < end && /[ \t]/.test(text[i])) i++;
        if (i < end && text[i] === ",") i++;
    }
    return entries;
}

// The end offset of the value starting at `i`: a quoted string, a
// brace-balanced inline table (recursing through nested strings so a `{` or
// `}` inside a quoted value is not mistaken for structure), or - as a
// defensive fallback, not expected for any value this module writes or
// reads - a bare token up to the next top-level comma, `}`, or newline.
function scanValueEnd(text, i) {
    const n = text.length;
    if (text[i] === '"' || text[i] === "'") {
        const quote = text[i];
        i++;
        while (i < n && text[i] !== quote) {
            if (text[i] === "\\") i++;
            i++;
        }
        return i + 1;
    }
    if (text[i] === "{") {
        let depth = 0;
        while (i < n) {
            const c = text[i];
            if (c === '"' || c === "'") {
                const quote = c;
                i++;
                while (i < n && text[i] !== quote) {
                    if (text[i] === "\\") i++;
                    i++;
                }
                i++;
                continue;
            }
            if (c === "{") {
                depth++;
                i++;
                continue;
            }
            if (c === "}") {
                depth--;
                i++;
                if (depth === 0) return i;
                continue;
            }
            i++;
        }
        return i;
    }
    while (i < n && text[i] !== "," && text[i] !== "}" && text[i] !== "\n") i++;
    return i;
}

// A named bare-key field's unquoted value from within an inline table's
// span `[start, end)` (`text[start] === "{"`, `text[end-1] === "}"`), or
// null if absent.
function extractInlineField(text, start, end, fieldName) {
    for (const entry of scanEntries(text, start + 1, end - 1)) {
        const key = unquoteString(text.slice(entry.keyStart, entry.keyEnd));
        if (key === fieldName) return unquoteString(text.slice(entry.valueStart, entry.valueEnd));
    }
    return null;
}

// Strip surrounding quotes and unescape a basic (`"..."`) TOML string's
// common escapes, or return a bare (unquoted) token/identifier unchanged.
function unquoteString(raw) {
    if (raw[0] !== '"' && raw[0] !== "'") return raw;
    const quote = raw[0];
    const inner = raw.slice(1, -1);
    if (quote === "'") return inner; // literal string: no escapes
    let out = "";
    const map = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", b: "\b", f: "\f" };
    for (let i = 0; i < inner.length; i++) {
        if (inner[i] === "\\" && inner[i + 1] in map) {
            out += map[inner[i + 1]];
            i++;
        } else {
            out += inner[i];
        }
    }
    return out;
}

function quoteString(value) {
    return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Apply a list of `{start, end, text}` replacements (or insertions, when
// `start === end`) to `text` in one pass, leaving every byte outside an
// edit's span untouched.
function applyEdits(text, edits) {
    if (edits.length === 0) return text;
    const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
    let out = "";
    let cursor = 0;
    for (const edit of sorted) {
        out += text.slice(cursor, edit.start);
        out += edit.text;
        cursor = Math.max(cursor, edit.end);
    }
    out += text.slice(cursor);
    return out;
}
