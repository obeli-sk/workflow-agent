// Brace expansion: {a,b,c} comma lists and {1..5} / {a..e} ranges, applied to
// a raw (unquoted) word segment before variable/glob expansion. No nesting
// beyond one level of {..{..}..} is required for the session's scripts, but
// simple recursive nesting works here for free since expandOne recurses.

export function braceExpand(text) {
    const results = expand(text);
    return results.length ? results : [text];
}

function expand(text) {
    const open = findUnquotedBrace(text);
    if (open === -1) return [text];
    const close = matchingBrace(text, open);
    if (close === -1) return [text];
    const prefix = text.slice(0, open);
    const body = text.slice(open + 1, close);
    const suffix = text.slice(close + 1);
    const parts = splitTopLevel(body);
    let alternatives;
    if (parts.length > 1) {
        alternatives = parts;
    } else {
        const range = parseRange(body);
        if (range) alternatives = range;
        else return expandSuffixOnly(prefix, `{${body}}`, suffix);
    }
    const out = [];
    for (const alt of alternatives) {
        for (const suf of expand(suffix)) {
            for (const pre of expand(prefix)) {
                out.push(pre + alt + suf);
            }
        }
    }
    return out;
}

function expandSuffixOnly(prefix, literalBrace, suffix) {
    const out = [];
    for (const suf of expand(suffix)) {
        for (const pre of expand(prefix)) out.push(pre + literalBrace + suf);
    }
    return out;
}

function findUnquotedBrace(text) {
    return text.indexOf("{");
}

function matchingBrace(text, open) {
    let depth = 0;
    for (let i = open; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function splitTopLevel(body) {
    const parts = [];
    let depth = 0;
    let current = "";
    let hasComma = false;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === "{") depth++;
        if (ch === "}") depth--;
        if (ch === "," && depth === 0) {
            hasComma = true;
            parts.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    parts.push(current);
    return hasComma ? parts : [body];
}

function parseRange(body) {
    const m = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(body);
    if (m) {
        let [, a, b, step] = m;
        let start = parseInt(a, 10);
        let end = parseInt(b, 10);
        let inc = step ? Math.abs(parseInt(step, 10)) : 1;
        if (inc === 0) inc = 1;
        const out = [];
        if (start <= end) {
            for (let n = start; n <= end; n += inc) out.push(String(n));
        } else {
            for (let n = start; n >= end; n -= inc) out.push(String(n));
        }
        return out;
    }
    const cm = /^([A-Za-z])\.\.([A-Za-z])$/.exec(body);
    if (cm) {
        const start = cm[1].charCodeAt(0);
        const end = cm[2].charCodeAt(0);
        const out = [];
        if (start <= end) {
            for (let c = start; c <= end; c++) out.push(String.fromCharCode(c));
        } else {
            for (let c = start; c >= end; c--) out.push(String.fromCharCode(c));
        }
        return out;
    }
    return null;
}
