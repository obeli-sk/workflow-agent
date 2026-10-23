// PORT: obelisk's cloud.rs `fill_values` (non-interactive) and `config_differs`.
import { appRequest } from "./client.js";

// The policy's env and secret names that the app supplies values for.
function declarations(policy) {
    const env = policy.public_env
        .filter((entry) => entry.type !== "internal")
        .map((entry) => (typeof entry === "string" ? { name: entry, optional: false } : entry));
    const secrets = Object.entries(policy.secrets)
        .filter(([, secret]) => secret.type !== "internal")
        .map(([name, secret]) => ({ name, optional: secret.optional === true }));
    return { env, secrets };
}

// What a new app, holding no values yet, would be missing.
export function requiredValues(policy) {
    const { env, secrets } = declarations(policy);
    return [
        ...env.filter((entry) => !entry.optional).map((entry) => `env ${entry.name}`),
        ...secrets.filter((entry) => !entry.optional).map((entry) => `secret ${entry.name}`),
    ];
}

// Throws when a required value is unset; logs the unset optional ones.
export async function checkFill(name, policy, log) {
    const required = [];
    const optional = [];
    const { env: envNames, secrets: secretNames } = declarations(policy);
    const env = (await appRequest(name, "GET", ["env"]))?.env ?? {};
    for (const entry of envNames) {
        if (!Object.prototype.hasOwnProperty.call(env, entry.name)) (entry.optional ? optional : required).push(`env ${entry.name}`);
    }
    const listed = (await appRequest(name, "GET", ["secrets"], { kind: "secret" }))?.secrets ?? [];
    const present = new Set(listed.map((secret) => secret?.name));
    for (const entry of secretNames) {
        if (!present.has(entry.name)) (entry.optional ? optional : required).push(`secret ${entry.name}`);
    }
    if (required.length > 0) {
        throw `Missing required configuration: ${required.join(", ")}. Set it with \`obelisk cloud app --app ${name} env set NAME VALUE\` or \`obelisk cloud app --app ${name} secrets set NAME --stdin\`, then retry`;
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
