// obelisk-agent:tools/cloud.run:
//   func(args: list<string>, stdin: string, app-toml: option<string>,
//        fill-env: option<list<tuple<string, string>>>)
//     -> result<record { stdout: string, stderr: string, exit-code: u32 }, string>
//
// PORT: obelisk's src/command/cloud.rs. The provisioner half of `obelisk cloud`
// (apps, tokens, env and secrets); the shell's `obelisk` command handles
// `app new|deploy|apply|enable|disable|delete` and the app API subcommands itself. `app-toml` is the
// policy file's text (`-a PATH`, else ./app.toml) when the shell found one;
// `fill-env` the shell's exported variables for `--fill-non-interactive`, or
// those that bare `--env NAME` reads. Secret values never pass through here.
// Like the CLI, JSON goes to stdout and human output to stderr; errors exit 1,
// usage errors 2.
import { appRequest, cloudBase, cloudRequest, draftRequest } from "./client.js";
import { USER_SETS_SECRETS } from "./fill.js";
import { appConfig, configForApp, configName, validateCloudAppName } from "./policy.js";
import { draftArg, draftValues, humanOutput, renderSummary } from "./output.js";

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

const VALUE_FLAGS = ["--app", "-a", "--app-config", "-n", "--limit", "--draft", "-d", "--deployment"];
const REPEATED_FLAGS = ["--env"];
const BOOLEAN_FLAGS = [
    "--json", "--verbose", "--fill", "--fill-non-interactive",
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
        if (name === "--secret") throw `\`--secret\` is not available here, secret values come only from the user: ${USER_SETS_SECRETS}`;
        if (VALUE_FLAGS.includes(name) || REPEATED_FLAGS.includes(name)) {
            const value = eq !== -1 && name !== arg ? arg.slice(eq + 1) : args[++i];
            if (value === undefined) throw new UsageError(`a value is required for '${name} <VALUE>' but none was supplied`);
            if (REPEATED_FLAGS.includes(name)) (flags[name] ??= []).push(value);
            else flags[{ "--app-config": "-a", "--limit": "-n", "--deployment": "-d" }[name] ?? name] = value;
        } else if (BOOLEAN_FLAGS.includes(arg)) {
            flags[arg] = true;
        } else if (["--api-url", "--api-token", "--apps-domain", "--account"].includes(name)) {
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
    const options = { verbose: flags["--verbose"] === true };
    const print = (value, summary) => {
        if (flags["--json"]) return { stdout: `${JSON.stringify(value, null, 2)}\n` };
        return { stderr: options.verbose ? humanOutput(value) : renderSummary(summary, value) };
    };
    if (group === "app" && rest[0] === "list") {
        allow(flags, []);
        if (flags["--app"] !== undefined) throw new UsageError("unexpected argument '--app' found");
        arity(rest, 1);
        return print(await cloudRequest("GET", ["v1", "apps"], options), { kind: "apps" });
    }
    if (group === "auth") {
        allow(flags, []);
        return authCommand(rest, flags);
    }
    if (group === "app") return appCommand(rest, flags, stdin, appToml, fillEnv, options, print);
    throw new UsageError(`unrecognized subcommand '${positionals.join(" ")}'`);
}

// PORT: cloud/auth.rs's `status`, reduced to what the shell has: no saved logins, only the
// configured token, whose account name and expiry it cannot know.
async function authCommand([action, ...extra], flags) {
    if (["login", "switch", "logout"].includes(action)) {
        throw `\`cloud auth ${action}\` is not available in the sandbox; the account comes from OBELISK_CLOUD_API_TOKEN`;
    }
    if (action !== "status") throw new UsageError(`unrecognized subcommand '${action ?? ""}'`);
    arity(extra, 0);
    const accounts = process.env["OBELISK_CLOUD_API_TOKEN"]
        ? [{
            default: true,
            api_url: cloudBase(),
            apps_domain: process.env["OBELISK_CLOUD_APPS_DOMAIN"] || "obelisk.works",
            token_state: await tokenState(),
        }]
        : [];
    const value = { accounts };
    return flags["--json"] ? { stdout: `${JSON.stringify(value, null, 2)}\n` } : { stderr: humanOutput(value) };
}

async function tokenState() {
    try {
        await cloudRequest("GET", ["v1", "tokens"]);
        return "active";
    } catch (error) {
        const status = /\(HTTP (\d+)\)$/.exec(error)?.[1];
        if (status === "401") return "rejected";
        return status ? `unknown (HTTP ${status})` : `unknown (${error})`;
    }
}

const POLICY_COMMANDS = ["status"];

// PORT: args.rs's `parse_draft_key`.
function draftKey(flags) {
    const key = flags["--draft"] ?? "default";
    if (!/^[a-z0-9._-]{1,64}$/.test(key)) {
        throw new UsageError(`invalid value '${key}' for '--draft <KEY>': draft key must be 1-64 characters a-z, 0-9, '.', '_' or '-'`);
    }
    return key;
}

async function appCommand([action, ...rest], flags, stdin, appToml, fillEnv, options, print) {
    const path = flags["-a"] ?? "app.toml";
    const explicit = flags["-a"] !== undefined;
    const config = appToml === null || (!POLICY_COMMANDS.includes(action) && explicit) ? null
        // Status only reports a readable discovered ./app.toml.
        : action === "status" && !explicit ? readableConfig(appToml, path) : appConfig(appToml, path);
    const name = appName(flags["--app"] ?? config?.appName);
    const local = configForApp(name, config, path, explicit, action === "stage");
    const key = draftKey(flags);
    const apply = `obelisk cloud app apply${flags["--app"] === undefined ? "" : ` --app ${flags["--app"]}`}${draftArg(key)}`;
    if (action === "status") {
        allow(flags, ["-a"]);
        arity(rest, 0);
        const value = await appRequest(name, "GET", ["status"], options);
        // Older provisioners have no drafts.
        value.drafts = (await appRequest(name, "GET", ["drafts"], options))?.drafts;
        if (local) {
            let comparison = null;
            let error = null;
            try { comparison = await compareConfig(name, local.text, options); }
            catch (e) { error = typeof e === "string" ? e : String(e?.message ?? e); }
            value.local_config = { path, comparison, error };
        }
        return print(value, { kind: "status" });
    }
    if (action === "events") {
        allow(flags, ["-n"]);
        arity(rest, 0);
        const limit = flags["-n"] ?? "5";
        if (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 50) {
            throw new UsageError(`invalid value '${limit}' for '--limit <LIMIT>': ${limit} is not in 1..=50`);
        }
        return print(await appRequest(name, "GET", ["events"], { ...options, query: { limit } }), { kind: "events" });
    }
    if (action === "unstage") {
        allow(flags, ["--draft"]);
        arity(rest, 0);
        return print(await draftRequest(name, key, "DELETE", [], options), { kind: "unstaged", draft: key });
    }
    if (action === "env") return envCommand(name, key, rest, flags, options, print, apply);
    if (action === "secrets") return secretsCommand(name, key, rest, flags, options, print, apply);
    throw new UsageError(`unrecognized subcommand '${action ?? ""}'`);
}

async function envCommand(name, draft, [action, key, value, ...extra], flags, options, print, apply) {
    if (action === "list") {
        allow(flags, []);
        arity([key], 0);
        return print(await appRequest(name, "GET", ["env"], options), { kind: "env" });
    }
    if (action === "set") {
        allow(flags, ["--draft"]);
        if (value === undefined) throw new UsageError("the following required arguments were not provided:\n  <NAME>\n  <VALUE>");
        arity(extra, 0);
        configName(key);
        const result = await draftRequest(name, draft, "PUT", ["env", key], { ...options, body: { value } }, true);
        return print(result, { kind: "staged", message: "Environment staged.", apply });
    }
    if (action === "unset") {
        allow(flags, ["--draft"]);
        if (key === undefined) throw new UsageError("the following required arguments were not provided:\n  <NAME>");
        arity([value], 0);
        configName(key);
        return print(await draftRequest(name, draft, "DELETE", ["env", key], options, true), { kind: "staged", message: "Environment staged.", apply });
    }
    throw new UsageError(`unrecognized subcommand '${action ?? ""}'`);
}

const SECRETS_SET_UNSUPPORTED = `\`secrets set\` is not available here, secret values come only from the user: ${USER_SETS_SECRETS}`;

async function secretsCommand(name, draft, [action, key, ...extra], flags, options, print, apply) {
    const secret = { ...options, kind: "secret" };
    if (action === "list") {
        allow(flags, []);
        arity([key], 0);
        return print(await appRequest(name, "GET", ["secrets"], secret), { kind: "secrets" });
    }
    // Secret values come from the user, never through the agent.
    if (action === "set") throw SECRETS_SET_UNSUPPORTED;
    if (action === "unset") {
        allow(flags, ["--draft"]);
        if (key === undefined) throw new UsageError("the following required arguments were not provided:\n  <NAME>");
        arity(extra, 0);
        configName(key);
        const result = await draftRequest(name, draft, "DELETE", ["secrets", key], options, true);
        return print(result, { kind: "staged", message: "Secret change staged.", apply });
    }
    throw new UsageError(`unrecognized subcommand '${action ?? ""}'`);
}

// PORT: cloud.rs's `app_name`; a parsed config always names an app.
function appName(name) {
    if (name === undefined || name === null) {
        throw "Select an app with --app, OBELISK_APP_NAME or app_name in ./app.toml\n\nCaused by:\n    Cannot read app config app.toml: No such file or directory";
    }
    validateCloudAppName(name);
    return name;
}

function readableConfig(appToml, path) {
    try { return appConfig(appToml, path); } catch { return null; }
}

// PORT: cloud.rs's `compare_config`: the provisioner diffs `appToml` against staging.
function compareConfig(name, appToml, options) {
    return appRequest(name, "POST", ["config", "compare"], { ...options, toml: appToml });
}
