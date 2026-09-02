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

// Index one past the `]` that closes the bracket expression starting at
// `chars[start]` (`[`). Skips over nested `[:class:]`/`[.collating.]`/
// `[=equiv=]` sub-forms, whose own `]` does not close the outer bracket, and
// treats a `]` as literal when it is the first character (or right after a
// leading `^`), matching POSIX bracket-expression syntax.
function findBracketEnd(chars, start) {
    let j = start + 1;
    if (chars[j] === "^") j++;
    if (chars[j] === "]") j++;
    while (j < chars.length && chars[j] !== "]") {
        if (chars[j] === "[" && (chars[j + 1] === ":" || chars[j + 1] === "." || chars[j + 1] === "=")) {
            const closer = chars[j + 1] + "]";
            const rest = chars.slice(j + 2).join("");
            const closeAt = rest.indexOf(closer);
            j = closeAt === -1 ? j + 2 : j + 2 + closeAt + 2;
            continue;
        }
        j++;
    }
    return Math.min(j + 1, chars.length);
}

// Expand `[:class:]` POSIX classes inside `[...]` bracket expressions,
// leaving everything else untouched. Needed even in ERE/extended mode since
// (unlike Rust's `regex` crate) JS RegExp has no native POSIX-class support.
export function expandPosixBracketClasses(pattern) {
    const chars = [...pattern];
    let out = "";
    let i = 0;
    while (i < chars.length) {
        if (chars[i] === "\\" && i + 1 < chars.length) { out += chars[i] + chars[i + 1]; i += 2; continue; }
        if (chars[i] === "[") {
            const end = findBracketEnd(chars, i);
            const raw = chars.slice(i, end).join("");
            out += `[${expandPosixClasses(raw.slice(1, -1))}]`;
            i = end;
            continue;
        }
        out += chars[i];
        i += 1;
    }
    return out;
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
            const end = findBracketEnd(chars, i);
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
