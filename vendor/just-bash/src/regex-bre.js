// Translate a POSIX Basic Regular Expression (sed/grep's default flavor)
// into a pattern JS's native RegExp (which is ERE/PCRE-flavored) can compile:
// BRE's `\(` `\)` `\{` `\}` `\+` `\?` `\|` are the special forms; bare
// `( ) { } + ? |` are literal. Also expands POSIX bracket classes
// (`[:digit:]` etc.) since JS RegExp doesn't support them natively.
// PORT: vendor/just-bash-rs/src/commands/grep.rs's translate_bre.

const POSIX_CLASSES = {
    alnum: "0-9A-Za-z",
    alpha: "A-Za-z",
    blank: " \\t",
    cntrl: "\\x00-\\x1f\\x7f",
    digit: "0-9",
    graph: "\\x21-\\x7e",
    lower: "a-z",
    print: "\\x20-\\x7e",
    punct: "!\"#$%&'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~",
    space: " \\t\\n\\r\\f\\v",
    upper: "A-Z",
    xdigit: "0-9A-Fa-f",
};

function expandPosixClasses(bracketContent) {
    return bracketContent.replace(/\[:([a-z]+):\]/g, (m, name) => POSIX_CLASSES[name] ?? m);
}

export function translateBre(pattern) {
    const chars = [...pattern];
    let out = "";
    let i = 0;
    let atStart = true;
    while (i < chars.length) {
        const c = chars[i];
        if (c === "\\" && i + 1 < chars.length) {
            const next = chars[i + 1];
            if (next === "(") { out += "("; atStart = true; i += 2; continue; }
            if (next === ")") { out += ")"; atStart = false; i += 2; continue; }
            if (next === "{") { out += "{"; i += 2; continue; }
            if (next === "}") { out += "}"; i += 2; continue; }
            if (next === "+") { out += "+"; atStart = false; i += 2; continue; }
            if (next === "?") { out += "?"; atStart = false; i += 2; continue; }
            if (next === "|") { out += "|"; atStart = true; i += 2; continue; }
            out += `\\${next}`;
            atStart = false;
            i += 2;
            continue;
        }
        if (c === "^") {
            if (atStart) out += "^"; else out += "\\^";
            atStart = false;
            i += 1;
            continue;
        }
        if (c === "$") {
            if (i === chars.length - 1) out += "$"; else out += "\\$";
            atStart = false;
            i += 1;
            continue;
        }
        if (c === "*") {
            if (atStart) out += "\\*"; else out += "*";
            atStart = false;
            i += 1;
            continue;
        }
        if (c === "[") {
            let j = i + 1;
            if (chars[j] === "^") j++;
            if (chars[j] === "]") j++;
            while (j < chars.length && chars[j] !== "]") j++;
            const end = Math.min(j + 1, chars.length);
            const raw = chars.slice(i, end).join("");
            out += `[${expandPosixClasses(raw.slice(1, -1))}]`;
            i = end;
            atStart = false;
            continue;
        }
        if ("+?{}()|".includes(c)) {
            out += `\\${c}`;
        } else {
            out += c;
        }
        atStart = false;
        i += 1;
    }
    return out;
}
