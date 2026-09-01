// PORT: vendor/just-bash-rs/src/commands/grep.rs
// grep [-E|-F] [-i] [-v] [-n] [-c] [-l|-L] [-o] [-w] [-x] [-r|-R] [-q] [-h]
// [-m N] [-A/-B/-C N] [-e PATTERN] PATTERN [FILE...]

import { fail } from "./core.js";
import { translateBre, expandPosixBracketClasses } from "../regex-bre.js";

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegex(pattern, mode, ignoreCase, wholeWord, lineRegexp) {
    const core = mode === "fixed" ? escapeRegExp(pattern) : mode === "basic" ? translateBre(pattern) : expandPosixBracketClasses(pattern);
    const wrapped = lineRegexp ? `^(?:${core})$` : wholeWord ? `\\b(?:${core})\\b` : core;
    try {
        return new RegExp(wrapped, ignoreCase ? "gi" : "g");
    } catch {
        return null;
    }
}

function buildRegexes(patterns, mode, ignoreCase, wholeWord, lineRegexp) {
    const out = [];
    for (const p of patterns) {
        const re = buildRegex(p, mode, ignoreCase, wholeWord, lineRegexp);
        if (!re) return null;
        out.push(re);
    }
    return out;
}

function readPatternFile(interp, name, stdin, stdinRead) {
    if (name === "-") {
        if (stdinRead.value) return { lines: [] };
        stdinRead.value = true;
        return { lines: stdin.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === "")) };
    }
    const path = interp.resolvePath(name);
    if (interp.vfs.isDir(path)) return { error: fail(`grep: ${name}: Is a directory\n`, 2) };
    if (!interp.vfs.isFile(path)) return { error: fail(`grep: ${name}: No such file or directory\n`, 2) };
    const content = interp.vfs.readFile(path);
    return { lines: content.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === "")) };
}

function collectRecursive(interp, root, out) {
    const full = interp.resolvePath(root);
    if (interp.vfs.isFile(full)) { out.push(root); return; }
    if (!interp.vfs.isDir(full)) return;
    const base = root.replace(/\/+$/, "");
    for (const entry of interp.vfs.readdir(full)) {
        if (entry.startsWith(".")) continue;
        collectRecursive(interp, `${base}/${entry}`, out);
    }
}

function search(content, patterns, opts, filename) {
    let lines = content.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();

    const matchedFlags = new Array(lines.length).fill(false);
    let matchCount = 0;
    for (let i = 0; i < lines.length; i++) {
        const isMatch = patterns.some((re) => { re.lastIndex = 0; return re.test(lines[i]); });
        const selected = opts.invert ? !isMatch : isMatch;
        if (selected) {
            matchedFlags[i] = true;
            matchCount++;
            if (opts.maxCount > 0 && matchCount >= opts.maxCount) break;
        }
    }
    const anyMatch = matchCount > 0;

    if (opts.countOnly) {
        const prefix = filename ? `${filename}:` : "";
        return { output: `${prefix}${matchCount}\n`, anyMatch, matchCount };
    }

    const printFlags = matchedFlags.slice();
    if (opts.before > 0 || opts.after > 0) {
        for (let i = 0; i < matchedFlags.length; i++) {
            if (!matchedFlags[i]) continue;
            const beforeStart = Math.max(0, i - opts.before);
            for (let k = beforeStart; k < i; k++) printFlags[k] = true;
            const afterEnd = Math.min(i + opts.after, lines.length - 1);
            for (let k = i + 1; k <= afterEnd; k++) printFlags[k] = true;
        }
    }

    let out = "";
    let prevPrinted = null;
    for (let i = 0; i < lines.length; i++) {
        if (!printFlags[i]) continue;
        if (prevPrinted !== null && i > prevPrinted + 1 && (opts.before > 0 || opts.after > 0)) out += "--\n";
        const sep = matchedFlags[i] ? ":" : "-";
        if (opts.onlyMatching) {
            const matches = [];
            for (const re of patterns) {
                re.lastIndex = 0;
                let m;
                while ((m = re.exec(lines[i])) !== null) {
                    matches.push([m.index, m[0]]);
                    if (m[0] === "") re.lastIndex += 1;
                }
            }
            matches.sort((a, b) => a[0] - b[0]);
            for (const [, text] of matches) {
                if (filename) out += filename + sep;
                if (opts.showLineNumbers) out += `${i + 1}${sep}`;
                out += `${text}\n`;
            }
        } else {
            if (filename) out += filename + sep;
            if (opts.showLineNumbers) out += `${i + 1}${sep}`;
            out += `${lines[i]}\n`;
        }
        prevPrinted = i;
    }
    return { output: out, anyMatch, matchCount };
}

function run(interp, args, stdin, forcedMode) {
    let mode = forcedMode ?? "basic";
    const opts = {
        ignoreCase: false, invert: false, showLineNumbers: false, countOnly: false,
        filesWithMatches: false, filesWithoutMatch: false, recursive: false,
        wholeWord: false, lineRegexp: false, onlyMatching: false, noFilename: false,
        quiet: false, maxCount: 0, before: 0, after: 0,
    };
    const patterns = [];
    let explicitPatternSource = false;
    const files = [];
    let parseOptions = true;
    const stdinRead = { value: false };

    let i = 1;
    while (i < args.length) {
        const arg = args[i];
        if (parseOptions && arg === "--") { parseOptions = false; i++; continue; }
        if (parseOptions && arg.startsWith("-") && arg !== "-") {
            if (arg === "-e" && i + 1 < args.length) {
                i++;
                patterns.push(...args[i].split("\n"));
                explicitPatternSource = true;
                i++;
                continue;
            }
            if (arg === "-f" && i + 1 < args.length) {
                i++;
                const res = readPatternFile(interp, args[i], stdin, stdinRead);
                if (res.error) return res.error;
                patterns.push(...res.lines);
                explicitPatternSource = true;
                i++;
                continue;
            }
            if (arg.startsWith("--file=")) {
                const res = readPatternFile(interp, arg.slice("--file=".length), stdin, stdinRead);
                if (res.error) return res.error;
                patterns.push(...res.lines);
                explicitPatternSource = true;
                i++;
                continue;
            }
            if (arg.startsWith("-f") && arg.length > 2) {
                const res = readPatternFile(interp, arg.slice(2), stdin, stdinRead);
                if (res.error) return res.error;
                patterns.push(...res.lines);
                explicitPatternSource = true;
                i++;
                continue;
            }
            if (arg.startsWith("--max-count=")) { opts.maxCount = parseInt(arg.slice("--max-count=".length), 10) || 0; i++; continue; }
            if (arg === "-m" && i + 1 < args.length) { i++; opts.maxCount = parseInt(args[i], 10) || 0; i++; continue; }
            if (/^-m\d+$/.test(arg)) { opts.maxCount = parseInt(arg.slice(2), 10) || 0; i++; continue; }
            if (/^-[ABC]$/.test(arg) && i + 1 < args.length) {
                i++;
                const n = parseInt(args[i], 10) || 0;
                if (arg[1] === "A") opts.after = n;
                else if (arg[1] === "B") opts.before = n;
                else { opts.before = n; opts.after = n; }
                i++;
                continue;
            }
            if (/^-[ABC]\d+$/.test(arg)) {
                const n = parseInt(arg.slice(2), 10) || 0;
                if (arg[1] === "A") opts.after = n;
                else if (arg[1] === "B") opts.before = n;
                else { opts.before = n; opts.after = n; }
                i++;
                continue;
            }

            const flags = arg.startsWith("--") ? [arg] : [...arg.slice(1)];
            for (const flag of flags) {
                switch (flag) {
                    case "i": case "--ignore-case": opts.ignoreCase = true; break;
                    case "n": case "--line-number": opts.showLineNumbers = true; break;
                    case "v": case "--invert-match": opts.invert = true; break;
                    case "c": case "--count": opts.countOnly = true; break;
                    case "l": case "--files-with-matches": opts.filesWithMatches = true; break;
                    case "L": case "--files-without-match": opts.filesWithoutMatch = true; break;
                    case "r": case "R": case "--recursive": opts.recursive = true; break;
                    case "w": case "--word-regexp": opts.wholeWord = true; break;
                    case "x": case "--line-regexp": opts.lineRegexp = true; break;
                    case "E": case "--extended-regexp": mode = "extended"; break;
                    case "P": case "--perl-regexp": mode = "extended"; break;
                    case "F": case "--fixed-strings": mode = "fixed"; break;
                    case "o": case "--only-matching": opts.onlyMatching = true; break;
                    case "h": case "--no-filename": opts.noFilename = true; break;
                    case "q": case "--quiet": case "--silent": opts.quiet = true; break;
                    case "--help": return { stdout: "", stderr: "", exitCode: 0 };
                    default: return fail(`grep: unrecognized option '${flag}'\n`, 2);
                }
            }
            i++;
        } else if (!explicitPatternSource && patterns.length === 0) {
            patterns.push(arg);
            i++;
        } else {
            files.push(arg);
            i++;
        }
    }

    if (patterns.length === 0 && !explicitPatternSource) return fail("grep: missing pattern\n", 2);

    let res = [];
    if (patterns.length > 0) {
        res = buildRegexes(patterns, mode, opts.ignoreCase, opts.wholeWord, opts.lineRegexp);
        if (res === null) return fail(`grep: invalid regular expression: ${patterns.join("\n")}\n`, 2);
    }

    if (files.length === 0) {
        const content = stdinRead.value ? "" : stdin;
        const { output, anyMatch } = search(content, res, opts, "");
        if (opts.quiet) return { stdout: "", stderr: "", exitCode: anyMatch ? 0 : 1 };
        return { stdout: output, stderr: "", exitCode: anyMatch ? 0 : 1 };
    }

    const targets = [];
    let hasFileTarget = false;
    for (const file of files) {
        if (file === "-") targets.push(file);
        else if (opts.recursive) { hasFileTarget = true; collectRecursive(interp, file, targets); }
        else { hasFileTarget = true; targets.push(file); }
    }

    const showFilename = (targets.length > 1 || (opts.recursive && hasFileTarget)) && !opts.noFilename;
    let stdout = "", stderr = "";
    let anyMatchTotal = false, anyError = false;
    let stdinConsumed = stdinRead.value;

    for (const file of targets) {
        const STDIN_FILENAME = "(standard input)";
        let content;
        if (file === "-") {
            content = stdinConsumed ? "" : stdin;
            stdinConsumed = true;
        } else {
            const path = interp.resolvePath(file);
            if (interp.vfs.isDir(path)) {
                if (!opts.recursive) stderr += `grep: ${file}: Is a directory\n`;
                continue;
            }
            if (!interp.vfs.isFile(path)) {
                stderr += `grep: ${file}: No such file or directory\n`;
                anyError = true;
                continue;
            }
            content = interp.vfs.readFile(path);
        }
        const displayName = file === "-" ? STDIN_FILENAME : file;
        const name = showFilename ? displayName : "";
        const { output, anyMatch } = search(content, res, opts, name);
        if (anyMatch) {
            anyMatchTotal = true;
            if (opts.quiet) return { stdout: "", stderr: "", exitCode: 0 };
            if (opts.filesWithMatches) stdout += `${displayName}\n`;
            else if (!opts.filesWithoutMatch) stdout += output;
        } else if (opts.filesWithoutMatch) {
            stdout += `${displayName}\n`;
        } else if (opts.countOnly && !opts.filesWithMatches) {
            stdout += output;
        }
    }

    const exitCode = anyError ? 2 : anyMatchTotal ? 0 : 1;
    if (opts.quiet) return { stdout: "", stderr: "", exitCode };
    return { stdout, stderr, exitCode };
}

export function grepCommand(interp, args, stdin) {
    return run(interp, args, stdin, null);
}
export function egrepCommand(interp, args, stdin) {
    return run(interp, args, stdin, "extended");
}
export function fgrepCommand(interp, args, stdin) {
    return run(interp, args, stdin, "fixed");
}
