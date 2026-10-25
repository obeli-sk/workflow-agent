// PORT: obelisk's `AppConfigToml::policy` (src/config/app.rs): app.toml text
// to the `{app_name, policy, cloud}` the provisioner stores.
import { parseToml } from "./toml.js";

const TOP_LEVEL = ["app_name", "cloud", "secrets", "public_env", "allowed_exec_activities", "outbound_http"];
const HOST_FIELDS = ["pattern", "url_prefix", "url_regex_suffix", "methods", "request_url_regex", "secrets", "replace_in"];

export function appConfig(text, path = "app.toml") {
    let toml;
    try {
        toml = parseToml(text);
    } catch (error) {
        throw `Invalid app policy ${path}: ${error}`;
    }
    const fail = (message) => {
        throw `Invalid app policy ${path}: ${message}`;
    };
    for (const key of Object.keys(toml)) {
        if (!TOP_LEVEL.includes(key)) fail(`unknown field \`${key}\``);
    }
    if (toml.app_name !== undefined && typeof toml.app_name !== "string") fail("app_name must be a string");

    const cloud = {};
    for (const [key, value] of Object.entries(table(toml.cloud, "cloud", fail))) {
        if (key === "memory_mb") {
            if (!Number.isInteger(value) || value <= 0) fail("cloud.memory_mb must be a positive integer");
            cloud.memory_mb = value;
        } else if (key === "integrations") {
            const integrations = cloudIntegrations(value, fail);
            if (Object.keys(integrations).length > 0) cloud.integrations = integrations;
        } else {
            fail(`unknown field \`cloud.${key}\``);
        }
    }

    const secrets = {};
    for (const name of Object.keys(table(toml.secrets, "secrets", fail)).sort()) {
        const secret = table(toml.secrets[name], `secrets.${name}`, fail);
        const exposedTo = exposure(secret.exposed_to, `secrets.${name}.exposed_to`, fail);
        if (secret.type === "internal") {
            if ("optional" in secret) fail(`secrets.${name}: internal secrets cannot be optional`);
            secrets[name] = { type: "internal", exposed_to: exposedTo };
        } else if (secret.type === undefined || secret.type === "env") {
            if (secret.optional !== undefined && typeof secret.optional !== "boolean") fail(`secrets.${name}.optional must be a boolean`);
            secrets[name] = { optional: secret.optional === true, exposed_to: exposedTo };
        } else {
            fail(`secrets.${name}.type must be "env" or "internal"`);
        }
        for (const key of Object.keys(secret)) {
            if (!["type", "optional", "exposed_to"].includes(key)) fail(`unknown field \`secrets.${name}.${key}\``);
        }
    }

    const publicEnv = Object.entries(table(toml.public_env, "public_env", fail))
        .map(([name, config]) => {
            config = table(config, `public_env.${name}`, fail);
            const internal = config.type === "internal";
            for (const key of Object.keys(config)) {
                if (!(internal ? ["type", "source"] : ["type", "optional"]).includes(key)) fail(`unknown field \`public_env.${name}.${key}\``);
            }
            if (internal) {
                if (!["api-url", "webui-url"].includes(config.source)) fail(`public_env.${name}.source must be "api-url" or "webui-url"`);
                return { name, type: "internal", source: config.source };
            }
            if (config.type !== undefined && config.type !== "env") fail(`public_env.${name}.type must be "env" or "internal"`);
            if (config.optional !== undefined && typeof config.optional !== "boolean") fail(`public_env.${name}.optional must be a boolean`);
            return config.optional === true ? { name, optional: true } : name;
        })
        .sort((a, b) => compare(entryName(a), entryName(b)));

    validateCloudIntegrations(cloud.integrations ?? {}, toml.public_env ?? {}, toml.secrets ?? {});

    const outbound = table(toml.outbound_http, "outbound_http", fail);
    for (const key of Object.keys(outbound)) {
        if (key !== "allowed_host") fail(`unknown field \`outbound_http.${key}\``);
    }
    const hosts = outbound.allowed_host ?? [];
    if (!Array.isArray(hosts)) fail("outbound_http.allowed_host must be an array of tables");
    const outboundHttp = hosts.map((host, index) => allowedHost(host, `outbound_http.allowed_host[${index}]`, fail));

    return {
        appName: toml.app_name ?? null,
        policy: {
            format: "obelisk-app-config-v1",
            secrets,
            public_env: publicEnv,
            allowed_exec_activities: exposure(toml.allowed_exec_activities, "allowed_exec_activities", fail),
            outbound_http: outboundHttp,
        },
        cloud,
    };
}

// `{ name = { type, env } }`, sorted by name.
function cloudIntegrations(value, fail) {
    const out = {};
    for (const name of Object.keys(table(value, "cloud.integrations", fail)).sort()) {
        const label = `cloud.integrations.${name}`;
        const integration = table(value[name], label, fail);
        for (const key of Object.keys(integration)) {
            if (!["type", "env"].includes(key)) fail(`unknown field \`${label}.${key}\``);
        }
        if (typeof integration.type !== "string") fail(`${label}.type must be a string`);
        if (typeof integration.env !== "string") fail(`${label}.env must be a string`);
        out[name] = { type: integration.type, env: integration.env };
    }
    return out;
}

// PORT: `AppConfigToml::validate_cloud_integrations`.
function validateCloudIntegrations(integrations, publicEnv, secrets) {
    const supplied = new Set();
    for (const [name, integration] of Object.entries(integrations)) {
        if (name === "" || integration.type === "") throw "Cloud integration name and type must not be empty";
        const declaration = Object.prototype.hasOwnProperty.call(publicEnv, integration.env) ? publicEnv[integration.env] : undefined;
        if (declaration === undefined || declaration.type === "internal") {
            throw `Cloud integration \`${name}\` env \`${integration.env}\` must reference an environment-backed [public_env] declaration`;
        }
        if (Object.prototype.hasOwnProperty.call(secrets, integration.env)) throw `Cloud integration \`${name}\` env must not reference a secret`;
        if (supplied.has(integration.env)) throw `Multiple cloud integrations supply \`${integration.env}\``;
        supplied.add(integration.env);
    }
}

function allowedHost(host, label, fail) {
    table(host, label, fail);
    for (const key of Object.keys(host)) {
        if (!HOST_FIELDS.includes(key)) fail(`unknown field \`${label}.${key}\``);
    }
    // Either a `pattern` (optionally narrowed by `request_url_regex`) or a
    // `url_prefix` (optionally followed by `url_regex_suffix`), never both.
    const prefixed = host.url_prefix !== undefined;
    if (prefixed) {
        if (typeof host.url_prefix !== "string") fail(`${label}.url_prefix must be a string`);
        if (host.pattern !== undefined || host.request_url_regex !== undefined) {
            fail(`${label}: url_prefix cannot be combined with pattern or request_url_regex`);
        }
        if (host.url_regex_suffix !== undefined && typeof host.url_regex_suffix !== "string") {
            fail(`${label}.url_regex_suffix must be a string`);
        }
    } else {
        if (typeof host.pattern !== "string") fail(`${label}.pattern must be a string`);
        if (host.url_regex_suffix !== undefined) fail(`${label}.url_regex_suffix requires url_prefix`);
    }
    const secrets = (host.secrets ?? []).map((secret) => {
        if (typeof secret === "string") return secret;
        if (secret && typeof secret.name === "string") return secret.optional === true ? { name: secret.name, optional: true } : secret.name;
        return fail(`${label}.secrets entries must be names or { name, optional } tables`);
    });
    // Field order and omissions follow the server's stored policy (GET /v1/app-policy).
    const origin = prefixed
        ? { url_prefix: host.url_prefix, ...(host.url_regex_suffix !== undefined && { url_regex_suffix: host.url_regex_suffix }) }
        : { pattern: host.pattern };
    return {
        ...origin,
        methods: host.methods ?? null,
        request_url_regex: host.request_url_regex ?? null,
        secrets,
        replace_in: host.replace_in ?? [],
    };
}

// `{ component = ["sha256:..."] }`, each digest list sorted.
function exposure(value, label, fail) {
    const out = {};
    for (const [name, digests] of Object.entries(table(value, label, fail))) {
        if (!Array.isArray(digests) || !digests.every((d) => typeof d === "string")) fail(`${label}.${name} must be a list of digests`);
        out[name] = [...digests].sort();
    }
    return out;
}

function table(value, label, fail) {
    if (value === undefined) return {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a table`);
    return value;
}

function entryName(entry) {
    return typeof entry === "string" ? entry : entry.name;
}

function compare(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
}

// The app name rules the provisioner enforces.
export function validateAppName(name) {
    if (
        typeof name !== "string" || name.length < 4 || name.length > 25
        || !/^[a-z0-9-]+$/.test(name) || name.startsWith("-") || name.endsWith("-")
    ) {
        throw `invalid app name \`${name}\`: expected a DNS label (4-25 lowercase ASCII letters, digits, or interior hyphens)`;
    }
}

// PORT: cloud.rs's `validate_cloud_app_name`.
export function validateCloudAppName(name) {
    validateAppName(name);
    if (name.length > 20 || name.includes("--") || name.startsWith("system-") || name.startsWith("integrations-")) {
        throw "Cloud app names must contain 4-20 lowercase letters, digits or single interior hyphens; system- and integrations- are reserved";
    }
}

// PORT: cloud.rs's `config_name`.
export function configName(name) {
    if (typeof name !== "string" || name.length === 0 || name.length > 128 || /^\d/.test(name) || !/^[A-Za-z0-9_]+$/.test(name)) {
        throw `Invalid configuration name: ${name ?? ""}`;
    }
}
