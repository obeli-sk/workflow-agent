// PORT: obelisk's `AppConfigToml::policy` (src/config/app.rs): app.toml text
// to the `{app_name, policy, cloud}` the provisioner stores.
import { parseToml } from "./toml.js";

const TOP_LEVEL = ["app_name", "cloud", "secrets", "public_env", "allowed_exec_activities", "outbound_http"];
const HOST_FIELDS = ["pattern", "methods", "request_url_regex", "secrets", "replace_in"];

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
        if (key !== "memory_mb") fail(`unknown field \`cloud.${key}\``);
        if (!Number.isInteger(value) || value <= 0) fail("cloud.memory_mb must be a positive integer");
        cloud.memory_mb = value;
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

function allowedHost(host, label, fail) {
    table(host, label, fail);
    for (const key of Object.keys(host)) {
        if (!HOST_FIELDS.includes(key)) fail(`unknown field \`${label}.${key}\``);
    }
    if (typeof host.pattern !== "string") fail(`${label}.pattern must be a string`);
    const secrets = (host.secrets ?? []).map((secret) => {
        if (typeof secret === "string") return secret;
        if (secret && typeof secret.name === "string") return secret.optional === true ? { name: secret.name, optional: true } : secret.name;
        return fail(`${label}.secrets entries must be names or { name, optional } tables`);
    });
    return {
        pattern: host.pattern,
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
