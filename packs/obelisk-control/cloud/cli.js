// obelisk-agent:tools/cloud.run:
//   func(args: list<string>, stdin: string, app-toml: option<string>)
//     -> result<record { stdout: string, stderr: string, exit-code: u32 }, string>
//
// PORT: obelisk's src/command/cloud.rs. The provisioner half of `obelisk cloud`
// (apps, tokens, app lifecycle, env and secrets); the shell's `obelisk` command
// handles `app deploy` and the app API subcommands itself. `app-toml` is the
// policy file's text (`-a PATH`, else ./app.toml) when the shell found one.
import { appRequest, cloudRequest } from "./client.js";
import { appConfig, validateAppName } from "./policy.js";
import { humanOutput, renderSummary } from "./output.js";

export default async function run(args, stdin, appToml) {
    const stderr = [];
    try {
        const stdout = await execute(parseArgs(args), stdin, appToml ?? null, (line) => stderr.push(`${line}\n`));
        return { stdout, stderr: stderr.join(""), exit_code: 0 };
    } catch (error) {
        const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error);
        stderr.push(`obelisk: ${message}\n`);
        return { stdout: "", stderr: stderr.join(""), exit_code: 1 };
    }
}

const VALUE_FLAGS = ["--app", "--command-id", "-a", "--app-config"];
const BOOLEAN_FLAGS = ["--json", "--verbose", "--force", "--stdin"];

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
            if (value === undefined) throw `${name} requires a value`;
            flags[name === "--app-config" ? "-a" : name] = value;
        } else if (BOOLEAN_FLAGS.includes(arg)) {
            flags[arg] = true;
        } else if (arg === "--api-url" || arg === "--api-token") {
            throw `${arg} is not supported here; the cloud API comes from OBELISK_CLOUD_API_URL and OBELISK_CLOUD_API_TOKEN`;
        } else if (arg.startsWith("-") && arg !== "-") {
            throw `unknown flag ${arg}`;
        } else {
            positionals.push(arg);
        }
    }
    return { positionals, flags };
}

async function execute({ positionals, flags }, stdin, appToml, log) {
    const [group, ...rest] = positionals;
    const options = { verbose: flags["--verbose"] === true, commandId: flags["--command-id"], log };
    const print = (value, summary) => {
        if (flags["--json"]) return `${JSON.stringify(value, null, 2)}\n`;
        return options.verbose ? humanOutput(value) : renderSummary(summary, value);
    };
    if (group === "apps" && rest[0] === "list") {
        return print(await cloudRequest("GET", ["v1", "apps"], options), { kind: "apps" });
    }
    if (group === "token") return print(...(await tokenCommand(rest, options)));
    if (group === "app") return appCommand(rest, flags, stdin, appToml, options, print);
    throw `unknown command \`cloud ${positionals.join(" ")}\`; expected apps, token or app`;
}

async function tokenCommand([action, id], options) {
    if (action === "list") return [await cloudRequest("GET", ["v1", "tokens"], options), { kind: "tokens" }];
    if (action === "get") return [await cloudRequest("GET", ["v1", "tokens", required(id, "token ID")], options), { kind: "token" }];
    if (action === "new" || action === "revoke") {
        throw `\`cloud token ${action}\` is not available in the sandbox; run it with the real obelisk CLI`;
    }
    throw "expected `cloud token list` or `cloud token get ID`";
}

async function appCommand([action, ...rest], flags, stdin, appToml, options, print) {
    const config = appToml === null ? null : appConfig(appToml, flags["-a"] ?? "app.toml");
    const command = { ...options, kind: "command" };
    if (action === "new") {
        const name = resolveName(rest[0] ?? flags["--app"] ?? config?.appName);
        const body = { app_name: name };
        if (config) Object.assign(body, { policy: config.policy, cloud: config.cloud });
        return print(await cloudRequest("POST", ["v1", "apps"], { ...command, body }), { kind: "app", message: "App created." });
    }
    const name = resolveName(flags["--app"] ?? config?.appName);
    const apply = `obelisk cloud app --app ${name} apply`;
    if (action === "get") return print(await appRequest(name, "GET", [], options), { kind: "app" });
    if (action === "status") return print(await appRequest(name, "GET", ["status"], options), { kind: "status" });
    if (action === "stage") {
        if (!config) throw `Cannot read policy ${flags["-a"] ?? "app.toml"}`;
        const body = { policy: config.policy, cloud: config.cloud };
        return print(await appRequest(name, "PUT", ["config"], { ...command, body }), { kind: "staged", message: "Configuration staged.", apply });
    }
    if (action === "apply") {
        const body = { force: flags["--force"] === true };
        return print(await appRequest(name, "POST", ["apply"], { ...command, body }), { kind: "lifecycle" });
    }
    // The CLI's `reactivate`/`deactivate` map to the provisioner's start/stop endpoints.
    const lifecycle = { reactivate: "start", deactivate: "stop" }[action];
    if (lifecycle) {
        return print(await appRequest(name, "POST", [lifecycle], command), { kind: "lifecycle" });
    }
    if (action === "delete") return print(await appRequest(name, "DELETE", [], command), { kind: "message", message: "App deleted." });
    if (action === "env") return envCommand(name, rest, command, options, print, apply);
    if (action === "secrets") return secretsCommand(name, rest, flags, stdin, options, print, apply);
    if (action === "endpoint") return endpoint(name, rest[0], flags, options);
    if (action === "fill") {
        throw `\`fill\` is interactive; set values with \`obelisk cloud app --app ${name} env set NAME VALUE\` and \`obelisk cloud app --app ${name} secrets set NAME --stdin\``;
    }
    throw `unknown command \`cloud app ${action ?? ""}\``;
}

async function envCommand(name, [action, key, value], command, options, print, apply) {
    if (action === "list") return print(await appRequest(name, "GET", ["env"], options), { kind: "env" });
    if (action === "set") {
        configName(key);
        if (value === undefined) throw "env set requires NAME and VALUE";
        const result = await appRequest(name, "PUT", ["env", key], { ...command, body: { value } });
        return print(result, { kind: "staged", message: "Environment staged.", apply });
    }
    if (action === "unset") {
        configName(key);
        return print(await appRequest(name, "DELETE", ["env", key], command), { kind: "staged", message: "Environment staged.", apply });
    }
    throw "expected `env list`, `env set NAME VALUE` or `env unset NAME`";
}

async function secretsCommand(name, [action, key], flags, stdin, options, print, apply) {
    const secret = { ...options, kind: "secret" };
    if (action === "list") return print(await appRequest(name, "GET", ["secrets"], secret), { kind: "secrets" });
    if (action === "set") {
        configName(key);
        if (flags["--stdin"] !== true) throw "secrets set requires --stdin (or --from-env NAME)";
        await appRequest(name, "PUT", ["secrets", key], { ...secret, body: { value: stdin } });
        return print({ staged_secret: key }, { kind: "staged", message: "Secret change staged.", apply });
    }
    if (action === "unset") {
        configName(key);
        await appRequest(name, "DELETE", ["secrets", key], secret);
        return print({ deleted_secret: key }, { kind: "staged", message: "Secret change staged.", apply });
    }
    throw "expected `secrets list`, `secrets set NAME --stdin` or `secrets unset NAME`";
}

async function endpoint(name, which, flags, options) {
    const app = await appRequest(name, "GET", [], options);
    const endpoints = appEndpoints(app);
    if (which !== undefined) {
        const key = { api: "api_url", webhook: "webhook_url", webui: "webui_url" }[which];
        if (!key) throw "expected `endpoint`, `endpoint api`, `endpoint webhook` or `endpoint webui`";
        return flags["--json"] ? `${JSON.stringify(endpoints[key])}\n` : `${endpoints[key]}\n`;
    }
    return flags["--json"] ? `${JSON.stringify(endpoints, null, 2)}\n` : humanOutput(endpoints);
}

export function appEndpoints(app) {
    if (typeof app?.api_url !== "string") throw "Provisioner response is missing api_url";
    let webhook = app.webhook_url;
    if (typeof webhook !== "string") {
        if (typeof app.hostname !== "string") throw "Provisioner response is missing hostname";
        webhook = `https://${app.hostname}`;
    }
    if (typeof app.webui_url !== "string") throw "Provisioner response is missing webui_url";
    return { api_url: app.api_url, webhook_url: webhook, webui_url: app.webui_url };
}

export function resolveName(name) {
    if (name === undefined || name === null) {
        throw "Select an app with --app or app_name in ./app.toml";
    }
    validateAppName(name);
    return name;
}

// PORT: cloud.rs's `config_name`.
export function configName(name) {
    if (typeof name !== "string" || name.length === 0 || name.length > 128 || /^\d/.test(name) || !/^[A-Za-z0-9_]+$/.test(name)) {
        throw `Invalid configuration name: ${name ?? ""}`;
    }
}

function required(value, label) {
    if (typeof value === "string" && value !== "") return value;
    throw `${label} is required`;
}
