// PORT: vendor/just-bash-rs/src/commands/hash.rs
// base64 [-d] [-w COLS] [FILE], md5sum [-c] [FILE]..., sha256sum [FILE]...

import { ok, fail, unknownOption } from "./core.js";
import { utf8Encode, utf8Decode } from "../utf8.js";
import { isCasNamespacedDigest } from "../fs.js";

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Encode(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
        const b0 = bytes[i], b1 = bytes[i + 1], b2 = bytes[i + 2];
        const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
        out += B64_ALPHABET[(n >> 18) & 0x3f];
        out += B64_ALPHABET[(n >> 12) & 0x3f];
        out += b1 !== undefined ? B64_ALPHABET[(n >> 6) & 0x3f] : "=";
        out += b2 !== undefined ? B64_ALPHABET[n & 0x3f] : "=";
    }
    return out;
}

function base64Decode(text) {
    const cleaned = [...text].filter((c) => !/\s/.test(c));
    const values = [];
    for (const c of cleaned) {
        if (c === "=") break;
        const v = B64_ALPHABET.indexOf(c);
        if (v === -1) return null;
        values.push(v);
    }
    const out = [];
    for (let i = 0; i < values.length; i += 4) {
        const chunk = values.slice(i, i + 4);
        let n = 0;
        chunk.forEach((v, j) => { n |= v << (18 - 6 * j); });
        out.push((n >> 16) & 0xff);
        if (chunk.length > 2) out.push((n >> 8) & 0xff);
        if (chunk.length > 3) out.push(n & 0xff);
    }
    return out;
}

export function base64Command(interp, args, stdin) {
    let decode = false, wrap = 76;
    const files = [];
    for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === "-d" || a === "--decode") decode = true;
        else if ((a === "-w" || a === "--wrap") && args[i + 1] !== undefined) {
            i++;
            const v = parseInt(args[i], 10);
            if (Number.isNaN(v)) return fail("base64: invalid wrap size\n");
            wrap = v;
        } else if (a.startsWith("--wrap=")) {
            const v = parseInt(a.slice("--wrap=".length), 10);
            if (Number.isNaN(v)) return fail("base64: invalid wrap size\n");
            wrap = v;
        } else {
            files.push(a);
        }
    }
    if (wrap < 0) return fail("base64: invalid wrap size\n");

    let content = stdin;
    for (const f of files) {
        if (!interp.vfs.isFile(interp.resolvePath(f))) return fail(`base64: ${f}: No such file or directory\n`, 1);
        content += interp.vfs.readFile(interp.resolvePath(f));
    }

    if (decode) {
        const cleaned = content.replace(/\s/g, "");
        const bytes = base64Decode(cleaned);
        if (bytes === null) return fail("base64: invalid input\n", 1);
        return ok(utf8Decode(bytes));
    }

    let encoded = base64Encode(utf8Encode(content));
    if (wrap > 0) {
        const lines = [];
        for (let i = 0; i < encoded.length; i += wrap) lines.push(encoded.slice(i, i + wrap));
        encoded = lines.length ? `${lines.join("\n")}\n` : "";
    }
    return ok(encoded);
}

// ----- md5 -----

const MD5_K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];
const MD5_S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function rotl(x, n) {
    return ((x << n) | (x >>> (32 - n))) >>> 0;
}
function rotr(x, n) {
    return ((x >>> n) | (x << (32 - n))) >>> 0;
}
function add32(...xs) {
    return xs.reduce((a, b) => (a + b) >>> 0, 0);
}

function md5Pad(bytes) {
    const bitLen = BigInt(bytes.length) * 8n;
    const padded = bytes.slice();
    padded.push(0x80);
    while (padded.length % 64 !== 56) padded.push(0);
    for (let i = 0; i < 8; i++) padded.push(Number((bitLen >> BigInt(8 * i)) & 0xffn));
    return padded;
}

export function md5Hex(bytes) {
    const padded = md5Pad(bytes);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let off = 0; off < padded.length; off += 64) {
        const m = new Array(16);
        for (let j = 0; j < 16; j++) {
            const p = off + j * 4;
            m[j] = padded[p] | (padded[p + 1] << 8) | (padded[p + 2] << 16) | (padded[p + 3] << 24);
            m[j] >>>= 0;
        }
        let a = a0, b = b0, c = c0, d = d0;
        for (let j = 0; j < 64; j++) {
            let f, g;
            if (j < 16) { f = (b & c) | (~b & d); g = j; }
            else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
            else if (j < 48) { f = b ^ c ^ d; g = (3 * j + 5) % 16; }
            else { f = c ^ (b | ~d); g = (7 * j) % 16; }
            f = add32(f >>> 0, a, MD5_K[j], m[g]);
            a = d; d = c; c = b;
            b = add32(b, rotl(f, MD5_S[j]));
        }
        a0 = add32(a0, a); b0 = add32(b0, b); c0 = add32(c0, c); d0 = add32(d0, d);
    }
    return [a0, b0, c0, d0].map(hexLE).join("");
}

function hexLE(word) {
    const bytes = [word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff];
    return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function readFileBytes(interp, file, stdin) {
    if (file === "-") return utf8Encode(stdin);
    const path = interp.resolvePath(file);
    if (!interp.vfs.isFile(path)) return null;
    return utf8Encode(interp.vfs.readFile(path));
}

export function md5sumCommand(interp, args, stdin) {
    let check = false;
    const files = [];
    for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === "-c" || a === "--check") check = true;
        else if (a === "-b" || a === "-t" || a === "--binary" || a === "--text") { /* no-op */ }
        else if (a.startsWith("-") && a !== "-") return unknownOption("md5sum", a);
        else files.push(a);
    }
    if (files.length === 0) files.push("-");

    if (check) {
        let failed = 0;
        let output = "";
        for (const file of files) {
            const content = file === "-" ? stdin : (interp.vfs.isFile(interp.resolvePath(file)) ? interp.vfs.readFile(interp.resolvePath(file)) : null);
            if (content === null) return fail(`md5sum: ${file}: No such file or directory\n`, 1);
            for (const line of content.split("\n")) {
                const parsed = parseChecksumLine(line);
                if (!parsed) continue;
                const [hash, target] = parsed;
                const bytes = readFileBytes(interp, target, stdin);
                if (bytes === null) { output += `${target}: FAILED open or read\n`; failed++; continue; }
                const matches = md5Hex(bytes).toLowerCase() === hash.toLowerCase();
                output += `${target}: ${matches ? "OK" : "FAILED"}\n`;
                if (!matches) failed++;
            }
        }
        if (failed > 0) output += `md5sum: WARNING: ${failed} computed checksum${failed > 1 ? "s" : ""} did NOT match\n`;
        return { stdout: output, stderr: "", exitCode: failed > 0 ? 1 : 0 };
    }

    let output = "";
    let exitCode = 0;
    for (const file of files) {
        const bytes = readFileBytes(interp, file, stdin);
        if (bytes === null) { output += `md5sum: ${file}: No such file or directory\n`; exitCode = 1; }
        else output += `${md5Hex(bytes)}  ${file}\n`;
    }
    return { stdout: output, stderr: "", exitCode };
}

function parseChecksumLine(line) {
    const trimmed = line.replace(/\s+$/, "");
    const m = /^(\S+)\s+\*?(.+)$/.exec(trimmed);
    if (!m) return null;
    const [, hash, rest] = m;
    if (!/^[0-9a-fA-F]+$/.test(hash) || !rest) return null;
    return [hash, rest];
}

// ----- sha256 -----

const SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Pad(bytes) {
    const bitLen = BigInt(bytes.length) * 8n;
    const padded = bytes.slice();
    padded.push(0x80);
    while (padded.length % 64 !== 56) padded.push(0);
    for (let i = 7; i >= 0; i--) padded.push(Number((bitLen >> BigInt(8 * i)) & 0xffn));
    return padded;
}

export function sha256Hex(bytes) {
    const padded = sha256Pad(bytes);
    let state = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    for (let off = 0; off < padded.length; off += 64) {
        const w = new Array(64).fill(0);
        for (let i = 0; i < 16; i++) {
            const p = off + i * 4;
            w[i] = ((padded[p] << 24) | (padded[p + 1] << 16) | (padded[p + 2] << 8) | padded[p + 3]) >>> 0;
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = add32(w[i - 16], s0, w[i - 7], s1);
        }
        let [a, b, c, d, e, f, g, h] = state;
        for (let i = 0; i < 64; i++) {
            const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const choice = (e & f) ^ (~e & g);
            const temp1 = add32(h, sum1, choice >>> 0, SHA256_K[i], w[i]);
            const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = add32(sum0, majority >>> 0);
            h = g; g = f; f = e; e = add32(d, temp1);
            d = c; c = b; b = a; a = add32(temp1, temp2);
        }
        state = state.map((s, i) => add32(s, [a, b, c, d, e, f, g, h][i]));
    }
    return state.map((w) => w.toString(16).padStart(8, "0")).join("");
}

// The bare-hex sha256 of the file currently at `path`, computed at most once
// per unchanged state (see `Vfs.cacheContentDigest`): a `pending` file whose
// own digest is already CAS-namespaced (`sha256:...`, e.g. a deployment
// mount) is trusted with no I/O at all; otherwise (a foreign digest, such as
// a git/web mount's own hash, or eager content) the content digest cache is
// consulted before falling back to reading the bytes - fetching a lazy file
// at most once via the existing lazy read cache - and hashing them, after
// which the result is cached for next time. Returns null if the file is
// missing.
// PORT: fs.rs's `content_sha256_hex`.
function contentSha256Hex(interp, path) {
    const lazy = interp.vfs.lazyFileRef(path);
    if (lazy && isCasNamespacedDigest(lazy.digest)) {
        return lazy.digest.slice("sha256:".length);
    }
    const cached = interp.vfs.cachedContentDigest(path);
    if (cached !== null) return cached.slice("sha256:".length);
    if (!interp.vfs.isFile(path)) return null;
    const bytes = utf8Encode(interp.vfs.readFile(path));
    const hex = sha256Hex(bytes);
    interp.vfs.cacheContentDigest(path, `sha256:${hex}`);
    return hex;
}

export function sha256sumCommand(interp, args, stdin) {
    const files = [];
    for (let i = 1; i < args.length; i++) {
        const a = args[i];
        if (a === "-b" || a === "-t" || a === "--binary" || a === "--text") continue;
        if (a.startsWith("-") && a !== "-") return unknownOption("sha256sum", a);
        files.push(a);
    }
    if (files.length === 0) files.push("-");

    let stdout = "", stderr = "", exitCode = 0;
    for (const file of files) {
        const hex = file === "-" ? sha256Hex(utf8Encode(stdin)) : contentSha256Hex(interp, interp.resolvePath(file));
        if (hex === null) { stderr += `sha256sum: ${file}: No such file or directory\n`; exitCode = 1; continue; }
        stdout += `${hex}  ${file}\n`;
    }
    return { stdout, stderr, exitCode };
}
