// obelisk-agent:tools/webapi.deployment-submit:
//   func(deployment-toml: string, edited-files-json: string, description: string,
//        allow-missing-runtime-config: bool, deployment-id: string)
//        -> result<string, string>
//
// Submit a deployment manifest as a new **inactive** deployment and return
//   { deployment_id, deployment_toml }
// where deployment_toml is the verbatim stored manifest (with content_digest
// filled in for every edited file). Activation (enqueue / hot redeploy) is a
// separate step.
//
// `edited-files-json` is a JSON array `[{ path, content }]` of deployment-owned
// script/exec sources the agent changed (path = the manifest `location` string).
// The server requires `content_digest` for every owned file and stores only
// complete packages, so this tool:
//   1. computes sha256 of each edited file and writes it into the matching
//      `location` block's `content_digest`;
//   2. preflights a JSON submit (no blobs) — succeeds when every referenced
//      digest is already in the CAS;
//   3. on a 409 incomplete-package response, retries as a multipart package
//      attaching only the listed missing files (all UTF-8 scripts).
// An empty deployment-id lets the server allocate one; a non-empty value
// requests an idempotent submission under that ID.
export default async function deployment_submit(
    deploymentToml, editedFilesJson, description, allowMissing, deploymentId,
) {
    if (typeof deploymentToml !== "string" || !deploymentToml.trim()) {
        throw "deployment-toml is required";
    }
    let editedFiles;
    try {
        editedFiles = editedFilesJson ? JSON.parse(editedFilesJson) : [];
    } catch (e) {
        throw `edited-files-json must be valid JSON: ${e.message}`;
    }
    if (!Array.isArray(editedFiles)) throw "edited-files-json must be a JSON array";

    // Fill content_digest for every edited file, and index content by digest so
    // the multipart retry can attach exactly the blobs the server is missing.
    let toml = deploymentToml;
    const contentByDigest = {};
    const contentByPath = {};
    for (const file of editedFiles) {
        const path = file && file.path;
        const content = file && file.content;
        if (typeof path !== "string" || !path) throw "each edited file needs a path";
        if (typeof content !== "string") throw `edited file ${path} has no string content`;
        const digest = `sha256:${sha256Hex(content)}`;
        toml = setContentDigest(toml, path, digest);
        contentByDigest[digest] = content;
        contentByPath[path] = content;
    }

    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const wantedId = (typeof deploymentId === "string" && deploymentId.trim())
        ? deploymentId.trim() : null;

    // 1) Preflight: JSON submit with no blobs.
    const body = { deployment_toml: toml, allow_missing_runtime_config: Boolean(allowMissing) };
    if (typeof description === "string" && description.trim()) body.description = description.trim();
    if (wantedId) body.deployment_id = wantedId;

    const preflight = await fetch(`${base}/v1/deployments`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(body),
    });
    if (preflight.ok) {
        return JSON.stringify({ deployment_id: parseId(await preflight.text()), deployment_toml: toml });
    }
    if (preflight.status !== 409) {
        throw `HTTP ${preflight.status}: ${await preflight.text()}`;
    }

    // 2) Incomplete package: attach the missing files and retry as multipart.
    const detail = JSON.parse(await preflight.text());
    const blockers = describeUnfixable(detail);
    if (blockers) throw `deployment cannot be submitted: ${blockers}`;
    const missing = Array.isArray(detail.missing_files) ? detail.missing_files : [];
    if (missing.length === 0) throw `submit rejected (409) with no actionable missing files: ${JSON.stringify(detail)}`;

    const attach = [];
    for (const issue of missing) {
        const content = pickContent(issue, contentByDigest, contentByPath);
        if (content === undefined) {
            throw `server is missing blob for ${issue.path || issue.digest || "?"} but it was not edited; re-edit the component to supply its source`;
        }
        attach.push({ digest: issue.digest, path: issue.path, content });
    }

    const boundary = `----obelisk${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const multipartBody = buildMultipart(boundary, {
        deployment_toml: toml,
        description: (typeof description === "string" && description.trim()) ? description.trim() : null,
        allow_missing_runtime_config: Boolean(allowMissing) ? "true" : "false",
        deployment_id: wantedId,
    }, attach);

    const retry = await fetch(`${base}/v1/deployments`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": `multipart/form-data; boundary=${boundary}` },
        body: multipartBody,
    });
    if (!retry.ok) throw `HTTP ${retry.status}: ${await retry.text()}`;
    return JSON.stringify({ deployment_id: parseId(await retry.text()), deployment_toml: toml });
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

// Find the content for a missing-file issue, preferring its digest then its path.
function pickContent(issue, byDigest, byPath) {
    if (issue && typeof issue.digest === "string" && issue.digest in byDigest) return byDigest[issue.digest];
    if (issue && typeof issue.path === "string" && issue.path in byPath) return byPath[issue.path];
    return undefined;
}

// Summarize package problems the agent cannot fix by attaching blobs, so the
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

// --- TOML content_digest editing ---------------------------------------------
// Set `content_digest` in *every* component table whose `location = "<path>"`,
// replacing an existing key in that table or inserting it after the location
// line. Operates textually so the rest of the manifest is preserved verbatim.
// All tables are updated because the server requires that refs sharing a path
// resolve to the same digest.
function setContentDigest(toml, path, digest) {
    const lines = toml.split("\n");
    const digestLine = `content_digest = "${digest}"`;
    const locIdxs = [];
    for (let i = 0; i < lines.length; i += 1) {
        if (keyStringValue(lines[i], "location") === path) locIdxs.push(i);
    }
    if (locIdxs.length === 0) throw `no component with location "${path}" in the manifest`;
    // Process bottom-up so an insert never shifts an index we have yet to handle.
    for (let n = locIdxs.length - 1; n >= 0; n -= 1) {
        const idx = locIdxs[n];
        // The owning main table runs from its `[[...]]` header up to the next
        // line that starts a table (`[` after trimming). `content_digest` is a
        // sibling key in that table.
        let end = lines.length;
        for (let i = idx + 1; i < lines.length; i += 1) {
            if (lines[i].trimStart().startsWith("[")) { end = i; break; }
        }
        let start = 0;
        for (let i = idx; i >= 0; i -= 1) {
            if (lines[i].trimStart().startsWith("[")) { start = i; break; }
        }
        let replaced = false;
        for (let i = start + 1; i < end; i += 1) {
            if (lines[i].trimStart().startsWith("content_digest")) {
                lines[i] = digestLine;
                replaced = true;
                break;
            }
        }
        if (!replaced) lines.splice(idx + 1, 0, digestLine);
    }
    return lines.join("\n");
}

// Parse a simple `key = "value"` line and return the string value when its key
// matches, else null. Tolerant of surrounding whitespace.
function keyStringValue(line, key) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(key)) return null;
    const rest = trimmed.slice(key.length).trim();
    if (!rest.startsWith("=")) return null;
    const value = rest.slice(1).trim();
    if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') return null;
    return value.slice(1, -1);
}

// --- multipart/form-data (UTF-8 string body) ---------------------------------
// Boa's fetch only accepts a string body, so the package is built as a UTF-8
// string. Every attached file is a script source (UTF-8), so no binary part is
// needed. Each blob's form-field `name` is its claimed sha256 digest; its
// `filename` is the deployment-relative path.
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

// --- pure-JS sha256 ----------------------------------------------------------
// crypto.subtle in the Boa runtime only implements HMAC, so sha256 is computed
// here. Returns the lowercase hex digest of the string's UTF-8 bytes.
function sha256Hex(str) {
    const bytes = utf8Bytes(str);
    const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
    let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

    const len = bytes.length;
    const bitLen = len * 8;
    // Pad: 0x80, then zeros to 56 mod 64, then 64-bit big-endian length.
    const withOne = len + 1;
    const total = withOne + ((56 - (withOne % 64) + 64) % 64) + 8;
    const msg = new Uint8Array(total);
    msg.set(bytes);
    msg[len] = 0x80;
    // 64-bit length; high 32 bits are 0 for any realistic deployment file.
    msg[total - 4] = (bitLen >>> 24) & 0xff;
    msg[total - 3] = (bitLen >>> 16) & 0xff;
    msg[total - 2] = (bitLen >>> 8) & 0xff;
    msg[total - 1] = bitLen & 0xff;

    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i += 1) {
            w[i] = (msg[off + i * 4] << 24) | (msg[off + i * 4 + 1] << 16)
                | (msg[off + i * 4 + 2] << 8) | msg[off + i * 4 + 3];
        }
        for (let i = 16; i < 64; i += 1) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
        for (let i = 0; i < 64; i += 1) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;
            h = g; g = f; f = e; e = (d + t1) | 0;
            d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
    }
    return [h0, h1, h2, h3, h4, h5, h6, h7].map(toHex8).join("");
}

function toHex8(x) {
    return (x >>> 0).toString(16).padStart(8, "0");
}

// Encode a JS string to UTF-8 bytes without relying on TextEncoder.
function utf8Bytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i += 1) {
        let code = str.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
            const next = str.charCodeAt(i + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
                i += 1;
            }
        }
        if (code < 0x80) {
            out.push(code);
        } else if (code < 0x800) {
            out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
            out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        } else {
            out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
    }
    return Uint8Array.from(out);
}
