// PORT: vendor/just-bash-rs/src/commands/xargs.rs
// xargs [-I REPLACE] [-d DELIM] [-n NUM] [-0] [-t] [-r] [COMMAND [ARGS...]]

import { fail } from "./core.js";

function splitExact(input, delimiter) {
    const items = [];
    let start = 0;
    while (start <= input.length) {
        const off = input.indexOf(delimiter, start);
        if (off === -1) {
            const item = input.slice(start);
            if (item !== "") items.push(item);
            break;
        }
        const item = input.slice(start, off);
        if (item !== "") items.push(item);
        start = off + delimiter.length;
    }
    return items;
}

function splitWhitespaceItems(input) {
    return input.split(/\s+/).filter((s) => s !== "");
}

function quoteArg(arg) {
    if ([...arg].some((c) => " \t\n\"'\\$`!*?[]{}();&|<>#".includes(c))) {
        let escaped = "";
        for (const c of arg) {
            if ("\\\"$`".includes(c)) escaped += "\\";
            escaped += c;
        }
        return `"${escaped}"`;
    }
    return arg;
}

export function xargsCommand(interp, args, stdin) {
    let replaceStr = null, delimiter = null, maxArgs = null;
    let nullSeparator = false, verbose = false;
    let commandStart = 1;

    let i = 1;
    while (i < args.length) {
        const arg = args[i];
        if (arg === "-I" && i + 1 < args.length) {
            i++;
            replaceStr = args[i];
            commandStart = i + 1;
        } else if (arg === "-d" && i + 1 < args.length) {
            i++;
            delimiter = args[i].replaceAll("\\n", "\n").replaceAll("\\t", "\t").replaceAll("\\r", "\r").replaceAll("\\0", "\0").replaceAll("\\\\", "\\");
            commandStart = i + 1;
        } else if (arg === "-n" && i + 1 < args.length) {
            i++;
            const n = parseInt(args[i], 10);
            if (!Number.isInteger(n) || n < 1) return fail(`xargs: invalid number for -n: '${args[i]}'\n`, 1);
            maxArgs = n;
            commandStart = i + 1;
        } else if (arg === "-P" && i + 1 < args.length) {
            i++;
            commandStart = i + 1;
        } else if (arg === "-0" || arg === "--null") {
            nullSeparator = true;
            commandStart = i + 1;
        } else if (arg === "-t" || arg === "--verbose") {
            verbose = true;
            commandStart = i + 1;
        } else if (arg === "-r" || arg === "--no-run-if-empty") {
            commandStart = i + 1;
        } else if (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--")) {
            for (const c of arg.slice(1)) {
                if (c === "0") nullSeparator = true;
                else if (c === "t") verbose = true;
                else if (c === "r") { /* no-run-if-empty: no-op, empty input already produces no output */ }
                else return fail(`xargs: unrecognized option '-${c}'\n`, 1);
            }
            commandStart = i + 1;
        } else if (!arg.startsWith("-")) {
            commandStart = i;
            break;
        }
        i++;
    }

    let command = args.slice(commandStart);
    if (command.length === 0) command = ["echo"];

    let items;
    if (nullSeparator) {
        items = splitExact(stdin, "\0");
    } else if (delimiter !== null) {
        if (delimiter === "") return fail("xargs: delimiter must not be empty\n", 1);
        const input = stdin.endsWith("\n") ? stdin.slice(0, -1) : stdin;
        items = splitExact(input, delimiter);
    } else {
        items = splitWhitespaceItems(stdin);
    }

    if (items.length === 0) return { stdout: "", stderr: "", exitCode: 0 };

    let stdout = "", stderr = "", exitCode = 0;
    const runOne = (cmdArgs) => {
        if (verbose) stderr += `${cmdArgs.map(quoteArg).join(" ")}\n`;
        const out = interp.invoke(cmdArgs, "");
        stdout += out.stdout;
        stderr += out.stderr;
        if (out.exitCode !== 0) exitCode = out.exitCode;
    };

    if (replaceStr !== null) {
        if (replaceStr === "") return fail("xargs: replacement string must not be empty\n", 1);
        for (const item of items) runOne(command.map((c) => c.split(replaceStr).join(item)));
    } else if (maxArgs !== null) {
        for (let idx = 0; idx < items.length; idx += maxArgs) {
            runOne([...command, ...items.slice(idx, idx + maxArgs)]);
        }
    } else {
        runOne([...command, ...items]);
    }

    return { stdout, stderr, exitCode };
}
