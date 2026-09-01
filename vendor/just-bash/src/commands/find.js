// PORT (simplified): vendor/just-bash-rs/src/commands/find.rs
// find [PATH...] [-name PAT] [-iname PAT] [-path PAT] [-ipath PAT]
// [-type f|d] [-maxdepth N] [-mindepth N] [-empty] [!]/[-not] [-print] [-print0]

import { fail, ok } from "./core.js";
import { globToRegExp } from "../glob.js";

const HELP = `find: search for files in a directory hierarchy
usage: find [path...] [expression]
  -name PATTERN    file name matches shell pattern PATTERN
  -iname PATTERN   like -name but case insensitive
  -path PATTERN    file path matches shell pattern PATTERN
  -ipath PATTERN   like -path but case insensitive
  -type f|d        file is a regular file or a directory
  -maxdepth N      descend at most N levels
  -mindepth N      do not apply tests at levels less than N
  -empty           file is empty or directory is empty
  -print, -print0  print the file name (print0: NUL-separated)
`;

function parseFindArgs(args) {
    const paths = [];
    const opts = { maxdepth: Infinity, mindepth: 0, print0: false, predicates: [] };
    let i = 1;
    let negateNext = false;
    let seenPredicate = false;
    while (i < args.length) {
        const arg = args[i];
        if (!seenPredicate && !arg.startsWith("-") && arg !== "!") {
            paths.push(arg);
            i++;
            continue;
        }
        seenPredicate = true;
        switch (arg) {
            case "!": case "-not": negateNext = true; i++; break;
            case "-print": i++; break;
            case "-print0": opts.print0 = true; i++; break;
            case "-maxdepth": i++; opts.maxdepth = parseInt(args[i], 10); if (Number.isNaN(opts.maxdepth)) opts.maxdepth = Infinity; i++; break;
            case "-mindepth": i++; opts.mindepth = parseInt(args[i], 10); if (Number.isNaN(opts.mindepth)) opts.mindepth = 0; i++; break;
            case "-name": i++; opts.predicates.push([negateNext, { kind: "name", pat: args[i] ?? "", ic: false }]); negateNext = false; i++; break;
            case "-iname": i++; opts.predicates.push([negateNext, { kind: "name", pat: args[i] ?? "", ic: true }]); negateNext = false; i++; break;
            case "-path": i++; opts.predicates.push([negateNext, { kind: "path", pat: args[i] ?? "", ic: false }]); negateNext = false; i++; break;
            case "-ipath": i++; opts.predicates.push([negateNext, { kind: "path", pat: args[i] ?? "", ic: true }]); negateNext = false; i++; break;
            case "-type": {
                i++;
                const t = args[i] ?? "";
                if (t !== "f" && t !== "d") return { error: fail(`find: Unknown argument to -type: ${t}\n`, 1) };
                opts.predicates.push([negateNext, { kind: "type", t }]);
                negateNext = false;
                i++;
                break;
            }
            case "-empty": opts.predicates.push([negateNext, { kind: "empty" }]); negateNext = false; i++; break;
            default: return { error: fail(`find: unknown predicate '${arg}'\n`, 1) };
        }
    }
    if (paths.length === 0) paths.push(".");
    return { paths, opts };
}

function matchSegment(pattern, text) {
    return globToRegExp(pattern).test(text);
}

function predicateMatches(interp, opts, name, display, abs, isDir, isFile) {
    return opts.predicates.every(([negate, pred]) => {
        let result;
        switch (pred.kind) {
            case "name":
                result = pred.ic ? matchSegment(pred.pat.toLowerCase(), name.toLowerCase()) : matchSegment(pred.pat, name);
                break;
            case "path":
                result = pred.ic ? matchSegment(pred.pat.toLowerCase(), display.toLowerCase()) : matchSegment(pred.pat, display);
                break;
            case "type":
                result = pred.t === "f" ? isFile : pred.t === "d" ? isDir : false;
                break;
            case "empty":
                result = isDir ? interp.vfs.readdir(abs).length === 0 : interp.vfs.readFile(abs).length === 0;
                break;
            default:
                result = false;
        }
        return result !== negate;
    });
}

function walk(interp, display, abs, depth, opts, out) {
    const isDir = interp.vfs.isDir(abs);
    const isFile = interp.vfs.isFile(abs);
    const name = abs.split("/").filter(Boolean).pop() ?? abs;
    if (depth >= opts.mindepth && predicateMatches(interp, opts, name, display, abs, isDir, isFile)) {
        out.push(display);
    }
    if (isDir && depth < opts.maxdepth) {
        for (const entry of interp.vfs.readdir(abs)) {
            const childDisplay = display.endsWith("/") ? `${display}${entry}` : `${display}/${entry}`;
            const childAbs = `${abs.replace(/\/+$/, "")}/${entry}`;
            walk(interp, childDisplay, childAbs, depth + 1, opts, out);
        }
    }
}

export function findCommand(interp, args) {
    if (args.includes("--help")) return ok(HELP);
    const parsed = parseFindArgs(args);
    if (parsed.error) return parsed.error;
    const { paths, opts } = parsed;

    const outPaths = [];
    let stderr = "";
    let hadError = false;
    for (const rawPath of paths) {
        const abs = interp.resolvePath(rawPath);
        if (!interp.vfs.exists(abs)) {
            stderr += `find: ${rawPath}: No such file or directory\n`;
            hadError = true;
            continue;
        }
        const trimmed = rawPath.replace(/\/+$/, "");
        const displayRoot = trimmed === "" ? "/" : trimmed;
        walk(interp, displayRoot, abs, 0, opts, outPaths);
    }

    const sep = opts.print0 ? "\0" : "\n";
    const stdout = outPaths.map((p) => p + sep).join("");
    return { stdout, stderr, exitCode: hadError ? 1 : 0 };
}
