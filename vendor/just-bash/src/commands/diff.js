// PORT (simplified): vendor/just-bash-rs/src/commands/diff.rs
// diff [-u] [-q] [-s] [-i] FILE1 FILE2 — hand-rolled O(n*m) LCS diff emitting
// GNU-diff-style unified hunks with 3 lines of context.

import { fail, unknownOption } from "./core.js";

function readOperand(interp, file, stdin) {
    if (file === "-") return stdin;
    const path = interp.resolvePath(file);
    if (!interp.vfs.isFile(path)) return null;
    return interp.vfs.readFile(path);
}

function lcsTable(a, b) {
    const n = a.length, m = b.length;
    const table = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    return table;
}

function diffLines(a, b) {
    const table = lcsTable(a, b);
    const edits = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) { edits.push({ kind: "equal", line: i }); i++; j++; }
        else if (table[i + 1][j] >= table[i][j + 1]) { edits.push({ kind: "delete", line: i }); i++; }
        else { edits.push({ kind: "insert", line: j }); j++; }
    }
    while (i < a.length) edits.push({ kind: "delete", line: i++ });
    while (j < b.length) edits.push({ kind: "insert", line: j++ });
    return edits;
}

function buildUnifiedDiff(f1, f2, c1, c2) {
    const a = splitKeepLines(c1);
    const b = splitKeepLines(c2);
    const edits = diffLines(a, b);
    const CONTEXT = 3;

    const hunks = [];
    let i = 0;
    while (i < edits.length) {
        if (edits[i].kind === "equal") { i++; continue; }
        let start = i, back = 0;
        while (start > 0 && edits[start - 1].kind === "equal" && back < CONTEXT) { start--; back++; }
        let end = i;
        while (true) {
            while (end < edits.length && edits[end].kind !== "equal") end++;
            let equalRun = 0, probe = end;
            while (probe < edits.length && edits[probe].kind === "equal") { probe++; equalRun++; }
            if (probe >= edits.length || equalRun > 2 * CONTEXT) { end += Math.min(equalRun, CONTEXT); break; }
            end = probe;
        }
        const range = [];
        for (let k = start; k < end; k++) range.push(k);
        hunks.push(range);
        i = end;
    }
    if (hunks.length === 0) return "";

    const oldPosBefore = (idx) => edits.slice(0, idx).filter((e) => e.kind !== "insert").length;
    const newPosBefore = (idx) => edits.slice(0, idx).filter((e) => e.kind !== "delete").length;

    let out = `--- ${f1}\n+++ ${f2}\n`;
    for (const hunk of hunks) {
        const first = hunk[0];
        const oldStart = oldPosBefore(first);
        const newStart = newPosBefore(first);
        let oldCount = 0, newCount = 0, body = "";
        for (const idx of hunk) {
            const e = edits[idx];
            if (e.kind === "equal") { oldCount++; newCount++; body += ` ${a[e.line]}\n`; }
            else if (e.kind === "delete") { oldCount++; body += `-${a[e.line]}\n`; }
            else { newCount++; body += `+${b[e.line]}\n`; }
        }
        const oldHeader = oldCount === 0 ? `${oldStart}` : `${oldStart + 1},${oldCount}`;
        const newHeader = newCount === 0 ? `${newStart}` : `${newStart + 1},${newCount}`;
        out += `@@ -${oldHeader} +${newHeader} @@\n${body}`;
    }
    return out;
}

function splitKeepLines(content) {
    if (content === "") return [];
    const lines = content.split("\n");
    if (content.endsWith("\n")) lines.pop();
    return lines;
}

export function diffCommand(interp, args, stdin) {
    let brief = false, reportSame = false, ignoreCase = false;
    const files = [];
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg === "-u" || arg === "--unified") continue;
        else if (arg === "-q" || arg === "--brief") brief = true;
        else if (arg === "-s" || arg === "--report-identical-files") reportSame = true;
        else if (arg === "-i" || arg === "--ignore-case") ignoreCase = true;
        else if (arg.startsWith("--") && arg !== "--") return unknownOption("diff", arg);
        else if (arg.startsWith("-") && arg.length > 1 && arg !== "-") return unknownOption("diff", arg);
        else files.push(arg);
    }
    if (files.length < 2) return fail("diff: missing operand\n", 2);
    const [f1, f2] = files;

    const c1 = readOperand(interp, f1, stdin);
    if (c1 === null) return fail(`diff: ${f1}: No such file or directory\n`, 2);
    const c2 = readOperand(interp, f2, stdin);
    if (c2 === null) return fail(`diff: ${f2}: No such file or directory\n`, 2);

    const t1 = ignoreCase ? c1.toLowerCase() : c1;
    const t2 = ignoreCase ? c2.toLowerCase() : c2;

    if (t1 === t2) {
        return reportSame ? { stdout: `Files ${f1} and ${f2} are identical\n`, stderr: "", exitCode: 0 } : { stdout: "", stderr: "", exitCode: 0 };
    }
    if (brief) return { stdout: `Files ${f1} and ${f2} differ\n`, stderr: "", exitCode: 1 };

    return { stdout: buildUnifiedDiff(f1, f2, c1, c2), stderr: "", exitCode: 1 };
}
