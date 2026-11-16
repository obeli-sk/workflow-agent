// PORT: obelisk's cloud.rs `explicit_values`, `stage_values`, `apply_request` and `initial_values` (non-interactive).
import { draftRequest } from "./client.js";
import { configName } from "./policy.js";
import { draftArg, draftChanges, draftValues } from "./output.js";

// The policy's env names that the app supplies values for.
function declarations(policy) {
    return policy.public_env
        .filter((entry) => entry.type !== "internal")
        .map((entry) => (typeof entry === "string" ? { name: entry, optional: false } : entry));
}

// Secret values come from the user, never through the agent.
export const USER_SETS_SECRETS = "ask the user to set them with their own `obelisk cloud app secrets set` or in the dashboard, then run `obelisk cloud app apply`";

// The policy's required secrets that the app supplies, which a new app cannot start without.
export function requiredSecrets(policy) {
    return Object.entries(policy.secrets ?? {})
        .filter(([, secret]) => secret.type !== "internal" && secret.optional !== true)
        .map(([name]) => name);
}

// The error for an app whose required secrets the user has not set: stage instead, so the user
// can set them before applying.
export function needsUserSecrets(name, secrets) {
    return `App ${name} requires secret(s) ${secrets.join(", ")}, which only the user sets. Stage the app with \`obelisk cloud app stage --app ${name} -d DEPLOYMENT\` (or \`--empty-deployment\`) and ${USER_SETS_SECRETS}`;
}

// PORT: cloud.rs's `user_supplied_policy`: the policy minus env vars that cloud integrations supply.
export function userSuppliedPolicy(config) {
    const supplied = new Set(Object.values(config.cloud?.integrations ?? {}).map((integration) => integration.env));
    const publicEnv = (config.policy?.public_env ?? []).filter((entry) => !supplied.has(typeof entry === "string" ? entry : entry.name));
    return { ...config.policy, public_env: publicEnv };
}

// PORT: cloud.rs's `collect_values` without the prompt, for env only: secrets are left to the
// user. `fillEnv` is the shell's exported variables for `--fill-non-interactive`, else null
// (only check that required values are set).
function collectValues(fillHint, policy, envValues, fillEnv) {
    const all = declarations(policy).map((entry) => ({ kind: "env", ...entry, exists: hasOwn(envValues, entry.name), current: envValues[entry.name] }));
    const pending = [];
    const report = [];
    const missing = [];
    for (const { kind, name, optional, exists, current } of all) {
        configName(name);
        const source = fillEnv !== null && hasOwn(fillEnv, name) ? fillEnv[name] : undefined;
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
            missing.push(`env ${name}`);
            action = "missing";
        }
        report.push({ kind, name, optional, action });
    }
    if (missing.length > 0) {
        throw `Missing required configuration: ${missing.join(", ")}. ${fillEnv !== null ? "Set them as environment variables of the same name" : fillHint}`;
    }
    return { report, pending };
}

// PORT: cloud.rs's `explicit_values`: `--env` values; a bare name reads the same-named
// variable of `env`, the shell's exported variables.
export function explicitValues(envFlags, env) {
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
    return pending;
}

// PORT: cloud.rs's `without`: drops declarations of `explicit` values, which are not collected again.
function without(policy, explicit) {
    const given = (kind, name) => explicit.some((value) => value.kind === kind && value.name === name);
    return {
        ...policy,
        public_env: (policy.public_env ?? []).filter((entry) => !given("env", typeof entry === "string" ? entry : entry.name)),
    };
}

// PORT: cloud.rs's `stage_values`: stages `explicit` values into the existing draft `key` (whose
// view is `draft`), then the remaining declared values of `fillEnv`; a null `fillEnv` stages only
// `explicit`. Returns the latest draft view and the fill report.
export async function stageValues(app, key, draft, explicit, fillEnv) {
    const staged = [];
    const put = async ({ kind, name, value }) => {
        let view;
        try {
            view = await draftRequest(app, key, "PUT", [kind, name], { body: { value } });
        } catch (error) {
            throw `Could not stage ${kind} ${name} in draft \`${key}\`; earlier values may already be staged\n\nCaused by:\n    ${error}`;
        }
        staged.push({ kind, name });
        return view;
    };
    for (const value of explicit) draft = await put(value);
    let report = [];
    if (fillEnv !== null) {
        if (draft?.env === null || typeof draft?.env !== "object" || Array.isArray(draft.env)) throw "Invalid cloud draft environment";
        let pending;
        ({ report, pending } = collectValues(
            "Retry with `--fill` or `--fill-non-interactive`",
            without(userSuppliedPolicy(draft), explicit), draft.env, fillEnv,
        ));
        for (const value of pending) draft = await put(value);
    }
    return { draft, filled: { draft: key, staged, declarations: report } };
}

// PORT: cloud.rs's `apply_request`: applies the current contents of draft `key`, or re-applies
// the applied revision without one. `note` receives the human progress lines.
export function applyRequest(name, key, draft, current, deploymentId, force, note) {
    const body = { force, deployment_id: deploymentId };
    const applied = JSON.stringify(current?.applied_revision ?? null);
    if (draft === null) {
        note(`Re-applying revision ${applied}`);
        return { ...body, revision: current?.applied_revision };
    }
    if (draft.stale === true) {
        throw `Draft \`${key}\` was opened on revision ${JSON.stringify(draft.parent_revision ?? null)}, but revision ${applied} was applied since; discard it with \`obelisk cloud app unstage --app ${name}${draftArg(key)}\``;
    }
    const missing = draftValues(draft, "missing");
    if (missing.length > 0) {
        throw `Missing values in draft \`${key}\`: ${missing.join(", ")}. Stage env with \`obelisk cloud app env set\`${draftArg(key)}; for secrets, ${USER_SETS_SECRETS}`;
    }
    note(`Applying draft \`${key}\` revision ${JSON.stringify(draft.revision ?? null)} over revision ${applied}: ${draftChanges(draft)}`);
    const unused = draftValues(draft, "unused");
    if (unused.length > 0) note(`Not declared in app.toml: ${unused.join(", ")}`);
    return { ...body, draft: key };
}

// PORT: cloud.rs's `initial_values`: a new app's env. `name` is the app, for the error when
// the policy requires secrets, which only the user sets.
export function initialValues(name, policy, explicit, fillEnv) {
    const secrets = requiredSecrets(policy);
    if (secrets.length > 0) throw needsUserSecrets(name, secrets);
    const { pending } = collectValues(
        "Retry with `--fill`, or `--fill-non-interactive` to read same-named environment variables",
        without(policy, explicit), {}, fillEnv,
    );
    const env = {};
    for (const { name: key, value } of [...explicit, ...pending]) env[key] = value;
    return { env, secrets: {} };
}

// PORT: deploy.rs's `optional_unset`: optional declarations left unset by a fill.
export function unsetOptional(filled) {
    return filled.declarations
        .filter((declaration) => declaration.action === "unset")
        .map((declaration) => `env ${declaration.name}`);
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}
