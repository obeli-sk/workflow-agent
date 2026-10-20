// obelisk-agent:tools/cloud.prepare-deploy:
//   func(app: string, app-toml: string)
//     -> result<record { api-url: string, webhook-url: option<string>, log: string }, string>
//
// PORT: obelisk's src/command/cloud/deploy.rs up to the deployment apply:
// create or restage the app, check required config, apply and start it, then
// hand back its API URL so the shell applies the deployment there.
import { apiOrigin, appRequest, cloudRequest, lookupApp } from "./client.js";
import { appConfig, validateAppName } from "./policy.js";
import { lifecycleOutcome } from "./output.js";

export default async function prepare_deploy(app, appToml) {
    const lines = [];
    const log = (line) => lines.push(`${line}\n`);
    const config = appConfig(appToml);
    const name = app || config.appName;
    if (!name) throw "Select an app with --app or app_name in app.toml";
    validateAppName(name);
    const step = (command, message) => log(`→ obelisk cloud app --app ${name} ${command}  ${message}`);
    const command = { kind: "command" };

    let row = await lookupApp(name);
    if (row === null) {
        step("new -a app.toml", "Creating app");
        row = await cloudRequest("POST", ["v1", "apps"], {
            ...command,
            body: { app_name: name, policy: config.policy, cloud: config.cloud },
        });
    } else if (!sameConfig(row, config)) {
        step("stage -a app.toml", "Staging app configuration");
        row = await appRequest(name, "PUT", ["config"], { ...command, body: { policy: config.policy, cloud: config.cloud } });
    } else {
        log("App configuration unchanged.");
    }

    await checkFill(name, config.policy, log);

    if (row?.potentially_stale === true || row?.applied_revision === 0 || row?.apply_required === true) {
        step("apply", "Applying staged configuration");
        row = await appRequest(name, "POST", ["apply"], { ...command, body: { force: false } });
        log(lifecycleOutcome(row));
    }
    if (row?.status === "stopped") {
        step("start", "Starting VM");
        row = await appRequest(name, "POST", ["start"], command);
        log(lifecycleOutcome(row));
    }
    if (row?.status !== "running") {
        throw `App is ${row?.status ?? "unknown"}; inspect it with \`obelisk cloud app --app ${name} status\``;
    }
    const webhook = typeof row.webhook_url === "string" ? row.webhook_url : null;
    return { api_url: apiOrigin(row.api_url), webhook_url: webhook, log: lines.join("") };
}

async function checkFill(name, policy, log) {
    const required = [];
    const optional = [];
    const envNames = policy.public_env.map((entry) => (typeof entry === "string" ? { name: entry, optional: false } : entry));
    const secretNames = Object.entries(policy.secrets)
        .filter(([, secret]) => secret.type !== "internal")
        .map(([secretName, secret]) => ({ name: secretName, optional: secret.optional === true }));
    if (envNames.length > 0) {
        const env = (await appRequest(name, "GET", ["env"]))?.env ?? {};
        for (const entry of envNames) {
            if (!Object.prototype.hasOwnProperty.call(env, entry.name)) (entry.optional ? optional : required).push(`env ${entry.name}`);
        }
    }
    if (secretNames.length > 0) {
        const listed = (await appRequest(name, "GET", ["secrets"], { kind: "secret" }))?.secrets ?? [];
        const present = new Set(listed.map((secret) => secret?.name));
        for (const entry of secretNames) {
            if (!present.has(entry.name)) (entry.optional ? optional : required).push(`secret ${entry.name}`);
        }
    }
    if (required.length > 0) {
        throw `Missing required configuration: ${required.join(", ")}. Set it with \`obelisk cloud app --app ${name} env set NAME VALUE\` or \`obelisk cloud app --app ${name} secrets set NAME --stdin\`, then retry the deploy`;
    }
    if (optional.length > 0) log(`Optional configuration not set: ${optional.join(", ")}`);
}

// Whether the provisioner already holds this policy and cloud config.
export function sameConfig(row, config) {
    return canonical(row?.policy) === canonical(config.policy) && canonical(row?.cloud ?? {}) === canonical(config.cloud);
}

function canonical(value) {
    return JSON.stringify(normalize(value));
}

function normalize(value) {
    if (Array.isArray(value)) return value.map(normalize);
    if (value === null || typeof value !== "object") return value;
    const out = {};
    for (const key of Object.keys(value).sort()) {
        if (value[key] !== null && value[key] !== undefined) out[key] = normalize(value[key]);
    }
    return out;
}
