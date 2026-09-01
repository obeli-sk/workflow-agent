// Builtin command registry + dispatch. Phase 1 covers a working core subset;
// full parity with vendor/just-bash-rs/src/commands/*.rs (awk, sed, jq, diff,
// full grep/sort/hash/timeutil/find/xargs) is Phase 2 — see
// docs/js-backend-migration.md.

import { core, ok, fail, unknownOption } from "./core.js";
import { fsutil } from "./fsutil.js";
import { base64Command, md5sumCommand, sha256sumCommand } from "./hash.js";
import { cutCommand, trCommand } from "./text.js";
import { findCommand } from "./find.js";
import { xargsCommand } from "./xargs.js";

export const BUILTIN_NAMES = [
    "echo", "printf", "pwd", "cd", "true", "false", ":",
    "export", "unset", "read", "test", "[", "exit",
    "set", "shift", "break", "continue",
    "date", "sleep", "seq", "which", "env", "printenv", "whoami", "hostname",
    "help", "clear", "basename", "dirname", "source", ".",
    "ls", "cat", "mkdir", "touch", "rm", "rmdir", "cp", "mv",
    "wc", "head", "tail", "sort", "uniq", "tee", "stat", "grep",
    "base64", "md5sum", "sha256sum", "cut", "tr", "find", "xargs",
];

const handlers = {
    ...core,
    ...fsutil,
    grep: grepCommand,
    base64: base64Command,
    md5sum: md5sumCommand,
    sha256sum: sha256sumCommand,
    cut: cutCommand,
    tr: trCommand,
    find: findCommand,
    xargs: xargsCommand,
};

export function dispatch(interp, args, stdin) {
    const name = args[0];
    const handler = handlers[name];
    if (!handler) return fail(`${interp._commandLabel ?? name}: command not found\n`, 127);
    return handler(interp, args, stdin);
}

function grepCommand(interp, args, stdin) {
    const rest = args.slice(1);
    let invert = false, ignoreCase = false, lineNumber = false, countOnly = false, fixed = false;
    const files = [];
    let pattern;
    for (const a of rest) {
        if (pattern === undefined && /^-[A-Za-z]+$/.test(a)) {
            for (const ch of a.slice(1)) {
                if (ch === "v") invert = true;
                else if (ch === "i") ignoreCase = true;
                else if (ch === "n") lineNumber = true;
                else if (ch === "c") countOnly = true;
                else if (ch === "F") fixed = true;
                else return unknownOption("grep", `-${ch}`);
            }
        } else if (pattern === undefined) {
            pattern = a;
        } else {
            files.push(a);
        }
    }
    if (pattern === undefined) return fail("Usage: grep [OPTION]... PATTERN [FILE]...\n", 2);
    let re;
    try {
        re = new RegExp(fixed ? escapeRegExp(pattern) : pattern, ignoreCase ? "i" : "");
    } catch (e) {
        return fail(`grep: ${e.message}\n`, 2);
    }
    let sources;
    if (files.length) {
        sources = [];
        for (const f of files) {
            const path = interp.resolvePath(f);
            if (!interp.vfs.isFile(path)) return fail(`grep: ${f}: No such file or directory\n`, 2);
            sources.push([f, interp.vfs.readFile(path)]);
        }
    } else {
        sources = [[null, stdin]];
    }
    let out = "";
    let matched = false;
    for (const [name, text] of sources) {
        const lines = text.split("\n");
        if (lines.length && lines[lines.length - 1] === "") lines.pop();
        let count = 0;
        const hits = [];
        lines.forEach((line, i) => {
            const isMatch = re.test(line) !== invert;
            if (isMatch) {
                count++;
                matched = true;
                const prefix = (files.length > 1 ? `${name}:` : "") + (lineNumber ? `${i + 1}:` : "");
                hits.push(prefix + line);
            }
        });
        out += countOnly ? `${files.length > 1 ? `${name}:` : ""}${count}\n` : hits.map((h) => `${h}\n`).join("");
    }
    return { stdout: out, stderr: "", exitCode: matched ? 0 : 1 };
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export { ok, fail, unknownOption };
