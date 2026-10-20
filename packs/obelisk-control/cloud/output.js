// PORT: obelisk's src/command/cloud/output.rs and cloud.rs's `human_output`.

// `--verbose` rendering: every field, nested by indentation.
export function humanOutput(value) {
    const lines = [];
    render(lines, value, 0);
    return lines.join("");
}

function render(out, value, indent) {
    const pad = " ".repeat(indent);
    if (isObject(value) && Object.keys(value).length > 0) {
        for (const [key, field] of Object.entries(value)) {
            if (key === "apps" && "global" in value) {
                // Rendered as the `global` scope line.
            } else if (key === "global" && typeof field === "boolean") {
                out.push(`${pad}scope: ${field ? "account-wide" : names(value.apps)}\n`);
            } else if (isObject(field) || Array.isArray(field)) {
                out.push(`${pad}${key.replace(/_/g, " ")}:\n`);
                render(out, field, indent + 2);
            } else {
                out.push(`${pad}${key.replace(/_/g, " ")}: `);
                render(out, field, 0);
            }
        }
    } else if (Array.isArray(value) && value.length > 0) {
        value.forEach((item, index) => {
            if (index > 0 && isObject(item)) out.push("\n");
            render(out, item, indent);
        });
    } else {
        const text = typeof value === "string" ? value
            : value === null || value === undefined || typeof value === "object" ? "(none)" : String(value);
        out.push(`${pad}${text}\n`);
    }
}

// The default human summary of command `summary` (see `summaryFor` in cli.js).
export function renderSummary(summary, value) {
    let out = "";
    const line = (text) => {
        out += `${text}\n`;
    };
    switch (summary.kind) {
        case "app":
            if (summary.message) line(summary.message);
            out += app(value);
            break;
        case "lifecycle":
            line(lifecycleOutcome(value));
            out += app(value);
            break;
        case "apps": {
            const apps = Array.isArray(value?.apps) ? value.apps : [];
            if (apps.length === 0) line("No apps. Run `obelisk cloud app new` to create one.");
            for (const item of apps) out += app(item);
            break;
        }
        case "status": {
            out += app(value?.app);
            const status = text(value?.app, "status", "");
            const machine = text(value, "machine_state", "");
            const up = machine === "started";
            if (["started", "stopped", "suspended"].includes(machine) && ((status === "running" && !up) || (status === "stopped" && up))) {
                line(`VM is ${machine} although the app is ${status}. Run \`obelisk cloud app --app ${text(value?.app, "app_name", "")} apply\` to reconcile it.`);
            }
            if (Number.isInteger(value?.memory_mb)) line(`Memory: ${value.memory_mb} MB`);
            line(`API: ${value?.api_ready === true ? "ready" : "unavailable"}`);
            break;
        }
        case "token":
            out += token(value);
            break;
        case "tokens": {
            const tokens = Array.isArray(value?.tokens) ? value.tokens : [];
            if (tokens.length === 0) line("No tokens.");
            for (const item of tokens) out += token(item);
            break;
        }
        case "env": {
            const env = isObject(value?.env) ? Object.entries(value.env) : [];
            if (env.length === 0) line("No environment variables.");
            for (const [name, envValue] of env) line(`${name}=${typeof envValue === "string" ? envValue : ""}`);
            break;
        }
        case "secrets": {
            const secrets = Array.isArray(value?.secrets) ? value.secrets : [];
            if (secrets.length === 0) line("No secrets.");
            for (const secret of secrets) line(text(secret, "name", "secret"));
            break;
        }
        case "message":
            line(summary.message);
            break;
        case "staged":
            line(`${summary.message} Run \`${summary.apply}\` to apply changes.`);
            break;
        default:
            throw `unknown summary ${summary.kind}`;
    }
    return out;
}

export function lifecycleOutcome(value) {
    const configuration = {
        applied: "Configuration applied. ",
        unchanged: "Configuration already applied. ",
    }[value?.outcome?.configuration] ?? "";
    const vm = {
        started: "App started.",
        restarted: "App restarted.",
        stopped: "App stopped.",
        remained_stopped: "App remains stopped.",
        remained_running: "App remains running.",
    }[value?.outcome?.vm] ?? "Cloud operation completed.";
    return `${configuration}${vm}`;
}

function app(value) {
    let out = `${text(value, "app_name", "App")}: ${text(value, "status", "unknown")}\n`;
    const name = text(value, "app_name", "");
    const desired = value?.desired_state;
    if (typeof desired === "string" && value?.status !== desired) {
        out += ["running", "stopped"].includes(value?.status)
            ? `Intended state: ${desired}. Run \`obelisk cloud app --app ${name} apply\` to reach it.\n`
            : `Intended state: ${desired}\n`;
    }
    if (typeof value?.webhook_url === "string") out += `URL: ${value.webhook_url}\n`;
    if (value?.potentially_stale === true) out += `Pending changes. Run \`obelisk cloud app --app ${name} apply\` to apply them.\n`;
    if (typeof value?.state?.failure === "string") out += `Error: ${value.state.failure}\n`;
    const reason = value?.state?.startup_failure?.reason;
    if (typeof reason === "string") out += `Startup failed: ${reason}. Use --verbose for startup details.\n`;
    return out;
}

function token(value) {
    const scope = value?.creation?.global === true ? "account-wide" : names(value?.creation?.apps);
    const expires = Number.isInteger(value?.expires_at) ? value.expires_at : null;
    const state = value?.revoked === true ? "revoked"
        : expires !== null && expires <= Math.floor(Date.now() / 1000) ? "expired" : "active";
    let out = `${text(value, "token_id", "Token")}  ${text(value, "name", "")}  ${state}  scope: ${scope}\n`;
    if (value?.sync?.status === "pending") out += "Access changes pending.\n";
    if (expires !== null) out += `Expires: ${new Date(expires * 1000).toISOString().replace(".000Z", "+00:00")}\n`;
    return out;
}

// The human message of a failed provisioner response body.
export function errorMessage(body) {
    let value;
    try {
        value = JSON.parse(body);
    } catch {
        return "Cloud request failed";
    }
    let message = text(value, "error", "Cloud request failed");
    if (Array.isArray(value?.missing)) message += `: ${value.missing.filter((m) => typeof m === "string").join(", ")}`;
    const reason = value?.startup_failure?.reason;
    if (typeof reason === "string") message += `: ${reason}. Use --verbose for startup details`;
    return message;
}

function names(list) {
    return Array.isArray(list) ? list.filter((item) => typeof item === "string").join(", ") : "";
}

function text(value, key, fallback) {
    return typeof value?.[key] === "string" ? value[key] : fallback;
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
