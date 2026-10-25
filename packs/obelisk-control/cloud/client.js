import { parseApiResponse } from "../../../vendor/obelisk-api/index.js";

// PORT: obelisk's cloud.rs `Client`: provisioner requests authenticated by the cloud token.
import { errorMessage } from "./output.js";
import { validateCloudAppName } from "./policy.js";

export function cloudBase() {
    const base = process.env["OBELISK_CLOUD_API_URL"];
    if (!base) throw "OBELISK_CLOUD_API_URL is not configured";
    return base.replace(/\/+$/, "");
}

export function cloudToken() {
    const token = process.env["OBELISK_CLOUD_API_TOKEN"];
    if (!token) throw "OBELISK_CLOUD_API_TOKEN is not configured";
    return token;
}

// `kind`: "read", "command" (sends an Idempotency-Key), "secret" (redacts error bodies) or "secret-command" (both).
export async function cloudRequest(method, segments, { body, kind = "read", commandId, verbose = false, log } = {}) {
    const headers = { accept: "application/json", authorization: `Bearer ${cloudToken()}` };
    let id = null;
    if (kind === "command" || kind === "secret-command") {
        id = commandId || executionIdTopLevel();
        if (verbose && log) log(`Cloud command execution ID: ${id}`);
        headers["idempotency-key"] = id;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const url = `${cloudBase()}/${segments.map(encodeURIComponent).join("/")}`;
    let response;
    try {
        response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) {
        throw id ? `Cloud request failed; retry the same command with --command-id ${id}` : `Cloud request failed: ${error}`;
    }
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
        if (kind === "secret" || kind === "secret-command") throw `Cloud secret operation failed: HTTP ${response.status}`;
        if (verbose) throw `Cloud API returned ${response.status}: ${text}`;
        const message = errorMessage(text);
        throw id ? `${message} (HTTP ${response.status}). Command ID: ${id}` : `${message} (HTTP ${response.status})`;
    }
    if (text.trim() === "") return null;
    try {
        return JSON.parse(text);
    } catch {
        throw id ? `Cannot read cloud response; retry the same command with --command-id ${id}` : "Cannot read cloud response";
    }
}

export function appRequest(name, method, suffix, options) {
    return cloudRequest(method, ["v1", "apps", name, ...suffix], options);
}

// The app row, or null when the provisioner has no such app.
export async function lookupApp(name) {
    try {
        return await appRequest(name, "GET", []);
    } catch (error) {
        if (typeof error === "string" && /\(HTTP 404\)$/.test(error)) return null;
        throw error;
    }
}

// PORT: cloud.rs's `api_origin`.
export function apiOrigin(value) {
    if (typeof value !== "string") throw "Provisioner response is missing api_url";
    let url;
    try {
        url = new URL(value);
    } catch {
        throw `invalid API URL ${value}`;
    }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) throw "API URL must use HTTP or HTTPS";
    if (url.username || url.password || url.search || url.hash) throw "API URL must not contain credentials, query or fragment";
    return value.replace(/\/+$/, "");
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// A fresh `E_<ULID>` top-level execution ID, the provisioner's idempotency key format.
export function executionIdTopLevel() {
    let time = Date.now();
    let timePart = "";
    for (let i = 0; i < 10; i++) {
        timePart = CROCKFORD[time % 32] + timePart;
        time = Math.floor(time / 32);
    }
    let random = "";
    for (let i = 0; i < 16; i++) random += CROCKFORD[Math.floor(Math.random() * 32)];
    return `E_${timePart}${random}`;
}

// GET on an app's own API, authenticated by the cloud token.
export async function appApiGet(apiUrl, segments) {
    const url = `${apiOrigin(apiUrl)}/${segments.map(encodeURIComponent).join("/")}`;
    let response;
    try {
        response = await fetch(url, { headers: { accept: "application/json", authorization: `Bearer ${cloudToken()}` } });
    } catch (error) {
        throw `App API request failed: ${error}`;
    }
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) throw `server returned ${response.status}: ${text}`;
    try {
        return parseApiResponse("GET", "/" + segments.join("/"), JSON.parse(text));
    } catch (error) {
        throw `Cannot read app API response: ${error}`;
    }
}

// PORT: cloud.rs's `endpoints`: an app's URLs follow from its name and OBELISK_CLOUD_APPS_DOMAIN.
export function appEndpoints(name) {
    const domain = (process.env["OBELISK_CLOUD_APPS_DOMAIN"] || "obelisk.works").toLowerCase();
    const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
    if (domain.length > 253 || !domain.split(".").every((part) => label.test(part))) {
        throw "Invalid apps domain: expected a DNS hostname without scheme, port or path";
    }
    const hostname = `${name}.${domain}`;
    if (hostname.length + "webui--".length > 253) throw "App hostname exceeds the DNS length limit";
    return {
        api_url: `https://api--${hostname}`,
        webhook_url: `https://${hostname}`,
        webui_url: `https://webui--${hostname}`,
    };
}

// One request on the app's API at `path` (starting with `/`), authenticated by the cloud token.
export async function appApiRequest(app, method, path, contentType, body) {
    validateCloudAppName(app);
    if (typeof path !== "string" || !path.startsWith("/")) throw `invalid app API path ${path}`;
    const headers = { accept: "application/json", authorization: `Bearer ${cloudToken()}` };
    if (contentType) headers["content-type"] = contentType;
    let response;
    try {
        response = await fetch(`${appEndpoints(app).api_url}${path}`, { method, headers, body: body ?? undefined });
    } catch (error) {
        throw `error sending request for url (${appEndpoints(app).api_url}${path}): ${error}`;
    }
    return { status: response.status, body: await response.text() };
}

export function stagedRevision(value) {
    if (!Number.isInteger(value?.revision)) throw "Cloud response is missing the staged configuration revision";
    return value.revision;
}
