// PORT: obelisk's cloud.rs `Client`: provisioner requests authenticated by the cloud token.
import { errorMessage } from "./output.js";
import { validateCloudAppName } from "./policy.js";

export function cloudBase() {
    const base = process.env["OBELISK_CLOUD_API_URL"];
    if (!base) throw "OBELISK_CLOUD_API_URL is not configured";
    return base.replace(/\/+$/, "");
}

export function cloudToken() {
    const token = process.env["WORKFLOW_AGENT_CLOUD_TOKEN"];
    if (!token) throw "WORKFLOW_AGENT_CLOUD_TOKEN is not configured";
    return token;
}

// `kind`: "read", "command" (sends an Idempotency-Key), "secret" (redacts error bodies) or "secret-command" (both).
// `toml` sends a verbatim app.toml instead of a JSON `body`.
export async function cloudRequest(method, segments, { body, toml, kind = "read", commandId, verbose = false, log, query, draftId = null } = {}) {
    const headers = { accept: "application/json", authorization: `Bearer ${cloudToken()}` };
    if (draftId !== null) headers["if-match"] = `"draft-${draftId}"`;
    let id = null;
    if (kind === "command" || kind === "secret-command") {
        if (!commandId) throw "Cloud command requires a workflow-generated command ID";
        id = commandId;
        if (verbose && log) log(`Cloud command execution ID: ${id}`);
        headers["idempotency-key"] = id;
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    if (toml !== undefined) headers["content-type"] = "application/toml";
    const search = query ? `?${new URLSearchParams(query)}` : "";
    const url = `${cloudBase()}/${segments.map(encodeURIComponent).join("/")}${search}`;
    let response;
    try {
        response = await fetch(url, { method, headers, body: toml ?? (body === undefined ? undefined : JSON.stringify(body)) });
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

// One provisioner request for the shell, which reports the response itself: every status below
// 500 is returned, while a failed request or a server error is thrown so the activity is retried.
export async function provisionerResponse(method, segments, body = null, commandId = null, contentType = "application/json", draftId = null) {
    const headers = { accept: "application/json", authorization: `Bearer ${cloudToken()}` };
    if (commandId !== null) headers["idempotency-key"] = commandId;
    if (draftId !== null) headers["if-match"] = `"draft-${draftId}"`;
    if (body !== null) headers["content-type"] = contentType;
    const url = `${cloudBase()}/${segments.map(encodeURIComponent).join("/")}`;
    let response;
    try {
        response = await fetch(url, { method, headers, body: body ?? undefined });
    } catch (error) {
        throw `Cloud request failed: ${error}`;
    }
    const text = await response.text();
    if (response.status >= 500) throw `Cloud API returned ${response.status}: ${text}`;
    return { status: response.status, body: text };
}

export function appRequest(name, method, suffix, options) {
    return cloudRequest(method, ["v1", "apps", name, ...suffix], options);
}

function isNotFound(error) {
    return /\(HTTP 404\)$/.test(String(error));
}

// PORT: cloud.rs's `Client::draft`: an edit of draft `key`, opening it on the applied revision
// when missing. Edits take no idempotency key.
export async function draftRequest(name, key, method, suffix, options = {}) {
    const kind = method === "PUT" && suffix[0] === "secrets" ? "secret" : "read";
    let draft;
    try {
        draft = await appRequest(name, "GET", ["drafts", key], options);
    } catch (error) {
        if (!isNotFound(error)) throw error;
        const current = await appRequest(name, "GET", [], options);
        draft = await appRequest(name, "PUT", ["drafts", key], { ...options, body: { parent_revision: appliedRevision(current) } });
    }
    return appRequest(name, method, ["drafts", key, ...suffix], { ...options, kind, draftId: draft.draft_id });
}

// PORT: cloud.rs's `unstage`: discards draft `key` by its ID.
export async function discardDraft(name, key, options = {}) {
    let draft;
    try {
        draft = await appRequest(name, "GET", ["drafts", key], options);
    } catch (error) {
        if (!isNotFound(error)) throw error;
        return { discarded: false };
    }
    return appRequest(name, "DELETE", ["drafts", key], { ...options, draftId: draft.draft_id });
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

// PORT: cloud.rs's `direct_api_url`: the app's API URL follows from its name and OBELISK_CLOUD_APPS_DOMAIN.
function appApiUrl(name) {
    const domain = (process.env["OBELISK_CLOUD_APPS_DOMAIN"] || "obelisk.works").toLowerCase();
    const label = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
    if (domain.length > 253 || !domain.split(".").every((part) => label.test(part))) {
        throw "Invalid apps domain: expected a DNS hostname without scheme, port or path";
    }
    const hostname = `${name}.${domain}`;
    if (hostname.length + "internal--".length > 253) throw "App hostname exceeds the DNS length limit";
    return `https://api--${hostname}`;
}

// One request on the app's API at `path` (starting with `/`), authenticated by the cloud token.
export async function appApiRequest(app, method, path, contentType, body, accept = "application/json") {
    validateCloudAppName(app);
    if (typeof path !== "string" || !path.startsWith("/")) throw `invalid app API path ${path}`;
    const headers = { accept, authorization: `Bearer ${cloudToken()}` };
    if (contentType) headers["content-type"] = contentType;
    let response;
    try {
        response = await fetch(`${appApiUrl(app)}${path}`, { method, headers, body: body ?? undefined });
    } catch (error) {
        throw `error sending request for url (${appApiUrl(app)}${path}): ${error}`;
    }
    return { status: response.status, body: await response.text() };
}

export function appliedRevision(value) {
    if (!Number.isInteger(value?.applied_revision)) throw "Cloud response is missing the applied configuration revision";
    return value.applied_revision;
}

export function stagedRevision(value) {
    if (!Number.isInteger(value?.revision)) throw "Cloud response is missing the staged configuration revision";
    return value.revision;
}
