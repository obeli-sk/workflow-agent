// Dependency-free UTF-8 codec: Boa's workflow JS runtime has no
// TextEncoder/TextDecoder or Buffer, so hash/base64 commands need their own
// string<->bytes conversion instead of relying on either.

export function utf8Encode(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        let code = str.codePointAt(i);
        if (code > 0xffff) i++; // consumed a surrogate pair
        if (code < 0x80) {
            bytes.push(code);
        } else if (code < 0x800) {
            bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
            bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        } else {
            bytes.push(
                0xf0 | (code >> 18),
                0x80 | ((code >> 12) & 0x3f),
                0x80 | ((code >> 6) & 0x3f),
                0x80 | (code & 0x3f),
            );
        }
    }
    return bytes;
}

export function utf8Decode(bytes) {
    let out = "";
    let i = 0;
    while (i < bytes.length) {
        const b0 = bytes[i];
        if (b0 < 0x80) { out += String.fromCodePoint(b0); i += 1; continue; }
        if ((b0 & 0xe0) === 0xc0 && i + 1 < bytes.length) {
            out += String.fromCodePoint(((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
            i += 2;
            continue;
        }
        if ((b0 & 0xf0) === 0xe0 && i + 2 < bytes.length) {
            out += String.fromCodePoint(((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
            i += 3;
            continue;
        }
        if ((b0 & 0xf8) === 0xf0 && i + 3 < bytes.length) {
            out += String.fromCodePoint(
                ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f),
            );
            i += 4;
            continue;
        }
        out += String.fromCharCode(b0);
        i += 1;
    }
    return out;
}
