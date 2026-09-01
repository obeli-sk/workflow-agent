// PORT: vendor/just-bash-rs/src/commands/text.rs (cut, tr slice)

import { ok, fail, unknownOption } from "./core.js";

function revLine(line) {
    return [...line].reverse().join("");
}
function revProcess(text) {
    const hadTrailingNl = text.endsWith("\n");
    const lines = text.split("\n");
    if (hadTrailingNl) lines.pop();
    const out = lines.map(revLine).join("\n");
    return hadTrailingNl ? `${out}\n` : out;
}

export function revCommand(interp, args, stdin) {
    const files = [];
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith("-") && arg !== "-") return unknownOption("rev", arg);
        files.push(arg);
    }
    let output = "";
    if (files.length === 0) {
        output = revProcess(stdin);
    } else {
        for (const file of files) {
            if (file === "-") { output += revProcess(stdin); continue; }
            const path = interp.resolvePath(file);
            if (!interp.vfs.isFile(path)) return { stdout: output, stderr: `rev: ${file}: No such file or directory\n`, exitCode: 1 };
            output += revProcess(interp.vfs.readFile(path));
        }
    }
    return ok(output);
}

function parseCutRanges(spec) {
    const ranges = [];
    for (const part of spec.split(",")) {
        const dash = part.indexOf("-");
        if (dash !== -1) {
            const s = part.slice(0, dash);
            const e = part.slice(dash + 1);
            const start = s === "" ? 1 : parseInt(s, 10);
            const end = e === "" ? null : parseInt(e, 10);
            if (Number.isNaN(start) || (e !== "" && Number.isNaN(end))) return null;
            if (start < 1 || (end !== null && end < start)) return null;
            ranges.push({ start, end });
        } else {
            const n = parseInt(part, 10);
            if (Number.isNaN(n) || n < 1) return null;
            ranges.push({ start: n, end: n });
        }
    }
    return ranges;
}

export function cutCommand(interp, args, stdin) {
    let delimiter = "\t";
    let fieldSpec = null, charSpec = null, suppress = false;
    const files = [];
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-d") { i++; delimiter = args[i] ?? "\t"; }
        else if (arg.startsWith("-d") && arg.length > 2) delimiter = arg.slice(2);
        else if (arg === "-f") { i++; fieldSpec = args[i] ?? null; }
        else if (arg.startsWith("-f") && arg.length > 2) fieldSpec = arg.slice(2);
        else if (arg === "-c") { i++; charSpec = args[i] ?? null; }
        else if (arg.startsWith("-c") && arg.length > 2) charSpec = arg.slice(2);
        else if (arg === "-s" || arg === "--only-delimited") suppress = true;
        else if (arg.startsWith("--")) return fail(`cut: unrecognized option '${arg}'\n`, 1);
        else if (arg.startsWith("-") && arg.length > 1) {
            for (const c of arg.slice(1)) {
                if (c === "s") suppress = true;
                else if (!"dfc".includes(c)) return fail(`cut: unrecognized option '-${c}'\n`, 1);
            }
        } else {
            files.push(arg);
        }
    }
    if (fieldSpec === null && charSpec === null) {
        return fail("cut: you must specify a list of bytes, characters, or fields\n", 1);
    }
    let content = stdin;
    for (const f of files) {
        if (!interp.vfs.isFile(interp.resolvePath(f))) return fail(`cut: ${f}: No such file or directory\n`, 1);
        content += interp.vfs.readFile(interp.resolvePath(f));
    }
    let lines = content.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();

    const spec = fieldSpec ?? charSpec ?? "1";
    const ranges = parseCutRanges(spec);
    if (!ranges) return fail("cut: invalid range\n", 1);

    let out = "";
    for (const line of lines) {
        if (charSpec !== null) {
            const chars = [...line];
            let selected = "";
            for (const r of ranges) {
                const start = r.start - 1;
                const end = Math.min(r.end ?? chars.length, chars.length);
                selected += chars.slice(start, end).join("");
            }
            out += `${selected}\n`;
        } else {
            if (suppress && !line.includes(delimiter)) continue;
            const fields = line.split(delimiter);
            const seen = new Set();
            const selected = [];
            for (const r of ranges) {
                const start = r.start - 1;
                const end = Math.min(r.end ?? fields.length, fields.length);
                for (let idx = start; idx < end; idx++) {
                    if (idx >= 0 && !seen.has(idx)) { seen.add(idx); selected.push(fields[idx]); }
                }
            }
            out += `${selected.join(delimiter)}\n`;
        }
    }
    return ok(out);
}

// ----- tr -----

function posixClass(name) {
    const range = (a, b) => { const out = []; for (let c = a.charCodeAt(0); c <= b.charCodeAt(0); c++) out.push(String.fromCharCode(c)); return out; };
    switch (name) {
        case "alnum": return [...range("0", "9"), ...range("A", "Z"), ...range("a", "z")];
        case "alpha": return [...range("A", "Z"), ...range("a", "z")];
        case "blank": return [" ", "\t"];
        case "cntrl": { const out = []; for (let b = 0; b < 32; b++) out.push(String.fromCharCode(b)); out.push(String.fromCharCode(127)); return out; }
        case "digit": return range("0", "9");
        case "graph": { const out = []; for (let b = 33; b <= 126; b++) out.push(String.fromCharCode(b)); return out; }
        case "lower": return range("a", "z");
        case "print": { const out = []; for (let b = 32; b <= 126; b++) out.push(String.fromCharCode(b)); return out; }
        case "punct": return [..."!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"];
        case "space": return [" ", "\t", "\n", "\r", "\x0c", "\x0b"];
        case "upper": return range("A", "Z");
        case "xdigit": return [..."0123456789ABCDEFabcdef"];
        default: return null;
    }
}

function expandSet(spec) {
    const chars = [...spec];
    const out = [];
    let i = 0;
    while (i < chars.length) {
        if (chars[i] === "[" && chars[i + 1] === ":") {
            let end = -1;
            for (let j = i + 2; j < chars.length - 1; j++) {
                if (chars[j] === ":" && chars[j + 1] === "]") { end = j; break; }
            }
            if (end !== -1) {
                const className = chars.slice(i + 2, end).join("");
                const expanded = posixClass(className);
                if (expanded) { out.push(...expanded); i = end + 2; continue; }
            }
        }
        if (chars[i] === "\\" && i + 1 < chars.length) {
            const next = chars[i + 1];
            out.push(next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next);
            i += 2;
            continue;
        }
        if (i + 2 < chars.length && chars[i + 1] === "-") {
            const start = chars[i].charCodeAt(0);
            const end = chars[i + 2].charCodeAt(0);
            if (end >= start) for (let code = start; code <= end; code++) out.push(String.fromCharCode(code));
            i += 3;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    return out;
}

export function trCommand(interp, args, stdin) {
    let complement = false, deleteMode = false, squeeze = false;
    const sets = [];
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-c" || arg === "-C" || arg === "--complement") complement = true;
        else if (arg === "-d" || arg === "--delete") deleteMode = true;
        else if (arg === "-s" || arg === "--squeeze-repeats") squeeze = true;
        else if (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--")) {
            for (const c of arg.slice(1)) {
                if (c === "c" || c === "C") complement = true;
                else if (c === "d") deleteMode = true;
                else if (c === "s") squeeze = true;
            }
        } else {
            sets.push(arg);
        }
    }
    if (sets.length === 0) return fail("tr: missing operand\n", 1);
    if (!deleteMode && !squeeze && sets.length < 2) return fail("tr: missing operand after SET1\n", 1);

    const set1Raw = expandSet(sets[0]);
    const set2 = sets.length > 1 ? expandSet(sets[1]) : [];
    const set1 = new Set(set1Raw);

    let output = "";
    if (deleteMode) {
        for (const c of stdin) {
            const inSet1 = set1.has(c) !== complement;
            if (!inSet1) output += c;
        }
    } else if (squeeze && sets.length === 1) {
        let prev = null;
        for (const c of stdin) {
            const inSet1 = set1.has(c) !== complement;
            if (inSet1 && c === prev) continue;
            output += c;
            prev = c;
        }
    } else {
        const set2Chars = new Set(set2);
        let prev = null;
        if (complement) {
            const target = set2[set2.length - 1] ?? "\0";
            for (const c of stdin) {
                const outC = set1.has(c) ? c : target;
                if (squeeze && set2Chars.has(outC) && outC === prev) continue;
                output += outC;
                prev = outC;
            }
        } else {
            const map = new Map();
            const last2 = set2[set2.length - 1] ?? "\0";
            set1Raw.forEach((c1, idx) => map.set(c1, set2[idx] ?? last2));
            for (const c of stdin) {
                const outC = map.has(c) ? map.get(c) : c;
                if (squeeze && set2Chars.has(outC) && outC === prev) continue;
                output += outC;
                prev = outC;
            }
        }
    }
    return ok(output);
}
