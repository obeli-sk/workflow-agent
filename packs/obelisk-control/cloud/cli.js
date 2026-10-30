// obelisk-agent:tools/cloud.run:
//   func(args: list<string>, stdin: string, app-toml: option<string>,
//        fill-env: option<list<tuple<string, string>>>)
//     -> result<record { stdout: string, stderr: string, exit-code: u32 }, string>
//
// PORT: obelisk's src/command/cloud.rs. The provisioner half of `obelisk cloud`
// (apps, tokens, app lifecycle, env and secrets); the shell's `obelisk` command
// handles `app deploy` and the app API subcommands itself. `app-toml` is the
// policy file's text (`-a PATH`, else ./app.toml) when the shell found one;
// `fill-env` the shell's exported variables for `--fill-non-interactive`.
// Like the CLI, JSON goes to stdout and human output to stderr; errors exit 1,
// usage errors 2.
import { appApiGet, appEndpoints, appRequest, cloudRequest, stagedRevision } from "./client.js";
import { fillValues, initialValues, userSuppliedPolicy } from "./fill.js";
import { appConfig, configName, validateCloudAppName } from "./policy.js";
import { humanOutput, renderSummary } from "./output.js";

export default async function run(args, stdin, appToml, fillEnv) {
    const stderr = [];
    try {
        const parsed = parseArgs(args);
        const env = fillEnv ? Object.fromEntries(fillEnv) : null;
        const { stdout = "", stderr: human = "" } = await execute(parsed, stdin, appToml ?? null, env);
        return { stdout, stderr: stderr.join("") + human, exit_code: 0 };
    } catch (error) {
        if (error instanceof UsageError) {
            return { stdout: "", stderr: `error: ${error.message}\n\nFor more information, try '--help'.\n`, exit_code: 2 };
        }
        const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
        return { stdout: "", stderr: `${stderr.join("")}Error: ${message}\n`, exit_code: 1 };
    }
}

// A command-line error, reported like clap's.
export class UsageError extends Error {}

const VALUE_FLAGS = ["--app", "--command-id", "-a", "--app-config", "--from-env"];
const BOOLEAN_FLAGS = [
    "--json", "--verbose", "--force", "--stdin", "--staged", "--fill", "--fill-non-interactive", "--non-interactive",
];
const GLOBAL_FLAGS = ["--app", "--json", "--verbose"];

// Split argv into positionals and flags; flags may appear anywhere, like clap's globals.
export function parseArgs(args) {
    const positionals = [];
    const flags = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const eq = arg.indexOf("=");
        const name = arg.startsWith("--") && eq !== -1 ? arg.slice(0, eq) : arg;
        if (VALUE_FLAGS.includes(name)) {
            const value = eq !== -1 && name !== arg ? arg.slice(eq + 1) : args[++i];
            if (value === undefined) throw new UsageError(`a value is required for '${name} <VALUE>' but none was supplied`);
            flags[name === "--app-config" ? "-a" : name] = value;
        } else if (BOOLEAN_FLAGS.includes(arg)) {
            flags[arg] = true;
        } else if (["--api-url", "--api-token", "--apps-domain"].includes(name)) {
            throw `${name} is not supported here; the cloud comes from OBELISK_CLOUD_API_URL, OBELISK_CLOUD_API_TOKEN and OBELISK_CLOUD_APPS_DOMAIN`;
        } else if (arg.startsWith("-") && arg !== "-") {
            throw new UsageError(`unexpected argument '${arg}' found`);
        } else {
            positionals.push(arg);
        }
    }
    return { positionals, flags };
}

// Rejects flags the subcommand does not take.
function allow(flags, names) {
    for (const flag of Object.keys(flags)) {
        if (!GLOBAL_FLAGS.includes(flag) && !names.includes(flag)) {
            throw new UsageError(`unexpected argument '${flag === "-a" ? "--app-config" : flag}' found`);
        }
    }
}

function arity(rest, count) {
    if (rest.length > count) throw new UsageError(`unexpected argument '${rest[count]}' found`);
}

async function execute({ positionals, flags }, stdin, appToml, fillEnv) {
    const [group, ...rest] = positionals;
    const options = { verbose: flags["--verbose"] === true, commandId: flags["--command-id"] };
    const print = (value, summary) => {
        if (flags["--json"]) return { stdout: `${JSON.stringify(value, null, 2)}\n` };
        return { stderr: options.verbose ? humanOutput(value) : renderSummary(summary, value) };
    };
    if (group === "apps" && rest[0] === "list") {
        allow(flags, []);
        arity(rest, 1);
        return print(await cloudRequest("GET", ["v1", "apps"], options), { kind: "apps" });
    }
    if (group === "token") {
        allow(flags, []);
        return print(...(await tokenCommand(rest, options)));
    }
    if (group === "app") return appCommand(rest, flags, stdin, appToml, fillEnv, options, print);
    throw new UsageError(`unrecognized subcommand '${positionals.join(" ")}'`);
}

async function tokenCommand([action, id, ...extra], options) {
    if (action === "list") {
        arity([id], 0);
        return [await cloudRequest("GET", ["v1", "tokens"], options), { kind: "tokens" }];
    }
    if (action === "get") {
        if (id === undefined) throw new UsageError("the following required arguments were not provided:\n  <ID>");
        arity(extra, 0);
        return [await cloudRequest("GET", ["v1", "tokens", id], options), { kind: "token" }];
    }
    if (action === "new" || action === "revoke") {
        throw `\`cloud token ${action}\` is not available in the sandbox; run it with the real obelisk CLI`;
    }
    throw new UsageError(`unrecognized subcommand '${action ?? ""}'`);
}

const POLICY_COMMANDS = ["new", "status", "stage", "apply", "fill"];

async function appCommand([action, ...rest], flags, stdin, appToml, fillEnv, options, print) {
    const path = flags["-a"] ?? "app.toml";
    const explicit = flags["-a"] !== undefined;
    const config = appToml === null || (!POLICY_COMMANDS.includes(action) && explicit) ? null
        // Status only reports a readable discovered ./app.toml.
        : action === "status" && !explicit ? readableConfig(appToml, path) : appConfig(appToml, path);
    const command = { ...options, kind: "command" };
    const terminal = (flag) => `\`${flag}\` requires a terminal; use \`--fill-non-interactive\` to read same-named environment variables`;
    if (action === "new") {
        allow(flags, ["-a", "--fill", "--fill-non-interactive", "--command-id"]);
        arity(rest, 0);
        const name = appName(flags["--app"] ?? config?.appName, config);
        const local = configForApp(name, config, path, explicit, false);
        if ((flags["--fill"] || flags["--fill-non-interactive"]) && !local) throw "`--fill` requires an app config";
        const body = { app_name: name };
        if (local) {
            if (flags["--fill"] && !flags["--fill-non-interactive"]) throw terminal("--fill");
            const values = initialValues(userSuppliedPolicy(local), flags["--fill-non-interactive"] ? fillEnv ?? {} : null);
            Object.assign(body, { policy: local.policy, cloud: local.cloud, env: values.env, secrets: values.secrets });
        }
        return print(await cloudRequest("POST", ["v1", "apps"], { ...options, kind: "secret-command", body }), { kind: "app", message: "App created." });
    }
    const name = appName(flags["--app"] ?? config?.appName, config);
    const local = configForApp(name, config, path, explicit, action === "stage");
    const apply = flags["--app"] === undefined ? "obelisk cloud app apply" : `obelisk cloud app --app ${flags["--app"]} apply`;
    if (action === "get") {
        allow(flags, []);
        arity(rest, 0);
        return print(await appRequest(name, "GET", [], options), { kind: "app" });
    }
    if (action === "status") {
        allow(flags, ["-a"]);
        arity(rest, 0);
        const value = await appRequest(name, "GET", ["status"], options);
        if (local) {
            let comparison = null;
            let error = null;
            try { comparison = await compareConfig(name, desiredConfig(local), options); }
            catch (e) { error = typeof e === "string" ? e : String(e?.message ?? e); }
            value.local_config = { path, comparison, error };
        }
        return print(value, { kind: "status" });
    }
    if (action === "stage") {
        allow(flags, ["-a", "--command-id"]);
        arity(rest, 0);
        const body = desiredConfig(local);
        return print(await appRequest(name, "PUT", ["config"], { ...command, body }), { kind: "staged", message: "Configuration staged.", apply });
    }
    if (action === "apply") {
        allow(flags, ["-a", "--staged", "--fill", "--fill-non-interactive", "--force", "--command-id"]);
        arity(rest, 0);
        if (flags["--staged"] && flags["-a"]) throw new UsageError("the argument '--staged' cannot be used with '--app-config <APP_CONFIG>'");
        if (flags["--fill"] && flags["--fill-non-interactive"]) throw new UsageError("the argument '--fill' cannot be used with '--fill-non-interactive'");
        const current = await appRequest(name, "GET", [], options);
        const { desired, revision } = await stagedOrLocal(current, flags["--staged"] ? null : local, name, path, options);
        if (flags["--fill"]) throw terminal("--fill");
        await fillValues(name, userSuppliedPolicy(desired), flags["--fill-non-interactive"] ? fillEnv ?? {} : null);
        const { deployment_id: deploymentId } = await appApiGet(current?.api_url, ["v1", "info"]);
        const body = { force: flags["--force"] === true, revision, deployment_id: deploymentId };
        return print(await appRequest(name, "POST", ["apply"], { ...command, body }), { kind: "lifecycle" });
    }
    if (action === "enable" || action === "disable") {
        allow(flags, ["--command-id"]);
        arity(rest, 0);
        return print(await appRequest(name, "POST", [action], command), { kind: "lifecycle" });
    }
    if (action === "delete") {
        allow(flags, ["--command-id"]);
        arity(rest, 0);
        return print(await appRequest(name, "DELETE", [], command), { kind: "message", message: "App deleted." });
    }
    if (action === "fill") {
        allow(flags, ["-a", "--staged", "--non-interactive"]);
        arity(rest, 0);
        if (flags["--staged"] && flags["-a"]) throw new UsageError("the argument '--staged' cannot be used with '--app-config <APP_CONFIG>'");
        const current = await appRequest(name, "GET", [], options);
        const { desired } = await stagedOrLocal(current, flags["--staged"] ? null : local, name, path, options);
        if (!flags["--non-interactive"]) {
            throw "`fill` requires a terminal; use `fill --non-interactive` to read same-named environment variables";
        }
        return print(await fillValues(name, userSuppliedPolicy(desired), fillEnv ?? {}), { kind: "fill", apply });
    }
    if (action === "env") return envCommand(name, rest, flags, command, options, print, apply);
    if (action === "secrets") return secretsCommand(name, rest, flags, stdin, options, print, apply);
    if (action === "endpoint") {
        allow(flags, []);
        arity(rest, 1);
        return endpoint(name, rest[0], flags);
    }
    throw new UsageError(`unrecognized subcommand '${action ?? ""}'`);
}

async function envCommand(name, [action, key, value, ...extra], flags, command, options, print, apply) {
    if (action === "list") {
        allow(flags, []);
        arity([key], 0);
        return print(await appRequest(name, "GET", ["env"], options), { kind: "env" });
    }
    if (action === "set") {
        allow(flags, ["--command-id"]);
        if (value === undefined) throw new UsageError("the following required arguments were not provided:\n  <NAME>\n  <VALUE>");
        arity(extra, 0);
        configName(key);
        const result = await appRequest(name, "PUT", ["env", key], { ...command, body: { value } });
        return print(result, { kind: "staged", message: "Environment staged.", apply });
    }
    if (action === "unset") {
        allow(flags, ["--command-id"]);
        if (key === undefined) throw new UsageError("the following required arguments were not provided:\n  <NAME>");
        arity([value], 0);
        configName(key);
        return print(await appRequest(name, "DELETE", ["env", key], command), { kind: "staged", message: "Environment staged.", apply });
    }
    throw new UsageError(`unrecognized subcommand '${action ?? ""}'`);
}

async function secretsCommand(name, [action, key, ...extra], flags, stdin, options, print, apply) {
    const secret = { ...options, kind: "secret" };
    if (action === "list") {
        allow(flags, []);
        arity([key], 0);
        return print(await appRequest(name, "GET", ["secrets"], secret), { kind: "secrets" });
    }
    if (action === "set") {
        allow(flags, ["--stdin"]);
        if (key === undefined) throw new UsageError("the following required arguments were not provided:\n  <NAME>");
        if (flags["--stdin"] !== true) throw new UsageError("the following required arguments were not provided:\n  --from-env <FROM_ENV>");
        arity(extra, 0);
        configName(key);
        await appRequest(name, "PUT", ["secrets", key], { ...secret, body: { value: stdin } });
        return print({ staged_secret: key }, { kind: "staged", message: "Secret change staged.", apply });
    }
    if (action === "unset") {
        allow(flags, []);
        if (key === undefined) throw new UsageError("the following required arguments were not provided:\n  <NAME>");
        arity(extra, 0);
        configName(key);
        await appRequest(name, "DELETE", ["secrets", key], secret);
        return print({ deleted_secret: key }, { kind: "staged", message: "Secret change staged.", apply });
    }
    throw new UsageError(`unrecognized subcommand '${action ?? ""}'`);
}

// PORT: cloud.rs's `run` for `endpoint`: computed from the name, no provisioner call.
function endpoint(name, which, flags) {
    const endpoints = appEndpoints(name);
    if (which !== undefined) {
        const key = { api: "api_url", webhook: "webhook_url", webui: "webui_url" }[which];
        if (!key) throw new UsageError(`unrecognized subcommand '${which}'`);
        return { stdout: flags["--json"] ? `${JSON.stringify(endpoints[key], null, 2)}\n` : `${endpoints[key]}\n` };
    }
    return flags["--json"] ? { stdout: `${JSON.stringify(endpoints, null, 2)}\n` } : { stderr: humanOutput(endpoints) };
}

// PORT: cloud.rs's `app_name`. `config` is the policy the shell found, if any.
function appName(name, config) {
    if (name === undefined || name === null) {
        throw config
            ? "Set app_name in ./app.toml, --app or OBELISK_APP_NAME"
            : "Select an app with --app, OBELISK_APP_NAME or app_name in ./app.toml\n\nCaused by:\n    Cannot read app config app.toml: No such file or directory";
    }
    validateCloudAppName(name);
    return name;
}

// PORT: cloud.rs's `config_for_app`: never use another app's config; an explicit
// or required one is an error, a discovered optional one is ignored.
export function configForApp(name, config, path, explicit, required) {
    if (!config) {
        if (required) throw "No app config: ./app.toml not found; pass --app-config";
        return null;
    }
    if (config.appName && config.appName !== name) {
        if (explicit || required) {
            throw `${path} is for app \`${config.appName}\`, but the selected app is \`${name}\` (from --app or OBELISK_APP_NAME); pass \`--app ${config.appName}\` or fix \`app_name\``;
        }
        return null;
    }
    return config;
}

function readableConfig(appToml, path) {
    try { return appConfig(appToml, path); } catch { return null; }
}

function desiredConfig(config) {
    return { policy: config.policy, cloud: config.cloud };
}

// PORT: cloud.rs's `compare_config`: the provisioner diffs `desired` against staging.
function compareConfig(name, desired, options) {
    return appRequest(name, "POST", ["config", "compare"], { ...options, body: desired });
}

// PORT: cloud.rs's `staged_or_local` without the prompt: the staged config and its revision.
async function stagedOrLocal(current, local, name, path, options) {
    const staged = { policy: current?.policy, cloud: current?.cloud };
    if (!local) return { desired: staged, revision: stagedRevision(current) };
    const comparison = await compareConfig(name, desiredConfig(local), options);
    const revision = stagedRevision(comparison);
    const changes = Array.isArray(comparison?.changes) ? comparison.changes.filter((change) => typeof change === "string") : [];
    if (changes.length === 0) return { desired: staged, revision };
    throw `${path} differs from staged configuration revision ${revision}: ${changes.join(", ")}\nRun \`obelisk cloud app --app ${name} stage -a ${path}\`, or pass \`--staged\` to use the staged configuration`;
}
