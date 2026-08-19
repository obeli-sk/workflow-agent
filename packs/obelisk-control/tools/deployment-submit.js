// obelisk-agent:tools/webapi.deployment-submit:
//   func(deployment-toml: string, attachments: list<record { path: string, digest: string, content: string }>,
//        description: string, allow-missing-runtime-config: bool, deployment-id: string)
//        -> result<string /* deployment-id */,
//             variant { permanent-missing-files(list<record { path: string, digest: string }>),
//               permanent-error(string), transient-error(string), execution-failed }>
//
// A single stateless POST to /v1/deployments. The deterministic workflow owns
// the preflight/attach loop, so this activity never hashes or rewrites the TOML:
//   - called with no `attachments`, it does a JSON preflight submit;
//   - called with `attachments`, it does a multipart submit carrying those blobs.
// It returns the new deployment id on success. A 409 incomplete-package response
// is the `permanent-missing-files` error arm, which the workflow recovers from by
// attaching exactly those files and re-invoking. A 409 whose problems cannot be fixed by
// attaching blobs (a missing content_digest field, unexpected/oversized files, a
// digest mismatch) is a permanent error. The submitted manifest already carries
// every content_digest (the workflow expands them from the file bytes), so
// nothing here computes a digest.
export default async function deployment_submit(
    deploymentToml, attachments, description, allowMissing, deploymentId,
) {
    try {
        return await deployment_submit_impl(
            deploymentToml, attachments, description, allowMissing, deploymentId,
        );
    } catch (error) {
        throw classifySubmitError(error);
    }
}

async function deployment_submit_impl(
    deploymentToml, attachments, description, allowMissing, deploymentId,
) {
    if (typeof deploymentToml !== "string" || !deploymentToml.trim()) {
        throw "deployment-toml is required";
    }
    const base = process.env["TARGET_OBELISK_API_URL"];
    if (!base) throw "TARGET_OBELISK_API_URL is not configured";
    const token = process.env["TARGET_OBELISK_TOKEN"];
    const wantedId = (typeof deploymentId === "string" && deploymentId.trim())
        ? deploymentId.trim() : null;
    const desc = (typeof description === "string" && description.trim())
        ? description.trim() : null;
    const files = Array.isArray(attachments) ? attachments : [];

    let response;
    if (files.length === 0) {
        // Preflight: JSON submit with no blobs. Succeeds when every referenced
        // digest is already in the CAS.
        const body = {
            deployment_toml: deploymentToml,
            allow_unavailable_runtime_config: Boolean(allowMissing),
        };
        if (desc) body.description = desc;
        if (wantedId) body.deployment_id = wantedId;
        response = await fetch(`${base}/v1/deployments`, {
            method: "POST",
            headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(body),
        });
    } else {
        // The server's multipart parser recognizes exactly these text field names
        // and treats every other part as a file blob (name = digest, filename =
        // path). A stale text field name would be read as a bogus empty-path file
        // and rejected with a `files[path=]` digest mismatch.
        const boundary = `----obelisk${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
        const multipartBody = buildMultipart(boundary, {
            deployment_toml: deploymentToml,
            description: desc,
            allow_unavailable_runtime_config: Boolean(allowMissing) ? "true" : "false",
            deployment_id: wantedId,
        }, files);
        response = await fetch(`${base}/v1/deployments`, {
            method: "POST",
            headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": `multipart/form-data; boundary=${boundary}` },
            body: multipartBody,
        });
    }

    if (response.ok) {
        return parseId(await response.text());
    }
    if (response.status !== 409) {
        throw `HTTP ${response.status}: ${await response.text()}`;
    }
    // Incomplete package. Blockers the workflow cannot fix by attaching blobs are
    // permanent; otherwise raise the `permanent-missing-files` arm so the workflow
    // attaches exactly these blobs and resubmits.
    const detail = JSON.parse(await response.text());
    const blockers = describeUnfixable(detail);
    if (blockers) throw `deployment cannot be submitted: ${blockers}`;
    const missing = Array.isArray(detail.missing_files) ? detail.missing_files : [];
    if (missing.length === 0) throw `submit rejected (409) with no actionable missing files: ${JSON.stringify(detail)}`;
    throw { permanent_missing_files: missing.map((issue) => ({ path: issue.path, digest: issue.digest })) };
}

function classifySubmitError(error) {
    // The `permanent-missing-files` arm and pre-classified tool-errors pass through as-is.
    if (error && Array.isArray(error.permanent_missing_files)) return error;
    if (error?.permanent_error || error?.transient_error) return error;
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(/\bHTTP (\d+)/.exec(message)?.[1]);
    const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
    return permanent || (!status && !(error instanceof Error))
        ? { permanent_error: message } : { transient_error: message };
}

// The submit endpoint returns the new deployment ID, either as the JSON object
// { deployment_id } (Accept: application/json) or a bare/quoted string.
function parseId(text) {
    const trimmed = text.trim();
    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "string") return parsed;
        if (parsed && typeof parsed.deployment_id === "string") return parsed.deployment_id;
        if (parsed && typeof parsed.ok === "string") return parsed.ok;
    } catch (_) { /* bare string */ }
    return trimmed;
}

// Summarize package problems the workflow cannot fix by attaching blobs, so the
// error is actionable rather than a silent failed retry.
function describeUnfixable(detail) {
    const parts = [];
    const list = (issues, label) => {
        if (Array.isArray(issues) && issues.length) {
            parts.push(`${label}: ${issues.map((i) => i.field_path || i.path || i.digest || "?").join(", ")}`);
        }
    };
    list(detail.missing_digest_fields, "missing content_digest");
    list(detail.unexpected_files, "unexpected files");
    list(detail.oversized_files, "oversized files");
    if (Array.isArray(detail.digest_mismatches) && detail.digest_mismatches.length) {
        parts.push(`digest mismatches: ${detail.digest_mismatches.map((m) => (m.file && m.file.path) || "?").join(", ")}`);
    }
    return parts.length ? parts.join("; ") : null;
}

// --- multipart/form-data (UTF-8 string body) ---------------------------------
// Boa's fetch only accepts a string body, so the package is built as a UTF-8
// string. Every attached file is a script source (UTF-8), so no binary part is
// needed. Each blob's form-field `name` is its sha256 digest (supplied by the
// workflow from the server's missing-files list); its `filename` is the
// deployment-relative path.
function buildMultipart(boundary, fields, files) {
    let out = "";
    for (const [name, value] of Object.entries(fields)) {
        if (value === null || value === undefined) continue;
        out += `--${boundary}\r\n`;
        out += `Content-Disposition: form-data; name="${name}"\r\n\r\n`;
        out += `${value}\r\n`;
    }
    for (const file of files) {
        const name = file.digest || "file";
        out += `--${boundary}\r\n`;
        out += `Content-Disposition: form-data; name="${name}"; filename="${file.path}"\r\n`;
        out += "Content-Type: application/octet-stream\r\n\r\n";
        out += `${file.content}\r\n`;
    }
    out += `--${boundary}--\r\n`;
    return out;
}
