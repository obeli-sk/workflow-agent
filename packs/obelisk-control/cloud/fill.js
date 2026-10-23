// PORT: obelisk's cloud.rs `fill_values` and `initial_values` (non-interactive) and `config_differs`.
import { appRequest } from "./client.js";
import { configName } from "./policy.js";

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

// PORT: cloud.rs's `collect_values` without the prompt. `fillEnv` is the
// shell's exported variables for `--fill-non-interactive`, else null (only
// check that required values are set).
function collectValues(fillHint, policy, envValues, secretValues, fillEnv) {
    const { env, secrets } = declarations(policy);
    const all = [
        ...env.map((entry) => ({ kind: "env", ...entry, exists: hasOwn(envValues, entry.name), current: envValues[entry.name] })),
        ...secrets.map((entry) => ({ kind: "secrets", ...entry, exists: secretValues.some((secret) => secret?.name === entry.name) })),
    ];
    const pending = [];
    const report = [];
    const missing = [];
    for (const { kind, name, optional, exists, current } of all) {
        configName(name);
        const source = fillEnv !== null && hasOwn(fillEnv, name) ? fillEnv[name] : undefined;
        const label = kind === "secrets" ? "secret" : "env";
        let action;
        if (exists && current !== undefined && current === source) {
            action = "unchanged";
        } else if (source !== undefined) {
            pending.push({ kind, name, value: source });
            action = "staged";
        } else if (exists) {
            action = "kept";
        } else if (optional) {
            action = "unset";
        } else {
            missing.push(`${label} ${name}`);
            action = "missing";
        }
        report.push({ kind, name, optional, action });
    }
    if (missing.length > 0) {
        throw `Missing required configuration: ${missing.join(", ")}. ${fillEnv !== null ? "Set them as environment variables of the same name" : fillHint}`;
    }
    return { report, pending };
}

// PORT: cloud.rs's `fill_values`: stage the values of `fillEnv` (see `collectValues`).
export async function fillValues(name, policy, fillEnv) {
    const env = (await appRequest(name, "GET", ["env"]))?.env;
    const secrets = (await appRequest(name, "GET", ["secrets"], { kind: "secret" }))?.secrets;
    if (env === null || typeof env !== "object" || Array.isArray(env)) throw "Invalid cloud environment response";
    if (!Array.isArray(secrets)) throw "Invalid cloud secrets response";
    const { report, pending } = collectValues(
        `Run \`obelisk cloud app --app ${name} fill\`, or retry with \`--fill\` or \`--fill-non-interactive\``,
        policy, env, secrets, fillEnv,
    );
    const staged = [];
    for (const { kind, name: key, value } of pending) {
        try {
            await appRequest(name, "PUT", [kind, key], { kind: kind === "secrets" ? "secret" : "command", body: { value } });
        } catch (error) {
            throw `Could not stage ${kind} ${key}; earlier values may already be staged\n\nCaused by:\n    ${error}`;
        }
        staged.push({ kind, name: key });
    }
    return { staged, declarations: report, apply_required: staged.length > 0 };
}

// PORT: cloud.rs's `initial_values`: a new app's env and secrets.
export function initialValues(policy, fillEnv) {
    const { pending } = collectValues(
        "Retry with `--fill`, or `--fill-non-interactive` to read same-named environment variables",
        policy, {}, [], fillEnv,
    );
    const values = { env: {}, secrets: {} };
    for (const { kind, name, value } of pending) values[kind][name] = value;
    return values;
}

// The `deploy` hint for optional values left unset.
export function unsetOptional(filled) {
    return filled.declarations
        .filter((declaration) => declaration.action === "unset")
        .map((declaration) => `${declaration.kind === "secrets" ? "secret" : "env"} ${declaration.name}`);
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
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
