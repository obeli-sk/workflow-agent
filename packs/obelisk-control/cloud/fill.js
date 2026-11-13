// PORT: obelisk's cloud.rs `explicit_values`, `stage_values`, `apply_request` and `initial_values` (non-interactive).
import { draftRequest } from "./client.js";
import { configName } from "./policy.js";
import { draftArg, draftChanges, draftValues } from "./output.js";

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

// PORT: cloud.rs's `user_supplied_policy`: the policy minus env vars that cloud integrations supply.
export function userSuppliedPolicy(config) {
    const supplied = new Set(Object.values(config.cloud?.integrations ?? {}).map((integration) => integration.env));
    const publicEnv = (config.policy?.public_env ?? []).filter((entry) => !supplied.has(typeof entry === "string" ? entry : entry.name));
    return { ...config.policy, public_env: publicEnv };
}

// PORT: cloud.rs's `collect_values` without the prompt. `fillEnv` is the
// shell's exported variables for `--fill-non-interactive`, else null (only
// check that required values are set).
function collectValues(fillHint, policy, envValues, secretNames, fillEnv) {
    const { env, secrets } = declarations(policy);
    const all = [
        ...env.map((entry) => ({ kind: "env", ...entry, exists: hasOwn(envValues, entry.name), current: envValues[entry.name] })),
        ...secrets.map((entry) => ({ kind: "secrets", ...entry, exists: secretNames.includes(entry.name) })),
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

// PORT: cloud.rs's `explicit_values`: `--env` and `--secret` values; a bare name reads
// the same-named variable of `env`, the shell's exported variables.
export function explicitValues(envFlags, secretFlags, env) {
    const read = (name) => {
        if (env === null || !hasOwn(env, name)) throw `Environment variable ${name} is missing or not UTF-8`;
        return env[name];
    };
    const pending = [];
    for (const item of envFlags) {
        const eq = item.indexOf("=");
        const name = eq === -1 ? item : item.slice(0, eq);
        configName(name);
        pending.push({ kind: "env", name, value: eq === -1 ? read(name) : item.slice(eq + 1) });
    }
    for (const item of secretFlags) {
        const eq = item.indexOf("=");
        if (eq !== -1) {
            const name = item.slice(0, eq);
            throw `\`--secret\` takes only a name and reads the same-named environment variable, e.g. \`${name}=... obelisk cloud app apply --secret ${name}\``;
        }
        configName(item);
        pending.push({ kind: "secrets", name: item, value: read(item) });
    }
    return pending;
}

// PORT: cloud.rs's `without`: drops declarations of `explicit` values, which are not collected again.
function without(policy, explicit) {
    const given = (kind, name) => explicit.some((value) => value.kind === kind && value.name === name);
    return {
        ...policy,
        public_env: (policy.public_env ?? []).filter((entry) => !given("env", typeof entry === "string" ? entry : entry.name)),
        secrets: Object.fromEntries(Object.entries(policy.secrets ?? {}).filter(([name]) => !given("secrets", name))),
    };
}

// PORT: cloud.rs's `stage_values`: stages `explicit` values into draft `key` (whose view is
// `draft`, or null when not opened), then the remaining declared values of `fillEnv`; a null
// `fillEnv` stages only `explicit`. Returns the latest draft view and the fill report.
export async function stageValues(app, key, draft, explicit, fillEnv) {
    const staged = [];
    const put = async ({ kind, name, value }) => {
        let view;
        try {
            view = await draftRequest(app, key, "PUT", [kind, name], { body: { value } });
        } catch (error) {
            throw `Could not stage ${kind === "secrets" ? "secret" : "env"} ${name} in draft \`${key}\`; earlier values may already be staged\n\nCaused by:\n    ${error}`;
        }
        staged.push({ kind, name });
        return view;
    };
    for (const value of explicit) draft = await put(value);
    let report = [];
    if (fillEnv !== null) {
        const base = draft ?? await draftRequest(app, key, "POST", []);
        if (base?.env === null || typeof base?.env !== "object" || Array.isArray(base.env)) throw "Invalid cloud draft environment";
        if (!Array.isArray(base?.secrets)) throw "Invalid cloud draft secrets";
        let pending;
        ({ report, pending } = collectValues(
            `Run \`obelisk cloud app fill --app ${app}${draftArg(key)}\`, or retry with \`--fill\` or \`--fill-non-interactive\``,
            without(userSuppliedPolicy(base), explicit), base.env, base.secrets, fillEnv,
        ));
        draft = base;
        for (const value of pending) draft = await put(value);
    }
    return { draft, filled: { draft: key, staged, declarations: report } };
}

// PORT: cloud.rs's `apply_request`: applies draft `key` when it has changes, otherwise re-applies
// the applied revision. `note` receives the human progress lines.
export function applyRequest(name, key, draft, current, deploymentId, force, note) {
    const body = { force, deployment_id: deploymentId };
    const applied = JSON.stringify(current?.applied_revision ?? null);
    if (draft?.summary?.changed !== true) {
        note(`Re-applying revision ${applied}`);
        return { ...body, revision: current?.applied_revision };
    }
    if (draft.stale === true) {
        throw `Draft \`${key}\` was opened on revision ${JSON.stringify(draft.parent_revision ?? null)}, but revision ${applied} was applied since; discard it with \`obelisk cloud app unstage --app ${name}${draftArg(key)}\``;
    }
    const missing = draftValues(draft, "missing");
    if (missing.length > 0) {
        throw `Missing values in draft \`${key}\`: ${missing.join(", ")}. Pass them with \`--env NAME[=VALUE]\` or \`--secret NAME\`, or retry with \`--fill\` or \`--fill-non-interactive\``;
    }
    note(`Applying draft \`${key}\` revision ${JSON.stringify(draft.revision ?? null)} over revision ${applied}: ${draftChanges(draft)}`);
    const unused = draftValues(draft, "unused");
    if (unused.length > 0) note(`Not declared in app.toml: ${unused.join(", ")}`);
    return { ...body, revision: draft.revision, draft: key };
}

// PORT: cloud.rs's `initial_values`: a new app's env and secrets.
export function initialValues(policy, explicit, fillEnv) {
    const { pending } = collectValues(
        "Retry with `--fill`, or `--fill-non-interactive` to read same-named environment variables",
        without(policy, explicit), {}, [], fillEnv,
    );
    const values = { env: {}, secrets: {} };
    for (const { kind, name, value } of [...explicit, ...pending]) values[kind][name] = value;
    return values;
}

// PORT: deploy.rs's `optional_unset`: optional declarations left unset by a fill.
export function unsetOptional(filled) {
    return filled.declarations
        .filter((declaration) => declaration.action === "unset")
        .map((declaration) => `${declaration.kind === "secrets" ? "secret" : "env"} ${declaration.name}`);
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}
