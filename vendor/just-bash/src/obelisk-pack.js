// The obelisk-control pack: one custom command, `obelisk`, mirroring the real
// obelisk CLI's `cloud` and `generate` subcommands.
//
// `cloud` (host.js's `createCloud`) backs `obelisk cloud ...`:
// `run(args, stdin, appToml, fillEnv)` runs the provisioner commands,
// `prepareDeploy`/`finishDeploy` wrap `app deploy`'s enqueue, and
// `get(app, path)`/`send(app, method, path, contentType, body)` call the app's
// own API, returning `{ status, body }`. The app API subcommands (`execution`,
// `component`, `deployment`, `admin`) are ported here from obelisk's
// src/command/*.rs: human output on stderr, JSON and values on stdout, errors
// as `Error: ...` with exit 1 and usage errors with exit 2.
//
// Custom-command handlers receive the full argv including argv[0] (see
// interpreter.js's `invoke`); `commandHandler` strips it with
// `args.slice(1)`, same as obelisk-program.js.

import { parseApiResponse, parseServerInfoResponse, parseDeploymentSwitchResponse } from "../../obelisk-api/index.js";
import { base64Decode, sha256Hex } from "./commands/hash.js";
import { utf8Decode, utf8Encode } from "./utf8.js";
import { DEPLOYMENT_TEMPLATE } from "./obelisk-deployment-template.js";
import { isCasNamespacedDigest } from "./fs.js";
import { parseToml } from "../../../packs/obelisk-control/cloud/toml.js";

const APP_POLICY_FILE = "app.toml";
const APP_API_GROUPS = ["execution", "component", "deployment", "admin"];

const TEMPLATE_OWNER = "obeli-sk";
const TEMPLATE_REPO = "obelisk";
const TEMPLATES_ROOT = "examples/templates";
// Used when OBELISK_VERSION is not a ref (`latest`) or its templates are missing.
const TEMPLATE_FALLBACK_REF = "main";

// A command-line error, reported like clap's (exit 2).
class UsageError extends Error {}
// The failure is already on stderr; exit 1 without an `Error:` line.
const ALREADY_PRINTED = Symbol("already printed");

// Build the `obelisk` custom-command handler. `generate` is
// `{ obeliskVersion, githubContents }`: the obelisk repo ref and the
// `obelisk-agent:mounts/apps.request` import `generate new` fetches the
// starter app with.
export function commandHandler(generate, cloud) {
    return (interp, args, stdin) => executeObelisk(interp, args.slice(1), stdin, generate, cloud);
}

// Directly callable by tests; `args` does NOT include the command name itself.
export function executeObelisk(interp, args, stdin, generate, cloud) {
    const out = { stdout: "", stderr: "" };
    try {
        if (args[0] === "cloud") return executeCloud(interp, args.slice(1), stdin, cloud, out);
        if (args.length === 0 || isHelpFlag(args[0])) return { ...out, stdout: helpText, exitCode: 0 };
        if (args[0] === "generate") {
            executeGenerate(interp, args.slice(1), generate, out);
            return { ...out, exitCode: 0 };
        }
        throw new UsageError(`unrecognized subcommand '${args[0]}'`);
    } catch (error) {
        if (error === ALREADY_PRINTED) return { ...out, exitCode: 1 };
        if (error instanceof UsageError) {
            return { stdout: out.stdout, stderr: `${out.stderr}error: ${error.message}\n\nFor more information, try '--help'.\n`, exitCode: 2 };
        }
        return { stdout: out.stdout, stderr: `${out.stderr}Error: ${message(error)}\n`, exitCode: 1 };
    }
}

function message(error) {
    return typeof error === "string" ? error : String(error?.message ?? error);
}

// anyhow's `{:?}` of an error with context.
function withContext(context, error) {
    return `${context}\n\nCaused by:\n    ${message(error).replaceAll("\n", "\n    ")}`;
}

// ---------------------------------------------------------------------------
// `obelisk cloud`
// ---------------------------------------------------------------------------

function executeCloud(interp, args, stdin, cloud, out) {
    const { globals, rest } = cloudGlobals(args);
    const [group, sub] = rest;
    if (group === undefined || isHelpFlag(group)) return done(out, cloudHelp);
    if (group === "app" && (sub === undefined || isHelpFlag(sub))) return done(out, cloudAppHelp);
    if (group === "app" && APP_API_GROUPS.includes(sub)) {
        const commandArgs = rest.slice(2);
        if (commandArgs[0] === undefined || helpRequested(commandArgs)) return done(out, API_HELP[sub]);
        const app = appName(interp, globals.app);
        const api = {
            get: (path) => cloud.get(app, path),
            send: (method, path, contentType = null, body = null) => cloud.send(app, method, path, contentType, body),
        };
        const context = { interp, stdin, api, out, json: globals.json, verbose: globals.verbose };
        if (sub === "execution") executionCommand(context, commandArgs);
        else if (sub === "component") componentCommand(context, commandArgs);
        else if (sub === "deployment") deploymentCommand(context, commandArgs);
        else adminCommand(context, commandArgs);
        return { ...out, exitCode: 0 };
    }
    if (group === "app" && sub === "deploy") {
        if (helpRequested(rest)) return done(out, cloudAppHelp);
        cloudDeploy(interp, rest.slice(2), globals, cloud, out);
        return { ...out, exitCode: 0 };
    }
    if (helpRequested(rest)) return done(out, group === "app" ? cloudAppHelp : cloudHelp);
    return cloudRun(interp, args, stdin, cloud, globals);
}

function done(out, stdout) {
    return { ...out, stdout: out.stdout + stdout, exitCode: 0 };
}

// `--app`, `--json` and `--verbose` are global: accepted anywhere before `--`.
function cloudGlobals(args) {
    const globals = { app: undefined, json: false, verbose: false };
    const rest = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--") {
            rest.push(...args.slice(i));
            break;
        }
        if (arg === "--json") globals.json = true;
        else if (arg === "--verbose") globals.verbose = true;
        else if (arg === "--app") {
            globals.app = args[++i];
            if (globals.app === undefined) throw new UsageError("a value is required for '--app <NAME>' but none was supplied");
        } else if (arg.startsWith("--app=")) globals.app = arg.slice("--app=".length);
        else if (["--api-url", "--api-token", "--apps-domain"].includes(arg.split("=")[0])) {
            throw `${arg.split("=")[0]} is not supported here; the cloud comes from OBELISK_CLOUD_API_URL, OBELISK_CLOUD_API_TOKEN and OBELISK_CLOUD_APPS_DOMAIN`;
        } else rest.push(arg);
    }
    return { globals, rest };
}

// A variable the shell exported, like the real CLI's process environment.
function exportedVar(interp, name) {
    return interp.exported.has(name) ? interp.vars.get(name) : undefined;
}

function exportedEnv(interp) {
    return [...interp.exported].filter((name) => interp.vars.get(name) !== undefined).map((name) => [name, interp.vars.get(name)]);
}

// PORT: cloud.rs's `app_name`: `--app`, else OBELISK_APP_NAME, else `app_name` in ./app.toml.
function appName(interp, flag) {
    const name = flag ?? exportedVar(interp, "OBELISK_APP_NAME");
    if (name !== undefined) return name;
    const policy = readPolicy(interp, APP_POLICY_FILE);
    if (policy === null) {
        throw "Select an app with --app, OBELISK_APP_NAME or app_name in ./app.toml\n\nCaused by:\n    Cannot read policy app.toml: No such file or directory";
    }
    const configured = parsePolicy(policy, APP_POLICY_FILE).app_name;
    if (typeof configured !== "string") throw "Set app_name in ./app.toml, --app or OBELISK_APP_NAME";
    return configured;
}

function parsePolicy(text, path) {
    try {
        return parseToml(text);
    } catch (error) {
        throw withContext(`Invalid policy ${path}`, error);
    }
}

function readPolicy(interp, path) {
    const resolved = interp.resolvePath(path);
    if (interp.vfs.exists(resolved) && !interp.vfs.isDir(resolved)) return interp.vfs.readFile(resolved);
    return null;
}

// Provisioner commands, run by the `cloud.run` activity with the policy text,
// OBELISK_APP_NAME as `--app`, and the exported variables for `fill`.
function cloudRun(interp, args, stdin, cloud, globals) {
    const forwarded = [];
    let input = stdin ?? "";
    let appConfig = null;
    let fill = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--from-env") {
            const name = args[++i];
            if (name === undefined) throw new UsageError("a value is required for '--from-env <FROM_ENV>' but none was supplied");
            const value = exportedVar(interp, name);
            if (value === undefined) throw `environment variable ${name} is not set`;
            input = value;
            forwarded.push("--stdin");
            continue;
        }
        if (arg === "-a" || arg === "--app-config") appConfig = args[i + 1];
        if (arg.startsWith("--app-config=")) appConfig = arg.slice("--app-config=".length);
        if (arg === "--fill-non-interactive" || arg === "--non-interactive") fill = true;
        forwarded.push(arg);
    }
    const envApp = exportedVar(interp, "OBELISK_APP_NAME");
    if (args[0] === "app" && globals.app === undefined && envApp !== undefined) forwarded.push("--app", envApp);
    const policy = readPolicy(interp, appConfig ?? APP_POLICY_FILE);
    if (appConfig !== null && policy === null) throw `Cannot read policy ${appConfig}: No such file or directory`;
    const output = cloud.run(forwarded, input, policy, fill ? exportedEnv(interp) : null);
    return { stdout: output.stdout, stderr: output.stderr, exitCode: output.exitCode };
}

// PORT: obelisk's src/command/cloud/deploy.rs. `prepareDeploy` stages or
// creates the app, the deployment is enqueued on the app's API here, then
// `finishDeploy` fills and applies.
function cloudDeploy(interp, args, globals, cloud, out) {
    const { opts } = parseOptions(args, {
        "-a": "--app-config", "--app-config": true, "-d": "--deployment", "--deployment": true,
        "--fill": false, "--fill-non-interactive": false,
    }, []);
    if (opts["--fill"] && opts["--fill-non-interactive"]) {
        throw new UsageError("the argument '--fill' cannot be used with '--fill-non-interactive'");
    }
    const configPath = opts["--app-config"] ?? APP_POLICY_FILE;
    const policy = readPolicy(interp, configPath);
    if (policy === null) throw `Cannot read policy ${configPath}: No such file or directory`;
    const name = globals.app ?? exportedVar(interp, "OBELISK_APP_NAME") ?? parsePolicy(policy, configPath).app_name;
    if (typeof name !== "string") throw "Set app_name in ./app.toml, --app or OBELISK_APP_NAME";
    if (opts["--fill"]) throw "`--fill` requires a terminal; use `--fill-non-interactive` to read same-named environment variables";
    const prepared = prepareManifest(interp, opts["--deployment"] ?? "deployment.toml");
    const fillEnv = opts["--fill-non-interactive"] ? exportedEnv(interp) : null;
    const activity = (call) => {
        try {
            return call();
        } catch (error) {
            out.stderr += `${message(error)}\n`;
            throw ALREADY_PRINTED;
        }
    };
    const target = activity(() => cloud.prepareDeploy(name, policy, fillEnv));
    out.stderr += `${target.log}→ obelisk cloud app deployment enqueue\n`;
    const context = {
        interp, out, verbose: globals.verbose,
        api: {
            get: (path) => cloud.get(name, path),
            send: (method, path, contentType = null, body = null) => cloud.send(name, method, path, contentType, body),
        },
    };
    let id;
    try {
        id = submitPrepared(context, prepared, true, null, null);
        switchDeployment(context, id, true, "enqueue");
    } catch (error) {
        throw withContext(`Deployment staging failed; inspect \`obelisk cloud app --app ${name} status\` and retry deploy`, error);
    }
    const deployed = activity(() => cloud.finishDeploy(name, policy, id, target.revision, target.created, fillEnv));
    out.stderr += deployed.log;
    const row = deployed.app;
    if (globals.json) {
        out.stdout += `${prettyJson({ app: row, deployment_id: id, outcomes: row.outcome === undefined ? [] : [row.outcome] })}\n`;
    } else {
        out.stderr += `Deployed ${name}\n`;
        if (typeof row.webhook_url === "string") out.stdout += `${row.webhook_url}\n`;
    }
}

// ---------------------------------------------------------------------------
// App API: shared helpers
// ---------------------------------------------------------------------------

// reqwest's `StatusCode` display.
const REASONS = {
    200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 400: "Bad Request", 401: "Unauthorized",
    403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed", 406: "Not Acceptable", 408: "Request Timeout",
    409: "Conflict", 413: "Payload Too Large", 415: "Unsupported Media Type", 422: "Unprocessable Entity",
    429: "Too Many Requests", 500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable",
    504: "Gateway Timeout",
};

function statusLine(status) {
    return REASONS[status] ? `${status} ${REASONS[status]}` : String(status);
}

function success(response) {
    return response.status >= 200 && response.status < 300;
}

// PORT: client.rs's `send_json`/`send_empty`/`send_bytes`.
function checked(response) {
    if (!success(response)) throw `server returned ${statusLine(response.status)}: ${response.body}`;
    return response;
}

function parseBody(response) {
    try {
        return JSON.parse(response.body);
    } catch (error) {
        throw `error decoding response body: ${error.message}`;
    }
}

function getJson(api, path) {
    return parseApiResponse("GET", path, parseBody(checked(api.get(path))));
}

function sendJson(api, method, path, value) {
    return checked(api.send(method, path, value === undefined ? null : "application/json", value === undefined ? null : JSON.stringify(value)));
}

function query(params) {
    const parts = [];
    for (const [key, value] of params) {
        if (value === undefined || value === null) continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

function prettyJson(value) {
    return JSON.stringify(value, null, 2);
}

// output.rs's `print_json`/`print_ndjson`/`print_value`.
function printJson(out, value) {
    out.stdout += `${prettyJson(value)}\n`;
}

function printNdjson(out, value) {
    out.stdout += `${JSON.stringify(value)}\n`;
}

function printValue(out, value, json) {
    out.stdout += json ? `${prettyJson(value)}\n` : `${value}\n`;
}

// Parse a subcommand's arguments. `spec` maps each flag to `true` (takes a
// value), `false` (boolean) or the long flag it abbreviates; `names` are the
// positional value names, a trailing `...` one collecting the rest.
function parseOptions(args, spec, names) {
    const opts = {};
    const positionals = [];
    let dashdash = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (!dashdash && arg === "--") {
            dashdash = true;
            continue;
        }
        if (dashdash || !arg.startsWith("-") || arg === "-") {
            positionals.push(arg);
            continue;
        }
        const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
        let name = eq === -1 ? arg : arg.slice(0, eq);
        if (typeof spec[name] === "string") name = spec[name];
        if (spec[name] === undefined) throw new UsageError(`unexpected argument '${arg}' found`);
        if (spec[name] === true) {
            const value = eq === -1 ? args[++i] : arg.slice(eq + 1);
            if (value === undefined) throw new UsageError(`a value is required for '${name} <${valueName(name)}>' but none was supplied`);
            opts[name] = value;
        } else {
            if (eq !== -1) throw new UsageError(`unexpected value '${arg.slice(eq + 1)}' for '${name}' found; no more were expected`);
            opts[name] = true;
        }
    }
    const variadic = names.length > 0 && names[names.length - 1].endsWith("...");
    if (!variadic && positionals.length > names.length) throw new UsageError(`unexpected argument '${positionals[names.length]}' found`);
    return { opts, positionals };
}

function valueName(flag) {
    return flag.replace(/^-+/, "").replaceAll("-", "_").toUpperCase();
}

function requiredArg(value, name) {
    if (value === undefined) throw new UsageError(`the following required arguments were not provided:\n  <${name}>`);
    return value;
}

function integer(opts, flag, fallback) {
    const raw = opts[flag];
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) throw new UsageError(`invalid value '${raw}' for '${flag} <${valueName(flag)}>': invalid digit found in string`);
    return Number(raw);
}

// chrono's `Display` of a `DateTime<Utc>` from its RFC 3339 serialization.
function displayTime(value) {
    return typeof value === "string" ? value.replace("T", " ").replace(/Z$/, " UTC") : String(value);
}

function pascal(snake) {
    return String(snake).split("_").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function capitalize(value) {
    return value.charAt(0).toUpperCase() + value.slice(1);
}

// A Crockford base32 ULID, as in `ExecutionId::generate`.
function ulid() {
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let time = Date.now();
    let id = "";
    for (let i = 0; i < 10; i++) {
        id = alphabet[time % 32] + id;
        time = Math.floor(time / 32);
    }
    for (let i = 0; i < 16; i++) id += alphabet[Math.floor(Math.random() * 32)];
    return id;
}

// One poll interval of a follow loop; true when the shell was interrupted.
function pollWait(interp) {
    if (interp.watcher) {
        const { interrupted } = interp.watcher.sleep(1000);
        if (interrupted && interp.interrupted === null) interp.interrupted = interrupted;
        return Boolean(interrupted);
    }
    interp.sleepFn(1000);
    return false;
}

// ---------------------------------------------------------------------------
// Display ports of obelisk's concepts types
// ---------------------------------------------------------------------------

// web_api_server.rs's `format_execution_status_text`.
function statusText(state) {
    switch (state?.status) {
        case "locked": return "Locked";
        case "pending_at": return `Pending at ${displayTime(state.scheduled_at)}`;
        case "blocked_by_join_set": return `Blocked by ${state.join_set_id}${state.closing ? " (closing)" : ""}`;
        case "paused": return "Paused";
        case "cancelling": return "Cancelling";
        case "finished": return `Finished: ${finishedKind(state.result_kind)}`;
        default: return JSON.stringify(state);
    }
}

function finishedKind(kind) {
    if (kind === "ok") return "OK";
    if (kind?.err === "error") return "Error";
    if (kind?.err?.execution_failure !== undefined) return `Execution failure (${pascal(kind.err.execution_failure)})`;
    return JSON.stringify(kind);
}

// `PendingState`'s `Display`.
function pendingStateDisplay(state) {
    switch (state?.status) {
        case "locked": return lockedDisplay(state);
        case "pending_at": return `PendingAt(${pendingAtDisplay(state)})`;
        case "blocked_by_join_set": return `BlockedByJoinSet(${blockedDisplay(state)})`;
        case "paused": return `Paused(${wrappedStateDisplay(state)})`;
        case "cancelling": return `Cancelling(${wrappedStateDisplay(state)})`;
        case "finished": return `Finished: ${finishedKind(state.result_kind)}`;
        default: return JSON.stringify(state);
    }
}

function lockedDisplay(locked) {
    return `Locked(\`${displayTime(locked.lock_expires_at)}\`, ${locked.locked_by?.executor_id}, ${locked.locked_by?.run_id})`;
}

function pendingAtDisplay(pending) {
    const lock = pending.last_lock
        ? `Some(LockedBy { executor_id: ${pending.last_lock.executor_id}, run_id: ${pending.last_lock.run_id} })`
        : "None";
    return `\`${displayTime(pending.scheduled_at)}\`, last_lock=${lock}`;
}

function blockedDisplay(blocked) {
    return `${blocked.join_set_id}, \`${displayTime(blocked.lock_expires_at)}\`, closing=${blocked.closing}`;
}

// `PendingStatePaused`/`PendingStateCancelling`, externally tagged inside the state.
function wrappedStateDisplay(state) {
    if (state.Locked) return `Locked(${lockedDisplay(state.Locked)})`;
    if (state.PendingAt) return `PendingAt(${pendingAtDisplay(state.PendingAt)})`;
    if (state.BlockedByJoinSet) return `BlockedByJoinSet(${blockedDisplay(state.BlockedByJoinSet)})`;
    return JSON.stringify(state);
}

// `SupportedFunctionReturnValue`'s `Display`.
function retvalDisplay(retval) {
    if (retval && "ok" in retval) return "completed successfully";
    if (retval && "err" in retval) return "Error";
    if (retval?.execution_failure) return `Execution failure (${pascal(retval.execution_failure.kind)})`;
    return JSON.stringify(retval);
}

function componentIdDisplay(id) {
    return `${id?.component_type}:${id?.name}:${id?.component_digest}`;
}

// `ExecutionRequest`'s `Display`.
function executionRequestDisplay(request) {
    if (typeof request === "string") {
        return { paused: "Paused", unpaused: "Unpaused", cancellation_requested: "CancellationRequested" }[request] ?? request;
    }
    const [kind, value] = Object.entries(request ?? {})[0] ?? [];
    switch (kind) {
        case "created": return `Created(${value.ffqn}, \`${displayTime(value.scheduled_at)}\`)`;
        case "locked": return `Locked(\`${displayTime(value.lock_expires_at)}\`, ${componentIdDisplay(value.component_id)})`;
        case "unlocked": return `Unlocked(${value.reason}, pending at ${displayTime(value.backoff_expires_at)})`;
        case "component_upgrade_finished": return `ComponentUpgradeFinished(${value.component_digest})`;
        case "temporarily_failed": return `TemporarilyFailed(\`${displayTime(value.backoff_expires_at)}\`)`;
        case "temporarily_timed_out": return `TemporarilyTimedOut(\`${displayTime(value.backoff_expires_at)}\`)`;
        case "finished": return `Finished: ${retvalDisplay(value.retval)}`;
        case "history_event": return `HistoryEvent(${historyEventDisplay(value.event)})`;
        default: return JSON.stringify(request);
    }
}

function historyEventDisplay(event) {
    switch (event?.type) {
        case "persist": return "Persist";
        case "join_set_create": return `JoinSetCreate(${event.join_set_id})`;
        case "join_set_request": return `JoinSetRequest(${joinSetRequestDisplay(event.request)})`;
        case "join_next": return `JoinNext(${event.join_set_id})`;
        case "join_next_try": return `JoinNextTry(${event.join_set_id}, ${event.outcome})`;
        case "join_next_too_many": return `JoinNextTooMany(${event.join_set_id})`;
        case "schedule": return `Schedule(${event.execution_id}, ${scheduleAtDisplay(event.schedule_at)})`;
        case "stub": return `Stub(${event.target_execution_id})`;
        default: return JSON.stringify(event);
    }
}

function joinSetRequestDisplay(request) {
    if (request?.type === "delay_request") {
        return `DelayRequest(${request.delay_id}, expires_at: \`${displayTime(request.expires_at)}\`, schedule_at: \`${scheduleAtDisplay(request.schedule_at)}\`)`;
    }
    if (request?.type === "child_execution_request") {
        return `ChildExecutionRequest(${request.child_execution_id}, ${request.target_ffqn}, params: ${JSON.stringify(request.params)})`;
    }
    return JSON.stringify(request);
}

// `HistoryEventScheduleAt`'s `Display`; `In` shows the duration like Rust's `Debug`.
function scheduleAtDisplay(at) {
    if (at === "now") return "Now";
    if (at?.at !== undefined) return `At(\`${displayTime(at.at)}\`)`;
    if (at?.in !== undefined) {
        const secs = (at.in.secs ?? 0) + (at.in.nanos ?? 0) / 1e9;
        return `In(${secs >= 1 || secs === 0 ? `${secs}s` : secs >= 1e-3 ? `${secs * 1e3}ms` : `${secs * 1e6}µs`})`;
    }
    return JSON.stringify(at);
}

function joinSetResponseDisplay(response) {
    if (response?.type === "delay_finished") {
        return `delay ${response.result && "Ok" in response.result ? "finished" : "cancelled"}: ${response.delay_id}`;
    }
    if (response?.type === "child_execution_finished") return `${retvalDisplay(response.result)}: ${response.child_execution_id}`;
    return JSON.stringify(response);
}

// execution.rs's `format_execution_failure`.
function executionFailureDisplay(failure) {
    let text = `Execution failure (${pascal(failure.kind)})`;
    if (failure.reason !== undefined && failure.reason !== null) text += `: \`${failure.reason}\``;
    if (failure.detail !== undefined && failure.detail !== null) text += `\n${failure.detail}`;
    return text;
}

// ---------------------------------------------------------------------------
// `execution` (PORT: obelisk's src/command/execution.rs)
// ---------------------------------------------------------------------------

const LOG_LEVELS = {
    off: [], trace: ["trace", "debug", "info", "warn", "error"], debug: ["debug", "info", "warn", "error"],
    info: ["info", "warn", "error"], warn: ["warn", "error"], error: ["error"],
};

function executionCommand(context, [action, ...args]) {
    const { api, out } = context;
    const json = (opts) => context.json || opts["--json"] === true;
    switch (action) {
        case "list": {
            const { opts } = parseOptions(args, {
                "--ffqn": true, "-e": "--execution-id", "--execution-id": true, "--show-derived": false,
                "--hide-finished": false, "--limit": true, "-j": "--json", "--json": false,
            }, []);
            const executions = getJson(api, `/v1/executions${query([
                ["length", integer(opts, "--limit", 20)],
                ["ffqn_prefix", opts["--ffqn"]],
                ["execution_id_prefix", opts["--execution-id"]],
                ["show_derived", opts["--show-derived"] ? "true" : undefined],
                ["hide_finished", opts["--hide-finished"] ? "true" : undefined],
            ])}`);
            if (json(opts)) return printJson(out, executions);
            for (const execution of executions) {
                if (context.verbose) {
                    out.stderr += `${execution.execution_id} \`${pendingStateDisplay(execution.pending_state)}\` ${execution.ffqn} \`${displayTime(execution.first_scheduled_at)}\`\n`;
                } else {
                    const state = execution.pending_state;
                    const status = state?.status === "locked" ? "Running" : state?.status === "blocked_by_join_set" ? "Waiting" : statusText(state);
                    out.stderr += `${execution.execution_id} \`${status}\` ${execution.ffqn}\n`;
                }
            }
            return;
        }
        case "logs": {
            const { opts, positionals } = parseOptions(args, {
                "--show-derived": false, "--level": true, "--stream-type": true, "--show-run-id": false,
                "--after": true, "--follow": false, "--limit": true, "-j": "--json", "--json": false,
            }, ["EXECUTION_ID"]);
            const id = requiredArg(positionals[0], "EXECUTION_ID");
            const logs = logsOptions(opts["--level"] ?? "debug", opts["--stream-type"], opts["--show-derived"] === true, opts["--show-run-id"] === true, integer(opts, "--limit", 20));
            if (opts["--follow"]) return followLogs(context, id, logs, opts["--after"], json(opts));
            const items = fetchLogs(api, id, logs, null, opts["--after"]);
            printLogItems(out, items, json(opts), logs);
            return;
        }
        case "events": {
            const { opts, positionals } = parseOptions(args, { "--from": true, "--limit": true, "-j": "--json", "--json": false }, ["EXECUTION_ID"]);
            const id = requiredArg(positionals[0], "EXECUTION_ID");
            const from = opts["--from"] === undefined ? undefined : integer(opts, "--from");
            const response = getJson(api, `/v1/executions/${id}/events${query([
                ["length", integer(opts, "--limit", 20)],
                ...(from === undefined ? [["direction", "older"]] : [["version", from], ["including_cursor", "true"]]),
            ])}`);
            if (json(opts)) return printJson(out, response);
            for (const event of response.events) {
                out.stderr += `${event.version} \`${displayTime(event.created_at)}\` ${executionRequestDisplay(event.event)}\n`;
            }
            return;
        }
        case "responses": {
            const { opts, positionals } = parseOptions(args, { "--from": true, "--limit": true, "-j": "--json", "--json": false }, ["EXECUTION_ID"]);
            const id = requiredArg(positionals[0], "EXECUTION_ID");
            const from = opts["--from"] === undefined ? undefined : integer(opts, "--from");
            const response = getJson(api, `/v1/executions/${id}/responses${query([
                ["length", integer(opts, "--limit", 20)],
                ...(from === undefined ? [["direction", "older"]] : [["cursor", from], ["including_cursor", "true"]]),
            ])}`);
            if (json(opts)) return printJson(out, response);
            for (const { cursor, event } of response.responses) {
                out.stderr += `${cursor} \`${displayTime(event.created_at)}\` ${event.event.join_set_id} ${joinSetResponseDisplay(event.event.event)}\n`;
            }
            return;
        }
        case "submit": return submitExecution(context, args, json);
        case "stub": {
            const { positionals } = parseOptions(args, {}, ["EXECUTION_ID", "RETURN_VAL"]);
            const id = requiredArg(positionals[0], "EXECUTION_ID");
            const raw = requiredArg(positionals[1], "RETURN_VAL");
            let value;
            try {
                value = JSON.parse(raw);
            } catch (error) {
                throw withContext("return value must be valid JSON", error);
            }
            sendJson(api, "PUT", `/v1/executions/${id}/stub`, value);
            return;
        }
        case "status":
        case "get": {
            const { opts, positionals } = parseOptions(args, { "-f": "--follow", "--follow": false, "--no-reconnect": false, "-j": "--json", "--json": false }, ["EXECUTION_ID"]);
            const id = requiredArg(positionals[0], "EXECUTION_ID");
            if (opts["--no-reconnect"] && !opts["--follow"]) throw new UsageError("the following required arguments were not provided:\n  --follow");
            if (opts["--follow"]) return followStatus(context, id, json(opts), true);
            const status = getJson(api, `/v1/executions/${id}/status`);
            if (json(opts)) printJson(out, status);
            else out.stderr += `${statusText(status.pending_state)}\n`;
            return;
        }
        case "result": {
            const { opts, positionals } = parseOptions(args, { "-f": "--follow", "--follow": false, "--no-reconnect": false, "-j": "--json", "--json": false }, ["EXECUTION_ID"]);
            const id = requiredArg(positionals[0], "EXECUTION_ID");
            if (opts["--no-reconnect"] && !opts["--follow"]) throw new UsageError("the following required arguments were not provided:\n  --follow");
            return executionResult(context, id, opts["--follow"] === true, json(opts));
        }
        case "cancel": {
            const { opts, positionals } = parseOptions(args, { "--json": false }, ["ID"]);
            const path = idPath(requiredArg(positionals[0], "ID"), "cancel");
            const response = api.send("PUT", path, null, null);
            const body = parseBody(response);
            if (success(response)) return printOutcome(context, json(opts), body.ok, capitalize(body.ok));
            if (response.status === 409) return printOutcome(context, json(opts), body.err, capitalize(body.err));
            throw `server returned ${statusLine(response.status)}: ${body.err}`;
        }
        case "pause":
        case "unpause": {
            const { opts, positionals } = parseOptions(args, { "--json": false }, ["ID"]);
            checked(api.send("PUT", idPath(requiredArg(positionals[0], "ID"), action), null, null));
            return printOutcome(context, json(opts), `${action}d`, `${capitalize(action)}d`);
        }
        case "replay": {
            const { opts, positionals } = parseOptions(args, { "-j": "--json", "--json": false }, ["EXECUTION_ID"]);
            const response = replay(api, requiredArg(positionals[0], "EXECUTION_ID"));
            if (json(opts)) return printJson(out, response);
            out.stderr += `replayed_event_count: ${response.replayed_event_count}\nreplay_duration_ms: ${response.replay_duration_ms}\nreplay_version: ${response.replay_version}\n`;
            if (response.type === "advanceable") out.stderr += `outcome: advanceable, ${response.captured_writes.length} writes\n`;
            else if (response.type === "finished") out.stderr += `outcome: finished\nresult: ${JSON.stringify(response.retval)}\n`;
            else if (response.type === "blocked") out.stderr += "outcome: blocked\n";
            else if (response.type === "replay_failed") {
                out.stderr += `outcome: replay_failed, error: ${response.error}, ${response.captured_writes.length} writes\n`;
                if (response.failure) out.stderr += `${executionFailureDisplay(response.failure)}\n`;
            }
            return;
        }
        case "persist-backtraces": {
            const { positionals } = parseOptions(args, {}, ["EXECUTION_ID"]);
            const id = requiredArg(positionals[0], "EXECUTION_ID");
            const response = parseBody(checked(api.send("PUT", `/v1/executions/${id}/backtrace/persist`, null, null)));
            out.stderr += `Persisted ${response.persisted_backtrace_count} backtraces\n`;
            return;
        }
        case "advance": return advanceExecution(context, args, json);
        case "upgrade": {
            const { opts, positionals } = parseOptions(args, { "--skip-determinism-check": false, "--json": false }, ["EXECUTION_ID"]);
            const id = requiredArg(positionals[0], "EXECUTION_ID");
            const summary = getJson(api, `/v1/executions/${id}/status`);
            let components;
            try {
                components = getJson(api, `/v1/components${query([["ffqn", summary.ffqn]])}`);
            } catch (error) {
                throw withContext("failed to list components", error);
            }
            if (components.length === 0) throw `no component in the active deployment exports \`${summary.ffqn}\``;
            if (components.length > 1) {
                throw `multiple components export \`${summary.ffqn}\`: [${components.map((c) => JSON.stringify(c.component_id.name)).join(", ")}]`;
            }
            const oldDigest = summary.component_digest;
            const newDigest = components[0].component_id.component_digest;
            if (oldDigest === newDigest) return printOutcome(context, json(opts), "already_up_to_date", `Already up to date (${oldDigest})`);
            out.stderr += `Upgrading from ${oldDigest} to ${newDigest}\n`;
            try {
                sendJson(api, "PUT", `/v1/executions/${id}/upgrade`, { old: oldDigest, new: newDigest, skip_determinism_check: opts["--skip-determinism-check"] === true });
            } catch (error) {
                throw withContext("upgrade failed", error);
            }
            return printOutcome(context, json(opts), "upgraded", "Upgraded");
        }
        default:
            throw new UsageError(`unrecognized subcommand '${action}'`);
    }
}

function printOutcome(context, json, outcome, text) {
    if (json) printJson(context.out, { ok: outcome });
    else context.out.stderr += `${text}\n`;
}

// `ExecutionIdOrDelayId`: delays have their own routes.
function idPath(id, action) {
    if (id.startsWith("E_")) return `/v1/executions/${id}/${action}`;
    if (id.startsWith("Delay_")) return `/v1/delays/${id}/${action}`;
    throw new UsageError(`invalid value '${id}' for '<ID>': cannot parse \`${id}\` as an execution ID or a delay ID`);
}

function submitExecution(context, args, json) {
    const { api, out, interp, stdin } = context;
    const { opts, positionals } = parseOptions(args, {
        "-e": "--execution-id", "--execution-id": true, "-f": "--follow", "--follow": false, "--follow-logs": false,
        "--no-reconnect": false, "--paused": false, "-j": "--json", "--json": false,
    }, ["FUNCTION", "parameters..."]);
    const target = requiredArg(positionals[0], "FUNCTION");
    const params = parseParams(interp, positionals.slice(1), stdin, args[args.length - 2] === "--");
    const asJson = json(opts);
    const followLogsEnabled = opts["--follow-logs"] === true;
    const follow = opts["--follow"] === true || followLogsEnabled;
    let ffqn = target;
    if (target.startsWith(".../")) {
        const [ifcName, functionName, extra] = target.slice(4).split(".");
        if (functionName === undefined || extra !== undefined) throw new UsageError(`invalid value '${target}' for '<FUNCTION>'`);
        const components = getJson(api, `/v1/components${query([["exports", "true"], ["extensions", "false"]])}`);
        const matched = components.flatMap((component) => component.exports ?? []).map((fn) => fn.ffqn).filter((candidate) => {
            const dot = candidate.lastIndexOf(".");
            const ifc = candidate.slice(candidate.indexOf("/") + 1, dot).split("@")[0];
            return candidate.slice(dot + 1) === functionName && ifc === ifcName;
        });
        if (matched.length === 0) throw "no matching function found";
        if (matched.length > 1) throw `more than one matching function found: [${matched.join(", ")}]`;
        ffqn = matched[0];
        if (!asJson) out.stderr += `Matched ${ffqn}\n`;
    }
    const id = opts["--execution-id"] ?? `E_${ulid()}`;
    const response = api.send("PUT", `/v1/executions/${id}`, "application/json", JSON.stringify({ ffqn, params, paused: opts["--paused"] === true }));
    if (!success(response)) throw `server returned ${statusLine(response.status)}: ${response.body}`;
    const body = parseBody(response);
    if (asJson) {
        if (follow) printNdjson(out, body);
        else printJson(out, body);
    } else {
        out.stdout += `${body.ok}\n`;
    }
    if (followLogsEnabled) {
        followLogs(context, id, logsOptions("debug", undefined, false, false, 20), undefined, asJson);
        printRetval(context, getJson(api, `/v1/executions/${id}?follow=false`), asJson, true);
    } else if (follow) {
        executionResult(context, id, true, asJson);
    }
}

// PORT: args.rs's `params::parse_params`.
function parseParams(interp, params, stdin, dashdash) {
    const readParam = (path, label) => {
        const resolved = interp.resolvePath(path);
        if (!interp.vfs.exists(resolved) || interp.vfs.isDir(resolved)) {
            throw `${label}parameter parsing failed: failed to read file '${path}': No such file or directory (os error 2)`;
        }
        return interp.vfs.readFile(resolved);
    };
    const jsonArray = (text) => {
        let value;
        try {
            value = JSON.parse(text);
        } catch (error) {
            throw `Invalid JSON array for parameters: ${error.message}`;
        }
        if (!Array.isArray(value)) throw "Parameter provided as JSON must be a JSON array.";
        return value;
    };
    if (params.length === 0) return [];
    if (params.length === 1 && params[0] === "-") return jsonArray(stdin ?? "");
    if (params.length === 1 && !dashdash) {
        return jsonArray(params[0].startsWith("@") ? readParam(params[0].slice(1), "") : params[0]);
    }
    return params.map((param, index) => {
        const text = param.startsWith("@") ? readParam(param.slice(1), `${index + 1}-th `) : param;
        try {
            return JSON.parse(text);
        } catch (error) {
            throw `cannot parse ${index + 1}-th parameter \`${text}\` as JSON -  ${error.message}`;
        }
    });
}

// Follow the status stream (`?follow=true`, read whole once it ends at the
// finished state), printing each status, NDJSON with `json`.
function followStatus(context, id, json, emit) {
    const response = checked(context.api.get(`/v1/executions/${id}/status?follow=true`));
    let finished = false;
    for (const frame of response.body.split("\n\n")) {
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data === undefined) continue;
        const status = JSON.parse(data.slice("data: ".length));
        if (emit) {
            if (json) printNdjson(context.out, status);
            else context.out.stderr += `${statusText(status.pending_state)}\n`;
        }
        if (status.pending_state?.status === "finished") {
            finished = true;
            break;
        }
    }
    if (!finished) throw "status stream ended before execution finished";
}

function executionResult(context, id, follow, json) {
    if (follow) followStatus(context, id, false, !json);
    printRetval(context, getJson(context.api, `/v1/executions/${id}?follow=false`), json, follow);
}

// execution.rs's `print_retval`; an error result exits 1 after printing.
function printRetval(context, result, json, streaming) {
    const { out } = context;
    if (json) {
        if (streaming) printNdjson(out, result);
        else printJson(out, result);
        return;
    }
    const value = (v) => (v === null || v === undefined ? "(no return value)" : JSON.stringify(v));
    if ("ok" in result) {
        out.stderr += `Execution finished: OK: ${value(result.ok)}\n`;
        return;
    }
    if ("err" in result) out.stderr += `Execution finished: Error: ${value(result.err)}\n`;
    else out.stderr += `Execution finished: ${executionFailureDisplay(result.execution_failed)}\n`;
    throw ALREADY_PRINTED;
}

function logsOptions(level, streamType, showDerived, showRunId, limit) {
    const levels = LOG_LEVELS[level];
    if (levels === undefined) throw new UsageError(`invalid value '${level}' for '--level <LEVEL>': Matching variant not found`);
    const streams = { undefined: ["stdout", "stderr"], stdout: ["stdout"], stderr: ["stderr"], none: [] }[streamType];
    if (streams === undefined) throw new UsageError(`invalid value '${streamType}' for '--stream-type <TYPE>': Matching variant not found`);
    if (levels.length === 0 && streams.length === 0) {
        throw "either `--level` must not be `off`, or `--stream-type` must not be `none`";
    }
    return { levels, streams, showDerived, showRunId, limit };
}

function fetchLogs(api, id, logs, cursor, after) {
    return getJson(api, `/v1/executions/${id}/logs${query([
        ["length", logs.limit],
        ["direction", "newer"],
        ["show_logs", logs.levels.length > 0 ? "true" : "false"],
        ...logs.levels.map((level) => ["level", level]),
        ["show_streams", logs.streams.length > 0 ? "true" : "false"],
        ...logs.streams.map((stream) => ["stream_type", stream]),
        ["show_derived", logs.showDerived ? "true" : undefined],
        ...(cursor === null ? [] : [["cursor", cursor], ["including_cursor", "false"]]),
        ["after", after],
    ])}`);
}

function printLogItems(out, items, json, logs) {
    for (const item of items) {
        if (json) {
            printNdjson(out, item);
            continue;
        }
        const prefix = `${logs.showRunId ? `${item.run_id} ` : ""}${logs.showDerived ? `${item.execution_id} ` : ""}`;
        if (item.type === "log") {
            out.stdout += `${displayTime(item.created_at)} [${item.level.padEnd(6)}] ${prefix}${item.message}\n`;
        } else {
            const payload = utf8Decode(base64Decode(item.payload ?? "") ?? []);
            out.stdout += `${displayTime(item.created_at)} [${item.stream_type.padEnd(6)}] ${prefix}${payload}\n`;
        }
    }
    return items.length === 0 ? null : items[items.length - 1].cursor;
}

// Poll for new entries until the execution has finished and none are left.
function followLogs(context, id, logs, after, json) {
    let cursor = null;
    for (;;) {
        const items = fetchLogs(context.api, id, logs, cursor, after);
        const last = printLogItems(context.out, items, json, logs);
        if (last !== null) cursor = last;
        const status = getJson(context.api, `/v1/executions/${id}/status`);
        if (status.pending_state?.status === "finished" && last === null) return;
        if (last === null && pollWait(context.interp)) throw "interrupted";
    }
}

// Accepts 409, whose body is the replay failure.
function replay(api, id) {
    const response = api.send("PUT", `/v1/executions/${id}/replay`, null, null);
    if (!success(response) && response.status !== 409) throw `server returned ${statusLine(response.status)}: ${response.body}`;
    try {
        return JSON.parse(response.body);
    } catch (error) {
        throw withContext("failed to decode replay response as JSON", error);
    }
}

function advanceExecution(context, args, json) {
    const { api, out } = context;
    const { opts, positionals } = parseOptions(args, {
        "-j": "--json", "--json": false, "--trim": true, "-p": "--pause-all", "--pause": "--pause-all", "--pause-all": false,
        "--pause-submitted-executions": false, "--pause-delays": false, "--force": false,
    }, ["EXECUTION_ID"]);
    const id = requiredArg(positionals[0], "EXECUTION_ID");
    const response = replay(api, id);
    if (response.type === "finished") throw "execution is already finished";
    if (response.type === "blocked") throw "execution is blocked";
    let writes = response.captured_writes;
    if (response.type === "replay_failed") {
        const diagnostic = response.failure ? executionFailureDisplay(response.failure) : response.error;
        if (!opts["--force"]) {
            throw `replay failed: ${diagnostic}, ${writes.length} captured writes available (use --force to advance with execution failure)`;
        }
        out.stderr += `Replay failed: ${diagnostic}. Advancing with --force to persist execution failure.\n`;
    }
    if (opts["--trim"] !== undefined) writes = writes.slice(0, integer(opts, "--trim"));
    if (opts["--pause-all"] || opts["--pause-submitted-executions"]) {
        for (const write of writes) {
            if (write.type === "append_batch_create_new_execution") for (const child of write.child_requests) child.paused = true;
        }
    }
    if (opts["--pause-all"] || opts["--pause-delays"]) {
        for (const write of writes) {
            const events = write.type === "append" ? [write.event] : ["append_batch", "append_batch_create_new_execution", "append_stub_response"].includes(write.type) ? write.events : [];
            for (const append of events) {
                const request = append.event?.history_event?.event?.request;
                if (append.event?.history_event?.event?.type === "join_set_request" && request?.type === "delay_request") request.paused = true;
            }
        }
    }
    const result = parseBody(sendJson(api, "PUT", `/v1/executions/${id}/advance`, { captured_writes: writes, persist_backtrace: true }));
    if (json(opts)) return printJson(out, result);
    if (result.type === "finished") out.stderr += `success:\n${prettyJson(result.value)}\n`;
    else out.stderr += `success, current state: ${pendingStateDisplay(result.pending_state)}\n`;
}

// ---------------------------------------------------------------------------
// `component` (PORT: obelisk's src/command/component.rs)
// ---------------------------------------------------------------------------

function componentCommand(context, [action, ...args]) {
    const { api, out } = context;
    if (action === "push" || action === "add") {
        throw `\`component ${action}\` needs an OCI registry and is not available in the sandbox; run it with the real obelisk CLI`;
    }
    if (action !== "list") throw new UsageError(`unrecognized subcommand '${action}'`);
    const { opts } = parseOptions(args, { "-i": "--imports", "--imports": false, "--json": false, "-e": "--extensions", "--extensions": false }, []);
    const components = getJson(api, `/v1/components${query([
        ["exports", "true"],
        ["imports", opts["--imports"] ? "true" : "false"],
        ["extensions", opts["--extensions"] ? "true" : "false"],
    ])}`);
    if (context.json || opts["--json"]) return printJson(out, components);
    const functions = (list) => (list ?? []).map((fn) =>
        `\t${fn.ffqn}: func(${fn.parameter_types.map((p) => `${p.name}: ${p.wit_type}`).join(", ")}) -> ${fn.return_type}\n`).join("");
    for (const { component_id: id, exports, imports } of components) {
        out.stderr += context.verbose ? `${id.name}\t${id.component_type}\t${id.component_digest}\n` : `${id.name}\t${id.component_type}\n`;
        out.stderr += `Exports:\n${functions(exports)}`;
        if (opts["--imports"]) out.stderr += `Imports:\n${functions(imports)}`;
        out.stderr += "\n";
    }
}

// ---------------------------------------------------------------------------
// `deployment` (PORT: obelisk's src/command/deployment.rs)
// ---------------------------------------------------------------------------

function deploymentCommand(context, [action, ...args]) {
    const { api, out, interp } = context;
    const json = (opts) => context.json || opts["--json"] === true;
    switch (action) {
        case "submit":
        case "enqueue":
        case "apply": {
            const spec = { "--empty": false, "--description": true, "--deployment-id": true, "--json": false };
            if (action !== "apply") spec["--allow-unavailable-runtime-config"] = false;
            const { opts, positionals } = parseOptions(args, spec, [action === "submit" ? "PATH" : "PATH|ID"]);
            if (opts["--empty"] && positionals.length > 0) {
                throw new UsageError(`the argument '--empty' cannot be used with '[${action === "submit" ? "PATH" : "PATH|ID"}]'`);
            }
            const source = opts["--empty"] ? null : positionals[0] ?? "deployment.toml";
            const allow = opts["--allow-unavailable-runtime-config"] === true;
            const id = submitDeployment(context, source, action === "submit" ? allow : action === "enqueue", opts["--description"] ?? null, opts["--deployment-id"] ?? null);
            if (action === "enqueue") switchDeployment(context, id, allow, "enqueue");
            if (action === "apply") switchDeployment(context, id, false, "apply");
            return printValue(out, id, json(opts));
        }
        case "list": {
            const { opts } = parseOptions(args, { "--json": false }, []);
            const deployments = getJson(api, "/v1/deployments");
            if (json(opts)) return printJson(out, deployments);
            if (deployments.length === 0) {
                out.stderr += "No deployments found.\n";
                return;
            }
            const status = (s) => ({ inactive: "Inactive", enqueued: "Enqueued", active: "Active" })[s] ?? String(s);
            const time = (t) => (typeof t === "string" ? t.replace("T", " ").slice(0, 19) : "");
            out.stderr += context.verbose
                ? `${"ID".padEnd(32)}  ${"STATUS".padEnd(12)}  ${"CREATED_AT".padEnd(19)}  ${"LAST_ACTIVE_AT".padEnd(19)}  DESCRIPTION\n`
                : `${"ID".padEnd(32)}  ${"STATUS".padEnd(12)}  DESCRIPTION\n`;
            for (const dep of deployments) {
                out.stderr += context.verbose
                    ? `${dep.deployment_id.padEnd(32)}  ${status(dep.status).padEnd(12)}  ${time(dep.created_at).padEnd(19)}  ${time(dep.last_active_at).padEnd(19)}  ${dep.description ?? ""}\n`
                    : `${dep.deployment_id.padEnd(32)}  ${status(dep.status).padEnd(12)}  ${dep.description ?? ""}\n`;
            }
            return;
        }
        case "active": {
            const { opts } = parseOptions(args, { "--json": false }, []);
            return printValue(out, getJson(api, "/v1/info").deployment_id, json(opts));
        }
        case "show": {
            const { opts, positionals } = parseOptions(args, { "--json": false }, ["ID", "FILE"]);
            const id = requiredArg(positionals[0], "ID");
            const file = positionals[1];
            if (file !== undefined && opts["--json"]) throw new UsageError("the argument '[FILE]' cannot be used with '--json'");
            const dep = getJson(api, `/v1/deployments/${id}?include_generated_metadata=true`);
            if (file !== undefined) {
                let rel;
                try {
                    rel = normalizeDeploymentPath(file);
                } catch (error) {
                    throw withContext(`invalid source path \`${file}\``, error);
                }
                const ref = dep.files.find((f) => f.path === rel);
                if (!ref) throw `deployment ${id} has no deployment-owned source file \`${rel}\``;
                out.stdout += fetchFile(api, ref.digest);
                return;
            }
            if (json(opts)) {
                let value;
                try {
                    value = parseToml(dep.deployment_toml);
                } catch (error) {
                    throw withContext("cannot parse stored deployment manifest", error);
                }
                return printJson(out, value);
            }
            out.stdout += dep.deployment_toml;
            return;
        }
        case "pull": {
            const { opts, positionals } = parseOptions(args, {
                "-o": "--output", "--output": true, "-f": "--force", "--force": false, "--include-generated-metadata": false,
            }, ["ID"]);
            const id = requiredArg(positionals[0], "ID");
            const dep = getJson(api, `/v1/deployments/${id}?include_generated_metadata=${opts["--include-generated-metadata"] === true}`);
            const output = opts["--output"] ?? ".";
            const dir = interp.resolvePath(output);
            if (interp.vfs.exists(dir) && !interp.vfs.isDir(dir)) {
                throw withContext(`cannot create output directory ${JSON.stringify(output)}`, "File exists (os error 17)");
            }
            interp.vfs.mkdirp(dir);
            const display = (rel) => JSON.stringify(output === "." ? `./${rel}` : `${output.replace(/\/+$/, "")}/${rel}`);
            const writable = (rel) => {
                const path = `${dir}/${rel}`;
                if (interp.vfs.isDir(path) || (!opts["--force"] && interp.vfs.exists(path))) {
                    throw withContext(`cannot open ${display(rel)} for writing${opts["--force"] ? "" : ", try using `--force`"}`, "File exists (os error 17)");
                }
                return path;
            };
            interp.vfs.writeFile(writable("deployment.toml"), dep.deployment_toml);
            // Source bytes are fetched on first read.
            const loader = (digest) => fetchFile(api, digest);
            for (const ref of dep.files) {
                let rel;
                try {
                    rel = normalizeDeploymentPath(ref.path);
                } catch (error) {
                    throw withContext(`refusing to write unsafe source path \`${ref.path}\``, error);
                }
                interp.vfs.registerLazyWithLoader(writable(rel), ref.digest, ref.size, loader);
            }
            const count = dep.files.length;
            out.stderr += `Wrote ${display("deployment.toml").slice(1, -1)} (${count} source file${count === 1 ? "" : "s"}) for deployment ${id}\n`;
            return;
        }
        case "verify":
            throw "`deployment verify` compiles components locally and is not available in the sandbox; `deployment submit` verifies on the server";
        default:
            throw new UsageError(`unrecognized subcommand '${action}'`);
    }
}

function fetchFile(api, digest) {
    try {
        return checked(api.get(`/v1/files/${digest}`)).body;
    } catch (error) {
        throw withContext(`cannot fetch deployment file \`${digest}\``, error);
    }
}

// An existing `Dep_` ID is returned as is; a manifest (or `--empty`) is submitted.
function submitDeployment(context, source, allow, description, deploymentId) {
    if (source !== null && /^Dep_[0-9A-HJKMNP-TV-Z]{26}$/.test(source)) {
        if (description !== null) throw "--description cannot be used with an existing deployment ID";
        if (deploymentId !== null) throw "--deployment-id cannot be used with an existing deployment ID source";
        return source;
    }
    const prepared = source === null ? { dir: context.interp.cwd, toml: "" } : prepareManifest(context.interp, source);
    return submitPrepared(context, prepared, allow, description, deploymentId);
}

// PORT: prepared.rs's `prepare_deployment_manifest_from_disk`: the manifest
// with every owned file's `content_digest` and generated `component_files`.
function prepareManifest(interp, path) {
    const resolved = interp.resolvePath(path);
    if (!interp.vfs.exists(resolved) || interp.vfs.isDir(resolved)) {
        throw withContext(`cannot read deployment manifest ${JSON.stringify(path)}`, interp.vfs.isDir(resolved) ? "Is a directory (os error 21)" : "No such file or directory (os error 2)");
    }
    const manifest = interp.vfs.readFile(resolved);
    let doc;
    try {
        doc = parseToml(manifest);
    } catch (error) {
        throw withContext("cannot parse deployment manifest as TOML", error);
    }
    for (const [section, components] of Object.entries(doc)) {
        if (!Array.isArray(components)) continue;
        for (const field of ["content_digest", "component_files"]) {
            if (components.some((component) => component && typeof component === "object" && field in component)) {
                throw `${section}.${field} is generated submission metadata; remove it from deployment.toml`;
            }
        }
    }
    const dir = parentDir(resolved);
    return { dir, toml: manifestWithDigests(interp.vfs, dir, manifestWithGeneratedFiles(interp.vfs, dir, manifest)) };
}

// Reuses the active deployment when its description and content are unchanged.
function submitPrepared(context, prepared, allow, description, deploymentId) {
    const { api, out } = context;
    if (deploymentId === null) {
        const response = api.get("/v1/info");
        if (response.status !== 404) {
            const activeId = parseServerInfoResponse(parseBody(checked(response))).deployment_id;
            const active = getJson(api, `/v1/deployments/${activeId}`);
            if ((active.description ?? null) === description && sameToml(active.deployment_toml, prepared.toml)) {
                out.stderr += `Deployment content unchanged; using ${activeId}\n`;
                return activeId;
            }
        }
    }
    const id = uploadAndSubmit(context, prepared, allow, description, deploymentId ?? `Dep_${ulid()}`);
    out.stderr += `Submitted as ${id}\n`;
    return id;
}

function sameToml(a, b) {
    try {
        return canonicalJson(parseToml(a)) === canonicalJson(parseToml(b));
    } catch {
        return false;
    }
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

// PORT: deployment.rs's `upload_and_submit_manifest`: a JSON submit, then each missing file
// uploaded via `PUT /v1/files/{digest}` and a resubmit; repeated if GC reclaimed an upload.
function uploadAndSubmit(context, prepared, allow, description, id) {
    const MAX_UPLOAD_ROUNDS = 3;
    for (let round = 0; ; round++) {
        const missing = submitAttempt(context.api, prepared, allow, description, id);
        if (missing === null) return id;
        if (round === MAX_UPLOAD_ROUNDS) {
            throw `server is still missing ${missing.length} file blob(s) after upload: ${missing.map((issue) => issue.digest).join(", ")}`;
        }
        for (const issue of missing) uploadFile(context, prepared, issue);
    }
}

function uploadFile(context, prepared, issue) {
    const path = `${prepared.dir}/${issue.path}`;
    if (issue.path === null || issue.path === undefined || !context.interp.vfs.exists(path)) {
        throw `server is missing ${issue.field_path} (${issue.digest}), which is not in the deployment tree`;
    }
    const content = context.interp.vfs.readFile(path);
    if (context.verbose) context.out.stderr += `Uploading ${issue.path} (${utf8Encode(content).length} bytes, ${issue.digest})\n`;
    const response = context.api.send("PUT", `/v1/files/${issue.digest}`, "application/octet-stream", content);
    if (!success(response)) throw `cannot upload ${issue.path}: server returned ${statusLine(response.status)}: ${response.body}`;
}

// One submit request: null when stored, else the missing-file issues.
function submitAttempt(api, prepared, allow, description, id) {
    const response = api.send("PUT", `/v1/deployments/${id}`, "application/json", JSON.stringify({
        deployment_toml: prepared.toml, description, allow_unavailable_runtime_config: allow,
    }));
    if (success(response)) return null;
    if (response.status === 409) {
        const detail = parseBody(response);
        const others = ["unexpected_files", "digest_mismatches", "oversized_files", "missing_digest_fields"];
        if (others.every((key) => (detail[key] ?? []).length === 0) && (detail.missing_files ?? []).length > 0) {
            return detail.missing_files.filter((issue) => issue.digest !== null && issue.digest !== undefined);
        }
        throw `deployment submit rejected: ${formatSubmitDetail(detail)}`;
    }
    let detail = null;
    try {
        detail = JSON.parse(response.body);
    } catch { /* not JSON */ }
    if (["missing_runtime_config", "unregistered_secrets"].includes(detail?.error)) {
        throw `deployment rejected by the server: ${missingRuntimeConfig(detail)}`;
    }
    throw `server returned ${statusLine(response.status)}: ${response.body}`;
}

function formatSubmitDetail(detail) {
    return [
        ...(detail.missing_digest_fields ?? []).map((i) => `missing content_digest at ${i.field_path}`),
        ...(detail.missing_files ?? []).map((i) => `missing file at ${i.field_path} (${i.message})`),
        ...(detail.unexpected_files ?? []).map((i) => `unexpected file ${i.field_path}`),
        ...(detail.digest_mismatches ?? []).map((m) => `digest mismatch for ${m.file.field_path}: supplied ${m.supplied_digest}, actual ${m.actual_digest}`),
        ...(detail.oversized_files ?? []).map((i) => `oversized file ${i.field_path}`),
    ].join("; ");
}

// config_prepass.rs's `MissingRuntimeConfigError` display, without the app.toml snippet.
function missingRuntimeConfig(detail) {
    const list = (names) => `\`${names.join("`, `")}\``;
    const findings = [];
    if ((detail.public_env ?? []).length > 0) findings.push(`environment variable(s) ${list(detail.public_env)} not declared in app.toml \`[public_env]\``);
    if ((detail.secrets ?? []).length > 0) findings.push(`secret(s) ${list(detail.secrets)} not registered in app.toml \`[secrets]\``);
    const lines = [];
    if (findings.length > 0) lines.push(`configuration references ${findings.join(" and ")}. Add them to app.toml, or remove the references`);
    if ((detail.unset_secrets ?? []).length > 0) {
        lines.push(`configuration requires optional secret(s) ${list(detail.unset_secrets)} whose app.toml \`[secrets]\` environment variables are unset. Set them and restart the server, or mark every reference to them in the component \`optional = true\``);
    }
    return lines.length > 0 ? lines.join("\n") : JSON.stringify(detail);
}

function switchDeployment(context, id, allow, command) {
    const response = parseDeploymentSwitchResponse(parseBody(sendJson(context.api, "PUT", `/v1/deployments/${id}/switch`, {
        allow_unavailable_runtime_config: allow, apply: command === "apply",
    })));
    const outcome = response.ok;
    if (command === "apply" && outcome === "switched") context.out.stderr += "Applied successfully.\n";
    else if (command === "apply" && outcome === "restart_required") throw "Could not apply immediately; deployment enqueued. Restart the server to apply.";
    else if (command === "enqueue" && outcome === "switched") context.out.stderr += "Deployment already active; it will remain active after restart.\n";
    else if (command === "enqueue" && outcome === "restart_required") context.out.stderr += "Deployment staged for cloud app apply.\n";
    else throw `unexpected outcome from server: ${outcome}`;
}

// ---------------------------------------------------------------------------
// `admin` (PORT: obelisk's src/command/admin.rs)
// ---------------------------------------------------------------------------

const FORCE_WARNING = "WARNING: forcibly deleting non-terminal execution trees whose roots do not belong to the active deployment\n";

function adminCommand(context, [group, action, ...args]) {
    const { api, out } = context;
    const result = (opts, value, text) => {
        if (context.json || opts["--json"]) printJson(out, value);
        else out.stderr += `${text}\n`;
    };
    const eventLine = (event) => `${String(event.created_at).replace(/Z$/, "+00:00")} ${event.level} ${event.code}: ${event.message}\n`;
    if (group === "node-run-id") {
        const { opts } = parseOptions([action, ...args].filter((arg) => arg !== undefined), { "--json": false }, []);
        const id = getJson(api, "/v1/info").node_run_id;
        out.stdout += context.json || opts["--json"] ? `"${id}"\n` : `${id}\n`;
        return;
    }
    if (group === "storage" && action === "show") {
        const { opts } = parseOptions(args, { "--json": false }, []);
        const r = getJson(api, "/v1/admin/storage");
        return result(opts, r, `database: ${r.database_bytes ?? "unknown"} bytes; executions: ${r.execution_count}; deployments: ${r.deployment_count}; system events: ${r.system_event_count}`);
    }
    if (group === "events" && action === "get") {
        const { opts, positionals } = parseOptions(args, { "--json": false }, ["EVENT_ID"]);
        const event = getJson(api, `/v1/admin/system-events/${requiredArg(positionals[0], "EVENT_ID")}`);
        if (context.json || opts["--json"]) printJson(out, event);
        else out.stderr += eventLine(event);
        return;
    }
    if (group === "events" && action === "list") {
        const { opts } = parseOptions(args, {
            "--node-run-id": true, "--level": true, "--code": true, "--from": true, "--to": true, "--limit": true, "--json": false,
        }, []);
        const response = getJson(api, `/v1/admin/system-events${query([
            ["node_run_id", opts["--node-run-id"]], ["level", opts["--level"]], ["code", opts["--code"]],
            ["created_from", opts["--from"]], ["created_to", opts["--to"]], ["limit", integer(opts, "--limit", 100)],
        ])}`);
        if (context.json || opts["--json"]) printJson(out, response);
        else for (const event of response.events) out.stderr += eventLine(event);
        return;
    }
    if (group === "events" && action === "retain") {
        const { opts } = parseOptions(args, { "--max-age": true, "--batch-size": true, "--json": false }, []);
        if (opts["--max-age"] === undefined) throw new UsageError("the following required arguments were not provided:\n  --max-age <MAX_AGE>");
        const r = parseBody(sendJson(api, "POST", "/v1/admin/system-events/retain", {
            max_age_seconds: retentionAge(opts["--max-age"]), batch_size: integer(opts, "--batch-size", 1000), dry_run: false,
        }));
        return result(opts, r, `${r.deleted} system event(s) deleted; has_more=${r.has_more}`);
    }
    if ((group === "executions" || group === "deployments") && action === "delete") {
        const executions = group === "executions";
        const { opts, positionals } = parseOptions(args, executions
            ? { "--force": false, "--json": false }
            : { "--delete-executions": false, "--force": false, "--json": false }, ["IDS..."]);
        if (positionals.length === 0) throw new UsageError(`the following required arguments were not provided:\n  <${executions ? "EXECUTION_IDS" : "DEPLOYMENT_IDS"}>...`);
        if (!executions && opts["--force"] && !opts["--delete-executions"]) throw new UsageError("the following required arguments were not provided:\n  --delete-executions");
        if (opts["--force"]) out.stderr += FORCE_WARNING;
        const json = context.json || opts["--json"];
        const results = [];
        for (const id of positionals) {
            out.stderr += executions ? `Deleting execution tree ${id}\n` : `Deleting deployment ${id}\n`;
            const params = executions
                ? [["force_non_terminal", opts["--force"] === true]]
                : [["delete_executions", opts["--delete-executions"] === true], ["force_non_terminal", opts["--force"] === true]];
            const r = parseBody(checked(api.send("DELETE", `/v1/admin/${group}/${id}${query(params)}`, null, null)));
            const state = r.deleted ? "deleted" : "already absent";
            if (!json) out.stderr += executions ? `${id}: ${state}\n` : `${id}: ${state} (${r.deleted_execution_trees} execution tree(s) deleted)\n`;
            results.push({ [executions ? "execution_id" : "deployment_id"]: id, ...r });
        }
        if (json) printJson(out, results);
        return;
    }
    if ((group === "executions" || group === "deployments") && action === "retain") {
        const executions = group === "executions";
        const { opts } = parseOptions(args, {
            "--count": true, "--max-age": true, "--batch-size": true, "--force": false, "--dry-run": false, "--json": false,
            ...(executions ? {} : { "--delete-executions": false }),
        }, []);
        if (opts["--count"] === undefined && opts["--max-age"] === undefined) throw new UsageError("the following required arguments were not provided:\n  --count <COUNT>");
        if (opts["--count"] !== undefined && opts["--max-age"] !== undefined) throw new UsageError("the argument '--count <COUNT>' cannot be used with '--max-age <MAX_AGE>'");
        if (!executions && opts["--force"] && !opts["--delete-executions"]) throw new UsageError("the following required arguments were not provided:\n  --delete-executions");
        if (opts["--force"]) out.stderr += FORCE_WARNING;
        const dryRun = opts["--dry-run"] === true;
        if (!dryRun) out.stderr += executions ? "Deleting execution trees outside the retention policy\n" : "Deleting inactive deployments outside the retention policy\n";
        const body = {
            retain_count: opts["--count"] === undefined ? null : integer(opts, "--count"),
            max_age_seconds: opts["--max-age"] === undefined ? null : retentionAge(opts["--max-age"]),
            batch_size: integer(opts, "--batch-size", 100),
            ...(executions ? {} : { delete_executions: opts["--delete-executions"] === true }),
            force_non_terminal: opts["--force"] === true,
            dry_run: dryRun,
        };
        const r = parseBody(sendJson(api, "POST", `/v1/admin/${group}/retain`, body));
        const verb = dryRun ? "would delete" : "deleted";
        return result(opts, r, executions
            ? `${r.deleted_execution_trees} execution tree(s) ${verb}; ${r.blocked_non_terminal} blocked; has_more=${r.has_more}`
            : `${r.deleted_deployments} deployment(s) ${verb}; ${r.blocked_by_execution_reference} referenced and ${r.blocked_non_terminal} non-terminal blocked; has_more=${r.has_more}`);
    }
    throw new UsageError(`unrecognized subcommand '${[group, action].filter((part) => part !== undefined).join(" ")}'`);
}

// args.rs's `parse_retention_age`, in seconds.
function retentionAge(value) {
    const match = /^(\d+)(.*)$/.exec(value);
    const invalid = (reason) => new UsageError(`invalid value '${value}' for '--max-age <MAX_AGE>': ${reason}`);
    if (!match || match[2] === "") throw invalid(match ? "duration must have a unit: s, m, h, or d" : "duration must start with a positive integer");
    const amount = Number(match[1]);
    if (amount === 0) throw invalid("duration must be greater than zero");
    const multiplier = { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
    if (multiplier === undefined) throw invalid("duration unit must be s, m, h, or d");
    return amount * multiplier;
}

// ---------------------------------------------------------------------------
// `generate`
// ---------------------------------------------------------------------------

// Written in place of the template's README.md, whose `obelisk server run` steps do not apply here.
function sandboxReadme(appName) {
    return `# ${appName}

\`obelisk cloud\` in this shell manages apps in the cloud. \`app.toml\` is this app's policy: it names
the app (\`app_name\`) and caps the hosts, secrets, environment variables, and exec activities any
deployment may use. Deploy from this directory:

\`\`\`sh
obelisk cloud app deploy
\`\`\`

This creates the app from \`app.toml\` when needed, enqueues \`deployment.toml\`, applies both, and
prints the webhook URL. Then inspect it with \`obelisk cloud app component list\` and
\`obelisk cloud app execution list\`.

To edit an existing app, run \`obelisk cloud app --app NAME deployment pull ID -o DIRECTORY\` (the
active ID is \`obelisk cloud app --app NAME deployment active\`) and edit the pulled files.
`;
}

// `generate deployment` echoes a template baked in at build time;
// `generate new` fetches the starter app from GitHub at `generate.obeliskVersion`.
function executeGenerate(interp, args, generate, out) {
    const [action, ...rest] = args;
    if (action === undefined || isHelpFlag(action)) {
        out.stdout += generateHelp;
        return;
    }
    if (helpRequested(rest)) {
        out.stdout += action === "new" ? generateNewHelp : action === "deployment" ? generateDeploymentHelp : generateHelp;
        return;
    }
    if (action === "deployment") {
        parseOptions(rest, {}, []);
        out.stdout += DEPLOYMENT_TEMPLATE.endsWith("\n") ? DEPLOYMENT_TEMPLATE : `${DEPLOYMENT_TEMPLATE}\n`;
        return;
    }
    if (action === "new") {
        const { opts, positionals } = parseOptions(rest, { "--template": true }, ["APP"]);
        out.stdout += generateNew(interp, positionals[0], opts["--template"], generate);
        return;
    }
    throw new UsageError(`unrecognized subcommand '${action}'`);
}

// PORT: real obelisk `generate new [NAME]`, except `--template` is required.
// The template is read from the `obelisk` repo at the operator-pinned
// `OBELISK_VERSION` ref, so it never drifts from the cloud's servers.
function generateNew(interp, name, template, generate) {
    if (!template) {
        const { ref, names } = listTemplates(generate);
        throw `generate new: --template is required; templates at ${TEMPLATE_OWNER}/${TEMPLATE_REPO}@${ref}: ${names.join(", ")}`;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(template) || template === "." || template === "..") {
        throw `generate new: invalid template name '${template}'`;
    }
    const appName = name !== undefined ? name : slugifyAppName(basename(interp.cwd));
    validateAppName(appName);
    const outputDir = name !== undefined ? interp.resolvePath(appName) : interp.cwd;
    if (name !== undefined && interp.vfs.exists(outputDir)) {
        throw `cannot create new app directory ${outputDir}: File exists`;
    }

    const templatePath = `${TEMPLATES_ROOT}/${template}`;
    const files = withTemplateRef(generate, templatePath, (repo) => {
        const collected = [];
        collectTemplateFiles(generate.githubContents, repo, templatePath, "", collected, appName);
        if (collected.length === 0) throw "contains no files";
        return collected;
    });
    files.push(["README.md", sandboxReadme(appName)]);
    for (const [relative] of files) {
        const path = `${outputDir}/${relative}`;
        if (interp.vfs.exists(path)) throw `cannot generate app: ${path} already exists`;
    }

    let stdout = "";
    for (const [relative, contents] of files) {
        const path = `${outputDir}/${relative}`;
        interp.vfs.writeFile(path, contents);
        stdout += `Generated ${JSON.stringify(path)}\n`;
    }
    return stdout;
}

function listTemplates(generate) {
    let ref = "";
    const names = withTemplateRef(generate, TEMPLATES_ROOT, (repo) => {
        ref = repo.ref;
        const entries = decodeJson(generate.githubContents("list", JSON.stringify({ ...repo, path: TEMPLATES_ROOT })));
        if (!Array.isArray(entries)) throw "list did not return a JSON array";
        return entries.filter((entry) => entry?.type === "dir").map((entry) => entry.name);
    });
    return { ref, names };
}

// Runs `fetch` at OBELISK_VERSION, retrying at TEMPLATE_FALLBACK_REF when that fails.
function withTemplateRef(generate, path, fetch) {
    const pinned = generate.obeliskVersion && generate.obeliskVersion !== "latest" ? generate.obeliskVersion : "";
    const refs = pinned && pinned !== TEMPLATE_FALLBACK_REF ? [pinned, TEMPLATE_FALLBACK_REF] : [TEMPLATE_FALLBACK_REF];
    const errors = [];
    for (const ref of refs) {
        try {
            return fetch({ owner: TEMPLATE_OWNER, repo: TEMPLATE_REPO, ref });
        } catch (error) {
            errors.push(`${TEMPLATE_OWNER}/${TEMPLATE_REPO}@${ref}:${path}: ${error}`);
        }
    }
    throw `cannot fetch the starter template from ${errors.join("; ")}`;
}

// Depth-first listing of the template tree; `relative` is the path under
// `root`, collected as `[relative file path, contents]`.
function collectTemplateFiles(githubContents, repo, root, relative, files, appName) {
    const remote = relative === "" ? root : `${root}/${relative}`;
    const entries = decodeJson(githubContents("list", JSON.stringify({ ...repo, path: remote })));
    if (!Array.isArray(entries)) throw "list did not return a JSON array";
    for (const entry of entries) {
        if (typeof entry?.name !== "string") throw `list entry without a name: ${JSON.stringify(entry)}`;
        const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
        if (entry.type === "dir") {
            collectTemplateFiles(githubContents, repo, root, child, files, appName);
        } else if (child !== "README.md") {
            const contents = githubContents("read", JSON.stringify({ ...repo, path: `${root}/${child}` }));
            files.push([child, child === APP_POLICY_FILE ? contents.replaceAll("__APP_NAME__", appName) : contents]);
        }
    }
}

// PORT: obelisk's `slugify_app_name`.
function slugifyAppName(name) {
    let slug = "";
    for (const character of name) {
        if (slug.length === 63) break;
        if (/^[A-Za-z0-9]$/.test(character)) {
            slug += character.toLowerCase();
        } else if (slug !== "" && !slug.endsWith("-")) {
            slug += "-";
        }
    }
    return slug.replace(/-+$/, "");
}

// PORT: obelisk's `validate_app_name`.
function validateAppName(name) {
    if (!/^[a-z0-9-]{1,63}$/.test(name) || name.startsWith("-") || name.endsWith("-")) {
        throw `invalid app name \`${name}\`: expected a DNS label (1-63 lowercase ASCII letters, digits, or interior hyphens)`;
    }
}

function decodeJson(text) {
    try {
        return JSON.parse(text);
    } catch (error) {
        throw `invalid JSON: ${error.message}`;
    }
}

function parentDir(path) {
    const idx = path.lastIndexOf("/");
    return idx <= 0 ? "/" : path.slice(0, idx);
}

function basename(path) {
    const trimmed = path.replace(/\/+$/, "");
    const idx = trimmed.lastIndexOf("/");
    return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function isHelpFlag(arg) {
    return arg === "-h" || arg === "--help";
}

// A help flag before any `--`.
function helpRequested(args) {
    const end = args.indexOf("--");
    return (end === -1 ? args : args.slice(0, end)).some(isHelpFlag);
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

const helpText = `Obelisk: deterministic workflow engine

Usage: obelisk <COMMAND>

Commands:
  cloud     Manage apps through the Obelisk cloud control plane
  generate  Generate configuration files and starter apps

\`obelisk server\` and the top-level app API commands are not available here; use
\`obelisk cloud app ...\`. Ask the user a question with \`ask-user QUESTION\`.
`;

const cloudHelp = `Manage apps through the Obelisk cloud control plane

Usage: obelisk cloud [OPTIONS] <COMMAND>

Commands:
  token  Inspect cloud bearer tokens (list, get ID)
  apps   List apps owned by the authenticated user (apps list)
  app    Manage an app and its deployments, executions and configuration

Options:
      --json        Print machine-readable JSON instead of human-readable output
      --verbose     Show detailed metadata and command diagnostics
      --app <NAME>  Selected cloud app; defaults to $OBELISK_APP_NAME, then app_name in ./app.toml
`;

const cloudAppHelp = `Manage an app and its deployments, executions and configuration

Usage: obelisk cloud app [--app <NAME>] <COMMAND>

Commands:
  deployment  Manage deployments through the selected app's API
  execution   Manage executions through the selected app's API
  component   Inspect components
  admin       Perform operator-only destructive maintenance on the selected app
  new         Create a stopped app; apply explicitly to start it
                [NAME] [-a APP_CONFIG] [--fill-non-interactive] [--command-id ID]
  get         Inspect the app row
  status      Inspect management, Machine and target API health
  stage       Stage app policy and cloud settings without restarting the VM [-a APP_CONFIG]
  deploy      Publish the local project, creating or configuring the app and activating its deployment
                [-a APP_CONFIG] [-d DEPLOYMENT] [--fill-non-interactive]
  apply       Apply the staged configuration and the enqueued (or active) deployment
                [-a APP_CONFIG | --staged] [--fill-non-interactive] [--force]
  reactivate  Reactivate the app
  deactivate  Deactivate the app
  delete      Delete the app
  fill        Stage declared env vars and secrets from same-named exported variables
                --non-interactive [-a APP_CONFIG | --staged]
  env         list | set NAME VALUE | unset NAME
  secrets     list | set NAME (--from-env VAR | --stdin) | unset NAME
  endpoint    Show all endpoints, or select api, webhook or webui

Run \`obelisk cloud app <COMMAND> --help\` for a command's subcommands.
`;

const executionHelp = `Manage executions through the selected app's API

Usage: obelisk cloud app execution <COMMAND>

Commands:
  list                List recent executions
                        [--ffqn PREFIX] [-e|--execution-id PREFIX] [--show-derived] [--hide-finished] [--limit 20] [-j]
  logs                Fetch structured logs for an execution
                        EXECUTION_ID [--show-derived] [--level trace|debug|info|warn|error|off] [--stream-type stdout|stderr|none]
                        [--show-run-id] [--after TIMESTAMP] [--follow] [--limit 20] [-j]
  events              Show the execution event log: EXECUTION_ID [--from VERSION] [--limit 20] [-j]
  responses           Show join-set responses: EXECUTION_ID [--from CURSOR] [--limit 20] [-j]
  submit              Submit a new execution: [-e ID] FUNCTION [PARAMS]... [-f] [--follow-logs] [--paused] [-j]
                        FUNCTION is \`ns:pkg/ifc.fn\` or \`.../ifc.fn\`. PARAMS: one JSON array ('["a", 1]'), @file.json,
                        \`-\` for stdin, or after \`--\` one JSON value (or @file) per argument; none for no parameters
  stub                Write a stubbed execution's return value: EXECUTION_ID RETURN_VAL_JSON
  status              Get an execution's current state (alias: get): EXECUTION_ID [-f] [-j]
  result              Get an execution's final result: EXECUTION_ID [-f] [-j]
  cancel              Cancel an activity or delay: ID [--json]
  pause               Pause a workflow execution or delay: ID [--json]
  unpause             Resume a paused execution or delay: ID [--json]
  replay              Replay a workflow, checking for non-determinism: EXECUTION_ID [-j]
  persist-backtraces  Replay a workflow and persist its call-site backtraces: EXECUTION_ID
  advance             Advance a paused workflow by its next captured writes
                        EXECUTION_ID [--trim N] [-p|--pause-all] [--pause-submitted-executions] [--pause-delays] [--force] [-j]
  upgrade             Upgrade a workflow to the active deployment's component: EXECUTION_ID [--skip-determinism-check] [--json]
`;

const componentHelp = `Inspect components

Usage: obelisk cloud app component <COMMAND>

Commands:
  list  List components: [-i|--imports] [-e|--extensions] [--json]
  push  Not available in the sandbox (needs an OCI registry)
  add   Not available in the sandbox (needs an OCI registry)
`;

const deploymentHelp = `Manage deployments through the selected app's API

Usage: obelisk cloud app deployment <COMMAND>

Commands:
  submit   Submit a deployment TOML; print the deployment ID
             [PATH (default deployment.toml) | --empty] [--allow-unavailable-runtime-config] [--description TEXT]
             [--deployment-id ID] [--json]
  enqueue  Submit and stage for cloud app apply
             [PATH|ID | --empty] [--allow-unavailable-runtime-config] [--description TEXT] [--deployment-id ID] [--json]
  apply    Submit (if a file is given) and apply immediately; fails if not possible
             [PATH|ID | --empty] [--description TEXT] [--deployment-id ID] [--json]
  list     List recent deployments [--json]
  active   Print the ID of the currently active deployment [--json]
  show     Show a deployment's manifest, one source FILE, or the manifest as JSON: ID [FILE] [--json]
  pull     Write a deployment's editable deployment.toml and source files (fetched on first read)
             ID [-o|--output DIR] [-f|--force] [--include-generated-metadata]

Submit, enqueue and apply reuse the active deployment when its content and description are unchanged.
Leave \`content_digest\` and \`component_files\` out of deployment.toml; they are generated on submit.
`;

const adminHelp = `Perform operator-only destructive maintenance on the selected app

Usage: obelisk cloud app admin <COMMAND>

Commands:
  executions delete IDS... [--force] [--json]
  executions retain (--count N | --max-age AGE) [--batch-size 100] [--force] [--dry-run] [--json]
  deployments delete IDS... [--delete-executions [--force]] [--json]
  deployments retain (--count N | --max-age AGE) [--delete-executions [--force]] [--batch-size 100] [--dry-run] [--json]
  events get EVENT_ID [--json]
  events list [--node-run-id ID] [--level L] [--code C] [--from RFC3339] [--to RFC3339] [--limit 100] [--json]
  events retain --max-age AGE [--batch-size 1000] [--json]
  storage show [--json]
  node-run-id [--json]

AGE is a positive integer with a unit: s, m, h or d.
`;

const API_HELP = { execution: executionHelp, component: componentHelp, deployment: deploymentHelp, admin: adminHelp };

const generateHelp = `Generate configuration files and starter apps

Usage: obelisk generate <COMMAND>

Commands:
  deployment  Print a default deployment.toml with every option documented
  new         Create a JS app from a template: --template NAME [APP]
`;

const generateNewHelp = `Usage: obelisk generate new --template NAME [APP]

Create a runnable JS starter app from the obelisk repository's
examples/templates/NAME at the operator's OBELISK_VERSION (falling back to main).
Run without --template to list the templates. With APP, the app is created in a
new APP directory; otherwise in the current directory, named after its slug.
The template's app.toml gets the app name; deploy with \`obelisk cloud app deploy\`.
`;

const generateDeploymentHelp = `Usage: obelisk generate deployment

Print a default deployment.toml with every option documented as comments.
Redirect it to a file to scaffold a new deployment, e.g.
\`obelisk generate deployment > deployment.toml\`.
`;

// ---------------------------------------------------------------------------
// TOML editor
//
// A hand-written, purpose-built editor scoped to exactly what
// `manifestWithGeneratedFiles`/`manifestWithDigests` need - not
// a general TOML parser (no bare npm dependency resolves in the deployed
// component, so a real TOML library is not an option). It works by locating byte ranges ("edits")
// to rewrite and applying them over the original text verbatim, so every
// other byte (comments, blank lines, unrelated keys, formatting, key
// ordering) survives untouched - a surgical value-level rewrite rather than
// a parse/mutate/re-serialize round trip.
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
    const byName = new Map();
    for (const block of blocks) {
        if (!byName.has(block.blockName)) byName.set(block.blockName, []);
        byName.get(block.blockName).push(block);
    }
    return [...byName.values()].flat();
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

// Pin each owned `location`'s `content_digest` from the file's current bytes
// (a missing file is left for the server to report).
export function manifestWithDigests(fs, dir, manifest) {
    const edits = [];
    for (const block of groupBlocks(findRegions(manifest))) {
        const locationAssign = findAssignment(manifest, block.root.start, block.root.end, "location");
        if (!locationAssign) continue;
        const location = unquoteString(manifest.slice(locationAssign.valueStart, locationAssign.valueEnd));
        if (location.startsWith("oci://")) continue;
        const digest = ownedSourceDigest(fs, `${dir}/${location}`);
        if (digest === null) continue;
        const insertAt = lastContentEnd(manifest, block.root.start, block.root.end);
        const needsNewline = insertAt > 0 && manifest[insertAt - 1] !== "\n";
        edits.push({ start: insertAt, end: insertAt, text: `${needsNewline ? "\n" : ""}content_digest = ${quoteString(digest)}\n` });
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
            } else if (!(specifier.startsWith("obelisk:") || (specifier.includes(":") && specifier.includes("/")))) {
                throw `unsupported bare module specifier ${JSON.stringify(specifier)} in ${path}`;
            }
        }
    }
    return files;
}

// Not a real tokenizer (no comment/string awareness), same "practical
// subset" tradeoff as the rest of this scanner. The `from` clause is bounded
// to the actual import/export grammar (`*`, `* as ns`, `{ ... }`, or a bare
// default identifier, optionally combined) rather than "any text", so an
// unrelated `export`/`import` keyword earlier in the file (e.g. `export
// default function foo() {...}`) can't lazily skip across the whole function
// body — comments included — to latch onto the next `from "..."` in the
// file.
function moduleSpecifiers(source) {
    const found = [];
    const clause = String.raw`(?:\*(?:\s+as\s+[\w$]+)?|\{[^{}]*\}|[\w$]+(?:\s*,\s*(?:\*\s+as\s+[\w$]+|\{[^{}]*\}))?)`;
    const patterns = [
        /\bimport\s*["']([^"']+)["']/g,
        new RegExp(String.raw`\b(?:import|export)\s+${clause}\s*from\s*["']([^"']+)["']`, "g"),
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

// The `content_digest` for a deployment-owned source at submit time: an
// unchanged file is still a lazy `pending` VFS entry and keeps its CAS
// digest; a changed or newly created file is re-hashed from the same
// string content `submitDeployment` transmits, so the server's re-hash
// matches. Returns null if the file is missing (or unreadable). A `pending`
// file whose digest isn't CAS-namespaced (e.g. a git/web mount's own foreign
// hash) is treated like a modified file instead: its bytes were never
// uploaded to this server's CAS under that digest, so it must be fetched and
// rehashed here rather than have the foreign hash reused as a bogus
// `content_digest`. An eager file's hash is computed at most once per
// unchanged path: `fs`'s content-digest cache (invalidated on write) covers
// both a path appearing more than once in one manifest pass (e.g. as both a
// `location` and a `component_files` entry) and repeat submits
// calls within the same session.
function ownedSourceDigest(fs, path) {
    const lazy = fs.lazyFileRef(path);
    if (lazy && isCasNamespacedDigest(lazy.digest)) {
        console.debug(`ownedSourceDigest(${path}): unchanged, reusing cached digest`);
        return lazy.digest;
    }
    const cached = fs.cachedContentDigest(path);
    if (cached !== null) {
        console.debug(`ownedSourceDigest(${path}): unchanged since last hash, reusing cached digest`);
        return cached;
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
    fs.cacheContentDigest(path, digest);
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
