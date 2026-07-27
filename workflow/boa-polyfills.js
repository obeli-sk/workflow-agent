// Small Web API compatibility layer for Obelisk's Boa workflow runtime.
// just-bash needs UTF-8 codecs, while Boa deliberately exposes a smaller
// global surface than browsers and Node.

if (typeof globalThis.TextEncoder !== "function") {
    globalThis.TextEncoder = class TextEncoder {
        get encoding() {
            return "utf-8";
        }

        encode(input = "") {
            const bytes = [];
            for (const symbol of String(input)) {
                const codePoint = symbol.codePointAt(0);
                if (codePoint <= 0x7f) {
                    bytes.push(codePoint);
                } else if (codePoint <= 0x7ff) {
                    bytes.push(
                        0xc0 | (codePoint >> 6),
                        0x80 | (codePoint & 0x3f),
                    );
                } else if (codePoint <= 0xffff) {
                    bytes.push(
                        0xe0 | (codePoint >> 12),
                        0x80 | ((codePoint >> 6) & 0x3f),
                        0x80 | (codePoint & 0x3f),
                    );
                } else {
                    bytes.push(
                        0xf0 | (codePoint >> 18),
                        0x80 | ((codePoint >> 12) & 0x3f),
                        0x80 | ((codePoint >> 6) & 0x3f),
                        0x80 | (codePoint & 0x3f),
                    );
                }
            }
            return new Uint8Array(bytes);
        }

        encodeInto(input, destination) {
            const encoded = this.encode(input);
            const written = Math.min(encoded.length, destination.length);
            destination.set(encoded.subarray(0, written));
            return {
                read: written === encoded.length ? String(input).length : 0,
                written,
            };
        }
    };
}

if (typeof globalThis.TextDecoder !== "function") {
    globalThis.TextDecoder = class TextDecoder {
        constructor(label = "utf-8", options = {}) {
            const normalized = String(label).toLowerCase().replaceAll("_", "-");
            if (!["utf-8", "utf8", "unicode-1-1-utf-8"].includes(normalized)) {
                throw new RangeError(`Unsupported encoding: ${label}`);
            }
            this.encoding = "utf-8";
            this.fatal = Boolean(options.fatal);
            this.ignoreBOM = Boolean(options.ignoreBOM);
        }

        decode(input = new Uint8Array()) {
            const bytes = input instanceof Uint8Array
                ? input
                : new Uint8Array(input.buffer || input);
            let output = "";
            let offset = 0;
            while (offset < bytes.length) {
                const first = bytes[offset];
                let needed;
                let codePoint;
                let minimum;
                if (first <= 0x7f) {
                    needed = 0;
                    codePoint = first;
                    minimum = 0;
                } else if (first >= 0xc2 && first <= 0xdf) {
                    needed = 1;
                    codePoint = first & 0x1f;
                    minimum = 0x80;
                } else if (first >= 0xe0 && first <= 0xef) {
                    needed = 2;
                    codePoint = first & 0x0f;
                    minimum = 0x800;
                } else if (first >= 0xf0 && first <= 0xf4) {
                    needed = 3;
                    codePoint = first & 0x07;
                    minimum = 0x10000;
                } else {
                    output += this.invalidByte();
                    offset += 1;
                    continue;
                }

                if (offset + needed >= bytes.length) {
                    output += this.invalidByte();
                    offset += 1;
                    continue;
                }
                let valid = true;
                for (let index = 1; index <= needed; index += 1) {
                    const next = bytes[offset + index];
                    if ((next & 0xc0) !== 0x80) {
                        valid = false;
                        break;
                    }
                    codePoint = (codePoint << 6) | (next & 0x3f);
                }
                if (
                    !valid
                    || codePoint < minimum
                    || codePoint > 0x10ffff
                    || (codePoint >= 0xd800 && codePoint <= 0xdfff)
                ) {
                    output += this.invalidByte();
                    offset += 1;
                    continue;
                }
                output += String.fromCodePoint(codePoint);
                offset += needed + 1;
            }
            if (!this.ignoreBOM && output.charCodeAt(0) === 0xfeff) {
                return output.slice(1);
            }
            return output;
        }

        invalidByte() {
            if (this.fatal) {
                throw new TypeError("The encoded data is not valid UTF-8");
            }
            return "\ufffd";
        }
    };
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

if (typeof globalThis.btoa !== "function") {
    globalThis.btoa = function btoa(input) {
        const source = String(input);
        let output = "";
        for (let offset = 0; offset < source.length; offset += 3) {
            const first = source.charCodeAt(offset);
            const second = source.charCodeAt(offset + 1);
            const third = source.charCodeAt(offset + 2);
            if (first > 0xff || second > 0xff || third > 0xff) {
                throw new TypeError("The string contains characters outside of Latin1");
            }
            const value = (first << 16)
                | ((Number.isNaN(second) ? 0 : second) << 8)
                | (Number.isNaN(third) ? 0 : third);
            output += BASE64_ALPHABET[(value >>> 18) & 63];
            output += BASE64_ALPHABET[(value >>> 12) & 63];
            output += Number.isNaN(second) ? "=" : BASE64_ALPHABET[(value >>> 6) & 63];
            output += Number.isNaN(third) ? "=" : BASE64_ALPHABET[value & 63];
        }
        return output;
    };
}

if (typeof globalThis.atob !== "function") {
    globalThis.atob = function atob(input) {
        const source = String(input).replace(/\s/g, "");
        if (
            source.length % 4 === 1
            || !/^[A-Za-z0-9+/]*={0,2}$/.test(source)
        ) {
            throw new TypeError("Invalid base64 input");
        }
        const padded = source.padEnd(Math.ceil(source.length / 4) * 4, "=");
        let output = "";
        for (let offset = 0; offset < padded.length; offset += 4) {
            const first = BASE64_ALPHABET.indexOf(padded[offset]);
            const second = BASE64_ALPHABET.indexOf(padded[offset + 1]);
            const third = padded[offset + 2] === "="
                ? 0 : BASE64_ALPHABET.indexOf(padded[offset + 2]);
            const fourth = padded[offset + 3] === "="
                ? 0 : BASE64_ALPHABET.indexOf(padded[offset + 3]);
            const value = (first << 18) | (second << 12) | (third << 6) | fourth;
            output += String.fromCharCode((value >>> 16) & 0xff);
            if (padded[offset + 2] !== "=") {
                output += String.fromCharCode((value >>> 8) & 0xff);
            }
            if (padded[offset + 3] !== "=") {
                output += String.fromCharCode(value & 0xff);
            }
        }
        return output;
    };
}

function paddedHashInput(input) {
    const source = input instanceof Uint8Array ? input : new Uint8Array(input);
    const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(source);
    padded[source.length] = 0x80;
    const bitLength = source.length * 8;
    const view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(paddedLength - 4, bitLength >>> 0, false);
    return padded;
}

function rotateRight(value, count) {
    return (value >>> count) | (value << (32 - count));
}

function sha256(input) {
    const constants = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
        0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
        0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
        0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const hash = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const padded = paddedHashInput(input);
    const view = new DataView(padded.buffer);
    const words = new Uint32Array(64);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let index = 0; index < 16; index += 1) {
            words[index] = view.getUint32(offset + index * 4, false);
        }
        for (let index = 16; index < 64; index += 1) {
            const a = words[index - 15];
            const b = words[index - 2];
            const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
            const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
            words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = hash;
        for (let index = 0; index < 64; index += 1) {
            const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
            const choice = (e & f) ^ (~e & g);
            const first = (h + sum1 + choice + constants[index] + words[index]) >>> 0;
            const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const second = (sum0 + majority) >>> 0;
            h = g;
            g = f;
            f = e;
            e = (d + first) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (first + second) >>> 0;
        }
        hash[0] = (hash[0] + a) >>> 0;
        hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0;
        hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0;
        hash[5] = (hash[5] + f) >>> 0;
        hash[6] = (hash[6] + g) >>> 0;
        hash[7] = (hash[7] + h) >>> 0;
    }
    const output = new Uint8Array(32);
    const outputView = new DataView(output.buffer);
    hash.forEach((value, index) => outputView.setUint32(index * 4, value, false));
    return output.buffer;
}

function rotateLeft(value, count) {
    return (value << count) | (value >>> (32 - count));
}

function sha1(input) {
    const hash = new Uint32Array([
        0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0,
    ]);
    const padded = paddedHashInput(input);
    const view = new DataView(padded.buffer);
    const words = new Uint32Array(80);
    for (let offset = 0; offset < padded.length; offset += 64) {
        for (let index = 0; index < 16; index += 1) {
            words[index] = view.getUint32(offset + index * 4, false);
        }
        for (let index = 16; index < 80; index += 1) {
            words[index] = rotateLeft(
                words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16],
                1,
            ) >>> 0;
        }
        let [a, b, c, d, e] = hash;
        for (let index = 0; index < 80; index += 1) {
            let fn;
            let constant;
            if (index < 20) {
                fn = (b & c) | (~b & d);
                constant = 0x5a827999;
            } else if (index < 40) {
                fn = b ^ c ^ d;
                constant = 0x6ed9eba1;
            } else if (index < 60) {
                fn = (b & c) | (b & d) | (c & d);
                constant = 0x8f1bbcdc;
            } else {
                fn = b ^ c ^ d;
                constant = 0xca62c1d6;
            }
            const next = (rotateLeft(a, 5) + fn + e + constant + words[index]) >>> 0;
            e = d;
            d = c;
            c = rotateLeft(b, 30) >>> 0;
            b = a;
            a = next;
        }
        hash[0] = (hash[0] + a) >>> 0;
        hash[1] = (hash[1] + b) >>> 0;
        hash[2] = (hash[2] + c) >>> 0;
        hash[3] = (hash[3] + d) >>> 0;
        hash[4] = (hash[4] + e) >>> 0;
    }
    const output = new Uint8Array(20);
    const outputView = new DataView(output.buffer);
    hash.forEach((value, index) => outputView.setUint32(index * 4, value, false));
    return output.buffer;
}

if (
    typeof globalThis.crypto !== "object"
    || globalThis.crypto === null
    || typeof globalThis.crypto.subtle?.digest !== "function"
) {
    globalThis.crypto = {
        subtle: {
            async digest(algorithm, input) {
                const name = typeof algorithm === "string"
                    ? algorithm.toUpperCase()
                    : String(algorithm?.name || "").toUpperCase();
                if (name === "SHA-256") return sha256(input);
                if (name === "SHA-1") return sha1(input);
                throw new TypeError(`Unsupported digest algorithm: ${name}`);
            },
        },
    };
}
