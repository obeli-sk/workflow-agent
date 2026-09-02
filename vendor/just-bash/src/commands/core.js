// Core shell builtins: echo/printf, pwd/cd, true/false/:, export/unset/read,
// test/[, exit, set/shift/break/continue, date/sleep/seq, env/which/help.

import { BreakSignal, ContinueSignal, ExitSignal } from "../interpreter.js";
import { parseScript } from "../parser.js";

const ALIAS_PREFIX = "BASH_ALIAS_";

export function ok(stdout = "") {
    return { stdout, stderr: "", exitCode: 0 };
}
export function fail(stderr, exitCode = 1) {
    return { stdout: "", stderr, exitCode };
}

export function unknownOption(cmd, opt) {
    if (opt.startsWith("--")) return fail(`${cmd}: unrecognized option '${opt}'\n`, 1);
    return fail(`${cmd}: invalid option -- '${opt.replace(/^-+/, "")}'\n`, 1);
}

function splitFlags(args) {
    const flags = new Set();
    const rest = [];
    let noMoreFlags = false;
    for (const arg of args) {
        if (!noMoreFlags && arg === "--") { noMoreFlags = true; continue; }
        if (!noMoreFlags && /^-[A-Za-z]+$/.test(arg)) {
            for (const ch of arg.slice(1)) flags.add(ch);
        } else {
            rest.push(arg);
        }
    }
    return { flags, rest };
}

export const core = {
    echo(interp, args) {
        let rest = args.slice(1);
        let n = false, e = false;
        while (rest.length && /^-[neE]+$/.test(rest[0])) {
            for (const ch of rest[0].slice(1)) { if (ch === "n") n = true; else if (ch === "e") e = true; else if (ch === "E") e = false; }
            rest = rest.slice(1);
        }
        let text = rest.join(" ");
        if (e) text = interpretBackslashes(text);
        return ok(text + (n ? "" : "\n"));
    },

    printf(interp, args) {
        const format = args[1];
        if (format === undefined) return fail("printf: usage: printf format [arguments]\n");
        const values = args.slice(2);
        return ok(renderPrintf(format, values));
    },

    pwd(interp) {
        return ok(`${interp.cwd}\n`);
    },

    cd(interp, args) {
        let target = args[1];
        if (target === undefined || target === "") target = interp.getVar("HOME") ?? "/workspace";
        if (target === "-") {
            const oldpwd = interp.getVar("OLDPWD");
            if (!oldpwd) return fail("cd: OLDPWD not set\n");
            target = oldpwd;
        }
        const resolved = interp.resolvePath(target);
        if (!interp.vfs.isDir(resolved)) return fail(`cd: ${target}: No such file or directory\n`);
        interp.setVar("OLDPWD", interp.cwd);
        interp.cwd = resolved;
        interp.setVar("PWD", resolved);
        return ok();
    },

    true: () => ok(),
    false: () => fail("", 1),
    ":": () => ok(),

    export(interp, args) {
        const rest = args.slice(1);
        if (rest.length === 0) {
            const lines = [...interp.exported].sort().map((name) => `declare -x ${name}="${interp.getVar(name) ?? ""}"\n`);
            return ok(lines.join(""));
        }
        for (const item of rest) {
            const eq = item.indexOf("=");
            if (eq === -1) {
                interp.exported.add(item);
            } else {
                const name = item.slice(0, eq);
                interp.setVar(name, item.slice(eq + 1));
                interp.exported.add(name);
            }
        }
        return ok();
    },

    unset(interp, args) {
        for (const name of args.slice(1)) {
            interp.vars.delete(name);
            interp.exported.delete(name);
        }
        return ok();
    },

    read(interp, args, stdin) {
        const { flags, rest: names } = splitFlags(args.slice(1));
        if (stdin === "") return fail("", 1);
        const nl = stdin.indexOf("\n");
        const line = nl === -1 ? stdin : stdin.slice(0, nl);
        const targets = names.length ? names : ["REPLY"];
        const raw = flags.has("r") ? line : line.replace(/\\(.)/g, "$1");
        const fields = raw.split(/[ \t]+/).filter((f, i, arr) => !(f === "" && arr.length > 1));
        for (let i = 0; i < targets.length; i++) {
            const value = i === targets.length - 1 ? fields.slice(i).join(" ") : (fields[i] ?? "");
            interp.setVar(targets[i], value);
        }
        return { stdout: "", stderr: "", exitCode: nl === -1 ? 1 : 0 };
    },

    test: runTest,
    "[": (interp, args, stdin) => {
        if (args[args.length - 1] !== "]") return fail("[: missing ']'\n", 2);
        return runTest(interp, args.slice(0, -1), stdin);
    },

    exit(interp, args) {
        const code = args[1] !== undefined ? (parseInt(args[1], 10) || 0) & 0xff : interp.lastExitCode;
        throw new ExitSignal(code);
    },

    break(interp, args) {
        throw new BreakSignal(args[1] ? parseInt(args[1], 10) || 1 : 1);
    },
    continue(interp, args) {
        throw new ContinueSignal(args[1] ? parseInt(args[1], 10) || 1 : 1);
    },

    set(interp, args) {
        for (const arg of args.slice(1)) {
            if (arg === "-e") interp.opts.errexit = true;
            else if (arg === "+e") interp.opts.errexit = false;
            else if (arg === "-u") interp.opts.nounset = true;
            else if (arg === "+u") interp.opts.nounset = false;
            else if (arg === "-x") interp.opts.xtrace = true;
            else if (arg === "+x") interp.opts.xtrace = false;
            else if (arg === "-o") continue;
            else if (arg === "pipefail") interp.opts.pipefail = true;
            else if (arg === "--") continue;
        }
        return ok();
    },

    shift(interp, args) {
        const n = args[1] ? parseInt(args[1], 10) || 1 : 1;
        interp.positionalParams = interp.positionalParams.slice(n);
        return ok();
    },

    seq(interp, args) {
        const nums = args.slice(1).map(Number);
        let first = 1, step = 1, last;
        if (nums.length === 1) [last] = nums;
        else if (nums.length === 2) [first, last] = nums;
        else if (nums.length === 3) [first, step, last] = nums;
        else return fail("seq: usage: seq [first [step]] last\n");
        const out = [];
        if (step === 0) return fail("seq: zero step\n");
        if (step > 0) for (let n = first; n <= last; n += step) out.push(n);
        else for (let n = first; n >= last; n += step) out.push(n);
        return ok(out.map(String).join("\n") + (out.length ? "\n" : ""));
    },

    which(interp, args) {
        const names = args.slice(1);
        const found = names.filter((n) => interp.commandNames.includes(n) || interp.custom.has(n));
        if (found.length !== names.length) return fail("", 1);
        return ok(found.join("\n") + (found.length ? "\n" : ""));
    },

    env: listEnv,
    printenv(interp, args) {
        if (args.length === 1) return listEnv(interp);
        const value = interp.getVar(args[1]);
        return value === undefined ? fail("", 1) : ok(`${value}\n`);
    },

    whoami: () => ok("agent\n"),
    hostname: () => ok("workflow-agent\n"),

    help(interp) {
        return ok(`Available commands:\n${[...new Set([...interp.commandNames, ...interp.custom.keys()])].sort().join(" ")}\n`);
    },

    clear: () => ok("\x1bc"),

    alias(interp, args) {
        const rest = args.slice(1);
        if (rest.length === 0) {
            let stdout = "";
            for (const [key, value] of interp.vars) {
                if (key.startsWith(ALIAS_PREFIX)) stdout += `alias ${key.slice(ALIAS_PREFIX.length)}='${value}'\n`;
            }
            return ok(stdout);
        }
        const processArgs = rest[0] === "--" ? rest.slice(1) : rest;
        for (const arg of processArgs) {
            const eq = arg.indexOf("=");
            if (eq === -1) {
                const key = ALIAS_PREFIX + arg;
                return interp.vars.has(key) ? ok(`alias ${arg}='${interp.vars.get(key)}'\n`) : fail(`alias: ${arg}: not found\n`, 1);
            }
            const name = arg.slice(0, eq);
            let value = arg.slice(eq + 1);
            if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
                value = value.slice(1, -1);
            }
            interp.vars.set(ALIAS_PREFIX + name, value);
        }
        return ok();
    },

    unalias(interp, args) {
        const rest = args.slice(1);
        if (rest.length === 0) return fail("unalias: usage: unalias [-a] name [name ...]\n", 1);
        if (rest[0] === "-a") {
            for (const key of [...interp.vars.keys()]) if (key.startsWith(ALIAS_PREFIX)) interp.vars.delete(key);
            return ok();
        }
        const processArgs = rest[0] === "--" ? rest.slice(1) : rest;
        let stderr = "", anyError = false;
        for (const name of processArgs) {
            const key = ALIAS_PREFIX + name;
            if (interp.vars.has(key)) interp.vars.delete(key);
            else { stderr += `unalias: ${name}: not found\n`; anyError = true; }
        }
        return { stdout: "", stderr, exitCode: anyError ? 1 : 0 };
    },

    basename(interp, args) {
        const path = args[1] ?? "";
        const suffix = args[2];
        let base = path.replace(/\/+$/, "").split("/").pop() || "/";
        if (suffix && base.endsWith(suffix) && base !== suffix) base = base.slice(0, -suffix.length);
        return ok(`${base}\n`);
    },
    dirname(interp, args) {
        const path = args[1] ?? "";
        const idx = path.replace(/\/+$/, "").lastIndexOf("/");
        if (idx === -1) return ok(".\n");
        if (idx === 0) return ok("/\n");
        return ok(`${path.slice(0, idx)}\n`);
    },

    source: sourceCommand,
    ".": sourceCommand,
};

function sourceCommand(interp, args, stdin, io) {
    const path = interp.resolvePath(args[1] ?? "");
    if (!interp.vfs.isFile(path)) return fail(`source: ${args[1]}: No such file or directory\n`, 1);
    const ast = parseScript(interp.vfs.readFile(path));
    const savedPositional = interp.positionalParams;
    if (args.length > 2) interp.positionalParams = args.slice(2);
    const capture = { 0: { kind: "string", text: "" }, 1: { kind: "buffer", ref: { data: "" } }, 2: { kind: "buffer", ref: { data: "" } } };
    try {
        interp.runStatements(ast.statements, capture);
    } finally {
        interp.positionalParams = savedPositional;
    }
    return { stdout: capture[1].ref.data, stderr: capture[2].ref.data, exitCode: interp.lastExitCode };
}

function listEnv(interp) {
    const lines = [...interp.exported].sort().map((name) => `${name}=${interp.getVar(name) ?? ""}`);
    return ok(lines.join("\n") + (lines.length ? "\n" : ""));
}

function runTest(interp, args) {
    const a = args.slice(1);
    const result = evalTest(interp, a);
    return { stdout: "", stderr: "", exitCode: result ? 0 : 1 };
}

function evalTest(interp, a) {
    if (a.length === 0) return false;
    if (a.length === 1) return a[0] !== "";
    if (a.length === 2 && a[0] === "!") return !evalTest(interp, a.slice(1));
    if (a.length === 2) {
        const [op, val] = a;
        switch (op) {
            case "-z": return val === "";
            case "-n": return val !== "";
            case "-e": return interp.vfs.exists(interp.resolvePath(val));
            case "-f": return interp.vfs.isFile(interp.resolvePath(val));
            case "-d": return interp.vfs.isDir(interp.resolvePath(val));
            case "-s": return interp.vfs.isFile(interp.resolvePath(val)) && interp.vfs.readFile(interp.resolvePath(val)).length > 0;
            case "-r": case "-w": case "-x": return interp.vfs.exists(interp.resolvePath(val));
            default: return false;
        }
    }
    if (a.length === 3) {
        const [lhs, op, rhs] = a;
        switch (op) {
            case "=": case "==": return lhs === rhs;
            case "!=": return lhs !== rhs;
            case "-eq": return Number(lhs) === Number(rhs);
            case "-ne": return Number(lhs) !== Number(rhs);
            case "-lt": return Number(lhs) < Number(rhs);
            case "-le": return Number(lhs) <= Number(rhs);
            case "-gt": return Number(lhs) > Number(rhs);
            case "-ge": return Number(lhs) >= Number(rhs);
            case "-a": return evalTest(interp, [lhs]) && evalTest(interp, [rhs]);
            case "-o": return evalTest(interp, [lhs]) || evalTest(interp, [rhs]);
            default: return false;
        }
    }
    return false;
}

function interpretBackslashes(text) {
    let out = "";
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== "\\" || i === text.length - 1) { out += text[i]; continue; }
        const c = text[i + 1];
        const map = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v", "\\": "\\", e: "\x1b" };
        if (c in map) { out += map[c]; i++; }
        else out += text[i];
    }
    return out;
}

function renderPrintf(format, values) {
    let out = "";
    let vi = 0;
    const nextValue = () => (vi < values.length ? values[vi++] : "");
    let iterations = 0;
    do {
        let consumedAny = false;
        for (let i = 0; i < format.length; i++) {
            const ch = format[i];
            if (ch === "\\") {
                const c = format[i + 1];
                const map = { n: "\n", t: "\t", r: "\r", "\\": "\\", "%": "%", a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b" };
                if (c in map) { out += map[c]; i++; }
                else if (c >= "0" && c <= "7") {
                    let j = i + 1, octal = "";
                    while (j < format.length && j < i + 4 && format[j] >= "0" && format[j] <= "7") { octal += format[j]; j++; }
                    out += String.fromCharCode(parseInt(octal, 8) & 0xff);
                    i = j - 1;
                } else out += ch;
                continue;
            }
            if (ch === "%" && format[i + 1] === "%") { out += "%"; i++; continue; }
            if (ch === "%") {
                const m = /^%[-+0# ]*\d*(?:\.\d+)?[sdifxXoc]/.exec(format.slice(i));
                if (m) {
                    out += formatOne(m[0], nextValue());
                    consumedAny = true;
                    i += m[0].length - 1;
                    continue;
                }
            }
            out += ch;
        }
        iterations++;
    } while (vi < values.length && iterations < 1000);
    return out;
}

function formatOne(spec, value) {
    const conv = spec[spec.length - 1];
    if (conv === "s") return value;
    if (conv === "c") return String(value)[0] ?? "";
    if (conv === "d" || conv === "i") return String(parseInt(value, 10) || 0);
    if (conv === "x") return (parseInt(value, 10) || 0).toString(16);
    if (conv === "X") return (parseInt(value, 10) || 0).toString(16).toUpperCase();
    if (conv === "o") return (parseInt(value, 10) || 0).toString(8);
    if (conv === "f") return String(parseFloat(value) || 0);
    return value;
}

