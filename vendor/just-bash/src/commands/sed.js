// PORT (simplified): vendor/just-bash-rs/src/commands/sed.rs
// sed [-n] [-E|-r] [-i] [-e SCRIPT]... [SCRIPT] [FILE...]
// Addressing: line number, $, /regex/, addr1,addr2 ranges, leading !.
// Commands: s///[flags] (g/i/p, Nth-occurrence), d, p, q, r file.
// Not ported: hold space, a/i/c, branching/labels, multiline N/D/P, y,
// step/relative addresses, { } blocks — matches the Rust port's scope.

import { fail } from "./core.js";
import { translateBre } from "../regex-bre.js";

function compile(pattern, extended, ignoreCase) {
    const core = extended ? pattern : translateBre(pattern);
    try {
        return new RegExp(core, ignoreCase ? "gi" : "g");
    } catch {
        throw new SedError(`sed: invalid regex: ${pattern}`);
    }
}

class SedError extends Error {}

function readDelimited(chars, i, delim) {
    let out = "";
    while (i < chars.length && chars[i] !== delim) {
        if (chars[i] === "\\" && i + 1 < chars.length) {
            if (chars[i + 1] === delim) out += delim;
            else out += chars[i] + chars[i + 1];
            i += 2;
            continue;
        }
        out += chars[i];
        i += 1;
    }
    return [out, i];
}

function parseAddress(chars, i, extended) {
    if (chars[i] === "$") return [{ kind: "last" }, i + 1];
    if (/[0-9]/.test(chars[i] ?? "")) {
        const start = i;
        while (/[0-9]/.test(chars[i] ?? "")) i++;
        return [{ kind: "line", n: parseInt(chars.slice(start, i).join(""), 10) }, i];
    }
    if (chars[i] === "/") {
        i += 1;
        const [pat, ni] = readDelimited(chars, i, "/");
        i = ni;
        if (chars[i] !== "/") throw new SedError("sed: unterminated address regex\n");
        i += 1;
        return [{ kind: "regex", re: compile(pat, extended, false) }, i];
    }
    return [null, i];
}

function parseSCommand(chars, i, extended) {
    i += 1; // skip 's'
    const delim = chars[i];
    if (delim === undefined) throw new SedError("sed: unterminated `s' command\n");
    i += 1;
    const [patternRaw, ni] = readDelimited(chars, i, delim);
    i = ni;
    if (chars[i] !== delim) throw new SedError("sed: unterminated `s' command\n");
    i += 1;
    const [replacementRaw, ni2] = readDelimited(chars, i, delim);
    i = ni2;
    if (chars[i] !== delim) throw new SedError("sed: unterminated `s' command\n");
    i += 1;

    let global = false, ignoreCase = false, print = false, num = "";
    while (i < chars.length && /[A-Za-z0-9]/.test(chars[i])) {
        if (chars[i] === "g") global = true;
        else if (chars[i] === "i" || chars[i] === "I") ignoreCase = true;
        else if (chars[i] === "p") print = true;
        else if (/[0-9]/.test(chars[i])) num += chars[i];
        i += 1;
    }
    const occurrence = num === "" ? null : parseInt(num, 10);
    const regex = compile(patternRaw, extended, ignoreCase);
    return [{ kind: "s", regex, replacement: replacementRaw, global, print, occurrence }, i];
}

function skipSpace(chars, i) {
    while (chars[i] === " " || chars[i] === "\t") i++;
    return i;
}

function parseOneStatement(chars, i, extended) {
    let [addr1, ni] = parseAddress(chars, i, extended);
    i = skipSpace(chars, ni);
    let addr2 = null;
    if (addr1 && chars[i] === ",") {
        i = skipSpace(chars, i + 1);
        const [a2, ni2] = parseAddress(chars, i, extended);
        addr2 = a2;
        i = ni2;
    }
    i = skipSpace(chars, i);
    let negate = false;
    if (chars[i] === "!") { negate = true; i = skipSpace(chars, i + 1); }
    const cmdChar = chars[i];
    if (cmdChar === undefined) throw new SedError("sed: missing command\n");
    let cmd, nextI;
    if (cmdChar === "s") { [cmd, nextI] = parseSCommand(chars, i, extended); }
    else if (cmdChar === "d") { cmd = { kind: "d" }; nextI = i + 1; }
    else if (cmdChar === "p") { cmd = { kind: "p" }; nextI = i + 1; }
    else if (cmdChar === "q") { cmd = { kind: "q" }; nextI = i + 1; }
    else if (cmdChar === "r") {
        let j = skipSpace(chars, i + 1);
        const start = j;
        while (j < chars.length && chars[j] !== "\n") j++;
        cmd = { kind: "r", filename: chars.slice(start, j).join("") };
        nextI = j;
    } else {
        throw new SedError(`sed: unknown command: \`${cmdChar}'\n`);
    }
    return [{ addr: { start: addr1, end: addr2, negate }, cmd }, nextI];
}

function parseSedScript(script, extended) {
    const chars = [...script];
    let i = 0;
    const stmts = [];
    while (true) {
        while (i < chars.length && (chars[i] === ";" || chars[i] === "\n" || chars[i] === " " || chars[i] === "\t")) i++;
        if (i >= chars.length) break;
        const [stmt, nextI] = parseOneStatement(chars, i, extended);
        stmts.push(stmt);
        i = nextI;
    }
    return stmts;
}

function addrMatchesSingle(addr, lineNo, isLast, patternSpace) {
    if (addr.kind === "line") return lineNo === addr.n;
    if (addr.kind === "last") return isLast;
    addr.re.lastIndex = 0;
    return addr.re.test(patternSpace);
}

function addressApplies(addr, state, lineNo, isLast, patternSpace) {
    let raw;
    if (!addr.start) raw = true;
    else if (!addr.end) raw = addrMatchesSingle(addr.start, lineNo, isLast, patternSpace);
    else if (state.active) {
        if (addrMatchesSingle(addr.end, lineNo, isLast, patternSpace)) state.active = false;
        raw = true;
    } else if (addrMatchesSingle(addr.start, lineNo, isLast, patternSpace)) {
        if (!addrMatchesSingle(addr.end, lineNo, isLast, patternSpace)) state.active = true;
        raw = true;
    } else {
        raw = false;
    }
    return addr.negate ? !raw : raw;
}

function buildReplacement(template, match) {
    const chars = [...template];
    let out = "";
    let i = 0;
    while (i < chars.length) {
        if (chars[i] === "\\" && i + 1 < chars.length) {
            const next = chars[i + 1];
            if (/[0-9]/.test(next)) {
                out += match[Number(next)] ?? "";
            } else if (next === "n") out += "\n";
            else if (next === "t") out += "\t";
            else out += next;
            i += 2;
            continue;
        }
        if (chars[i] === "&") { out += match[0] ?? ""; i += 1; continue; }
        out += chars[i];
        i += 1;
    }
    return out;
}

function applySubstitution(sub, input) {
    const startN = sub.occurrence ?? 1;
    let out = "";
    let lastEnd = 0;
    let count = 0;
    let changed = false;
    sub.regex.lastIndex = 0;
    let m;
    while ((m = sub.regex.exec(input)) !== null) {
        count += 1;
        if (m[0] === "") sub.regex.lastIndex += 1;
        if (count < startN) continue;
        out += input.slice(lastEnd, m.index);
        out += buildReplacement(sub.replacement, m);
        lastEnd = m.index + m[0].length;
        changed = true;
        if (!sub.global) break;
    }
    out += input.slice(lastEnd);
    return [out, changed];
}

function runSed(stmts, content, suppressAuto, fileCache) {
    let lines = content.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    const rangeState = stmts.map(() => ({ active: false }));
    let out = "";

    for (let idx = 0; idx < lines.length; idx++) {
        const lineNo = idx + 1;
        const isLast = lineNo === total;
        let patternSpace = lines[idx];
        let deleted = false, quitAfter = false;
        const appends = [];
        for (let si = 0; si < stmts.length; si++) {
            const stmt = stmts[si];
            if (!addressApplies(stmt.addr, rangeState[si], lineNo, isLast, patternSpace)) continue;
            const cmd = stmt.cmd;
            if (cmd.kind === "s") {
                const [newSpace, changed] = applySubstitution(cmd, patternSpace);
                patternSpace = newSpace;
                if (changed && cmd.print) out += `${patternSpace}\n`;
            } else if (cmd.kind === "d") {
                deleted = true;
            } else if (cmd.kind === "p") {
                out += `${patternSpace}\n`;
            } else if (cmd.kind === "q") {
                quitAfter = true;
            } else if (cmd.kind === "r") {
                if (fileCache.has(cmd.filename)) appends.push(fileCache.get(cmd.filename));
            }
            if (deleted || quitAfter) break;
        }
        if (!deleted && !suppressAuto) out += `${patternSpace}\n`;
        for (const text of appends) out += text;
        if (quitAfter) break;
    }
    return out;
}

export function sedCommand(interp, args, stdin) {
    let suppressAuto = false, extended = false, inPlace = false;
    const scripts = [];
    const files = [];

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-n" || arg === "--quiet" || arg === "--silent") suppressAuto = true;
        else if (arg === "-E" || arg === "-r" || arg === "--regexp-extended") extended = true;
        else if (arg === "-i" || arg === "--in-place") inPlace = true;
        else if (arg === "-e" && i + 1 < args.length) { i++; scripts.push(args[i]); }
        else if (arg.startsWith("--expression=")) scripts.push(arg.slice("--expression=".length));
        else if (arg.startsWith("-e") && arg.length > 2) scripts.push(arg.slice(2));
        else if (arg.startsWith("-") && arg !== "-") { /* unrecognized flag: ignored, matches the Rust port */ }
        else if (scripts.length === 0) scripts.push(arg);
        else files.push(arg);
    }

    let stmts;
    try {
        stmts = parseSedScript(scripts.join("\n"), extended);
    } catch (e) {
        if (e instanceof SedError) return fail(e.message, 1);
        throw e;
    }

    const fileCache = new Map();
    for (const stmt of stmts) {
        if (stmt.cmd.kind === "r" && !fileCache.has(stmt.cmd.filename)) {
            const path = interp.resolvePath(stmt.cmd.filename);
            if (interp.vfs.isFile(path)) fileCache.set(stmt.cmd.filename, interp.vfs.readFile(path));
        }
    }

    if (files.length === 0) return { stdout: runSed(stmts, stdin, suppressAuto, fileCache), stderr: "", exitCode: 0 };

    let stdout = "", stderr = "", exitCode = 0;
    for (const file of files) {
        const path = interp.resolvePath(file);
        if (!interp.vfs.isFile(path)) {
            stderr += `sed: ${file}: No such file or directory\n`;
            exitCode = 1;
            continue;
        }
        const content = interp.vfs.readFile(path);
        const out = runSed(stmts, content, suppressAuto, fileCache);
        if (inPlace) interp.vfs.writeFile(path, out);
        else stdout += out;
    }
    return { stdout, stderr, exitCode };
}
