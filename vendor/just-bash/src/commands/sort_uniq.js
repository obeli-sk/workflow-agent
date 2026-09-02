// PORT: vendor/just-bash-rs/src/commands/sort_uniq.rs
// sort -r -n -u -f -c -k -t; uniq -c -d -u -i.
// Not ported (matches the Rust port's scope): -b/-h/-M/-V/-d/-s/-o.

import { fail } from "./core.js";

function splitKeyModifiers(spec) {
    let cut = spec.length;
    for (let i = spec.length - 1; i >= 0; i--) {
        if (!"bdfhMnrV".includes(spec[i])) { cut = i + 1; break; }
        if (i === 0) cut = 0;
    }
    return [spec.slice(0, cut), spec.slice(cut)];
}

function parseKeySpec(spec) {
    const [main, modifiers] = splitKeyModifiers(spec);
    const parts = main.split(",");
    if (parts.length === 0 || parts[0] === "") return null;
    const startParts = parts[0].split(".");
    const startField = parseInt(startParts[0], 10);
    if (!Number.isInteger(startField) || startField < 1) return null;
    const startChar = startParts[1] !== undefined ? parseInt(startParts[1], 10) : undefined;

    let endField, endChar;
    let numeric = modifiers.includes("n");
    let reverse = modifiers.includes("r");
    let ignoreCase = modifiers.includes("f");

    if (parts.length > 1 && parts[1] !== "") {
        const [endMain, endMods] = splitKeyModifiers(parts[1]);
        numeric ||= endMods.includes("n");
        reverse ||= endMods.includes("r");
        ignoreCase ||= endMods.includes("f");
        const endParts = endMain.split(".");
        if (endParts[0] !== "") {
            const ef = parseInt(endParts[0], 10);
            endField = Number.isInteger(ef) && ef >= 1 ? ef : undefined;
            const ec = endParts[1] !== undefined ? parseInt(endParts[1], 10) : undefined;
            endChar = Number.isInteger(ec) && ec >= 1 ? ec : undefined;
        }
    }
    return { startField, startChar, endField, endChar, numeric, reverse, ignoreCase };
}

function extractKey(line, key, delimiter) {
    const fields = delimiter !== undefined ? line.split(delimiter) : line.split(/\s+/).filter((f) => f !== "");
    const startIdx = key.startField - 1;
    if (startIdx >= fields.length) return "";
    if (key.endField === undefined) {
        let field = fields[startIdx] ?? "";
        if (key.startChar !== undefined) field = field.slice(key.startChar - 1);
        return field;
    }
    const endIdx = Math.min(key.endField - 1, fields.length - 1);
    const sep = delimiter ?? " ";
    let out = "";
    for (let i = startIdx; i <= endIdx; i++) {
        let field = fields[i];
        if (i === startIdx && key.startChar !== undefined) field = field.slice(key.startChar - 1);
        if (i === endIdx && key.endChar !== undefined) {
            const takeTo = i === startIdx && key.startChar !== undefined ? key.endChar - key.startChar + 1 : key.endChar;
            field = field.slice(0, Math.max(0, takeTo));
        }
        if (i > startIdx) out += sep;
        out += field;
    }
    return out;
}

function compareValues(a, b, numeric, ignoreCase) {
    if (ignoreCase) { a = a.toLowerCase(); b = b.toLowerCase(); }
    if (numeric) {
        const na = parseFloat(a.trim()) || 0;
        const nb = parseFloat(b.trim()) || 0;
        return na < nb ? -1 : na > nb ? 1 : 0;
    }
    return a < b ? -1 : a > b ? 1 : 0;
}

export function sortCommand(interp, args, stdin) {
    let reverse = false, numeric = false, unique = false, ignoreCase = false, checkOnly = false;
    const keys = [];
    let delimiter;
    const files = [];

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-r" || arg === "--reverse") reverse = true;
        else if (arg === "-n" || arg === "--numeric-sort") numeric = true;
        else if (arg === "-u" || arg === "--unique") unique = true;
        else if (arg === "-f" || arg === "--ignore-case") ignoreCase = true;
        else if (arg === "-c" || arg === "--check") checkOnly = true;
        else if (arg === "-t" || arg === "--field-separator") { i++; delimiter = args[i]; }
        else if (arg.startsWith("--field-separator=")) delimiter = arg.slice("--field-separator=".length);
        else if (arg.startsWith("-t") && arg.length > 2) delimiter = arg.slice(2);
        else if (arg === "-k" || arg === "--key") { i++; const k = args[i] !== undefined ? parseKeySpec(args[i]) : null; if (k) keys.push(k); }
        else if (arg.startsWith("--key=")) { const k = parseKeySpec(arg.slice("--key=".length)); if (k) keys.push(k); }
        else if (arg.startsWith("-k") && arg.length > 2) { const k = parseKeySpec(arg.slice(2)); if (k) keys.push(k); }
        else if (arg.startsWith("--")) return fail(`sort: unrecognized option '${arg}'\n`, 1);
        else if (arg.startsWith("-") && arg.length > 1) {
            for (const c of arg.slice(1)) {
                if (c === "r") reverse = true;
                else if (c === "n") numeric = true;
                else if (c === "u") unique = true;
                else if (c === "f") ignoreCase = true;
                else if (c === "c") checkOnly = true;
                else return fail(`sort: unrecognized option '${arg}'\n`, 1);
            }
        } else {
            files.push(arg);
        }
    }

    let content = stdin;
    if (files.length) {
        content = "";
        for (const f of files) {
            if (!interp.vfs.isFile(interp.resolvePath(f))) return fail(`sort: ${f}: No such file or directory\n`, 1);
            content += interp.vfs.readFile(interp.resolvePath(f));
        }
    }
    let lines = content.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();

    const cmp = (a, b) => {
        let ord;
        if (keys.length === 0) {
            ord = compareValues(a, b, numeric, ignoreCase);
        } else {
            ord = 0;
            for (const key of keys) {
                const va = extractKey(a, key, delimiter);
                const vb = extractKey(b, key, delimiter);
                const keyOrd = compareValues(va, vb, key.numeric, key.ignoreCase || ignoreCase);
                if (keyOrd !== 0) { ord = key.reverse ? -keyOrd : keyOrd; break; }
            }
        }
        return ord !== 0 ? ord : (a < b ? -1 : a > b ? 1 : 0);
    };

    if (checkOnly) {
        const checkFile = files[0] ?? "-";
        for (let i = 1; i < lines.length; i++) {
            if (cmp(lines[i - 1], lines[i]) > 0) {
                return fail(`sort: ${checkFile}:${i + 1}: disorder: ${lines[i]}\n`, 1);
            }
        }
        return { stdout: "", stderr: "", exitCode: 0 };
    }

    lines.sort(cmp);
    if (reverse) lines.reverse();

    if (unique) {
        const seen = new Set();
        lines = lines.filter((line) => {
            let key;
            if (keys.length === 0) key = ignoreCase ? line.toLowerCase() : line;
            else {
                const v = extractKey(line, keys[0], delimiter);
                key = keys[0].ignoreCase || ignoreCase ? v.toLowerCase() : v;
            }
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    return { stdout: lines.length ? `${lines.join("\n")}\n` : "", stderr: "", exitCode: 0 };
}

export function uniqCommand(interp, args, stdin) {
    let count = false, duplicatesOnly = false, uniqueOnly = false, ignoreCase = false;
    const files = [];
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-c" || arg === "--count") count = true;
        else if (arg === "-d" || arg === "--repeated") duplicatesOnly = true;
        else if (arg === "-u" || arg === "--unique") uniqueOnly = true;
        else if (arg === "-i" || arg === "--ignore-case") ignoreCase = true;
        else if (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--")) {
            for (const c of arg.slice(1)) {
                if (c === "c") count = true;
                else if (c === "d") duplicatesOnly = true;
                else if (c === "u") uniqueOnly = true;
                else if (c === "i") ignoreCase = true;
            }
        } else {
            files.push(arg);
        }
    }

    let content = stdin;
    if (files.length) {
        content = "";
        for (const f of files) {
            if (!interp.vfs.isFile(interp.resolvePath(f))) return fail(`uniq: ${f}: No such file or directory\n`, 1);
            content += interp.vfs.readFile(interp.resolvePath(f));
        }
    }
    let lines = content.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) return { stdout: "", stderr: "", exitCode: 0 };

    const eq = (a, b) => (ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b);
    const groups = [];
    let current = lines[0], currentCount = 1;
    for (let i = 1; i < lines.length; i++) {
        if (eq(lines[i], current)) currentCount++;
        else { groups.push([current, currentCount]); current = lines[i]; currentCount = 1; }
    }
    groups.push([current, currentCount]);

    const filtered = duplicatesOnly ? groups.filter(([, c]) => c > 1)
        : uniqueOnly ? groups.filter(([, c]) => c === 1)
        : groups;

    let output = "";
    for (const [line, c] of filtered) {
        output += count ? `${String(c).padStart(4)} ${line}\n` : `${line}\n`;
    }
    return { stdout: output, stderr: "", exitCode: 0 };
}
