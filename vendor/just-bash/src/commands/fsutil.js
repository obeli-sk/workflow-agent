// Filesystem builtins operating on the VFS: ls/cat/mkdir/rm/rmdir/cp/mv/
// touch, plus the small coreutils that only need the whole-input-in-memory
// model (wc/head/tail/sort/tee).

import { ok, fail, unknownOption } from "./core.js";
import { FsError } from "../fs.js";

function flagsOf(args) {
    const flags = new Set();
    const rest = [];
    let noMore = false;
    for (const a of args) {
        if (!noMore && a === "--") { noMore = true; continue; }
        if (!noMore && /^-[A-Za-z]+$/.test(a)) for (const ch of a.slice(1)) flags.add(ch);
        else rest.push(a);
    }
    return { flags, rest };
}

export const fsutil = {
    ls(interp, args) {
        const { flags, rest } = flagsOf(args.slice(1));
        const targets = rest.length ? rest : ["."];
        const outputs = [];
        for (const t of targets) {
            const path = interp.resolvePath(t);
            if (!interp.vfs.exists(path)) return fail(`ls: cannot access '${t}': No such file or directory\n`, 1);
            if (interp.vfs.isFile(path)) { outputs.push(t); continue; }
            let names = interp.vfs.readdir(path);
            if (!flags.has("a")) names = names.filter((n) => !n.startsWith("."));
            if (flags.has("l")) {
                const lines = names.map((n) => {
                    const child = `${path === "/" ? "" : path}/${n}`;
                    const isDir = interp.vfs.isDir(child);
                    const size = isDir ? 0 : interp.vfs.readFile(child).length;
                    return `${isDir ? "d" : "-"}rwxr-xr-x 1 agent agent ${size} ${n}`;
                });
                outputs.push(lines.join("\n"));
            } else {
                outputs.push(names.join("\n"));
            }
        }
        const text = outputs.filter((s) => s.length).join("\n");
        return ok(text + (text ? "\n" : ""));
    },

    cat(interp, args, stdin) {
        const { rest } = flagsOf(args.slice(1));
        if (rest.length === 0) return ok(stdin);
        let out = "";
        for (const t of rest) {
            const path = interp.resolvePath(t);
            if (!interp.vfs.isFile(path)) return fail(`cat: ${t}: No such file or directory\n`, 1);
            out += interp.vfs.readFile(path);
        }
        return ok(out);
    },

    mkdir(interp, args) {
        const { flags, rest } = flagsOf(args.slice(1));
        for (const t of rest) {
            const path = interp.resolvePath(t);
            if (!flags.has("p") && interp.vfs.exists(path)) return fail(`mkdir: cannot create directory '${t}': File exists\n`, 1);
            interp.vfs.mkdirp(path);
        }
        return ok();
    },

    touch(interp, args) {
        for (const t of args.slice(1)) {
            const path = interp.resolvePath(t);
            if (!interp.vfs.exists(path)) interp.vfs.writeFile(path, "");
        }
        return ok();
    },

    rm(interp, args) {
        const { flags, rest } = flagsOf(args.slice(1));
        for (const t of rest) {
            const path = interp.resolvePath(t);
            try {
                interp.vfs.remove(path, { recursive: flags.has("r") || flags.has("R") });
            } catch (e) {
                if (!(e instanceof FsError) || !flags.has("f")) return fail(`rm: cannot remove '${t}': ${e.message}\n`, 1);
            }
        }
        return ok();
    },

    rmdir(interp, args) {
        for (const t of args.slice(1)) {
            const path = interp.resolvePath(t);
            try {
                interp.vfs.remove(path, { recursive: false });
            } catch (e) {
                return fail(`rmdir: failed to remove '${t}': ${e.message}\n`, 1);
            }
        }
        return ok();
    },

    cp(interp, args) {
        const { flags, rest } = flagsOf(args.slice(1));
        if (rest.length < 2) return fail("cp: missing destination file operand\n", 1);
        const dest = rest[rest.length - 1];
        const sources = rest.slice(0, -1);
        const destPath = interp.resolvePath(dest);
        const destIsDir = interp.vfs.isDir(destPath);
        for (const s of sources) {
            const srcPath = interp.resolvePath(s);
            const target = destIsDir ? `${destPath}/${srcPath.split("/").pop()}` : destPath;
            if (interp.vfs.isDir(srcPath)) {
                // `-a` (archive) is `-dR --preserve=all` upstream; the vfs has
                // no symlinks/timestamps to preserve, so recursive is the only
                // bit that matters here.
                if (!flags.has("r") && !flags.has("R") && !flags.has("a")) return fail(`cp: -r not specified; omitting directory '${s}'\n`, 1);
                copyDir(interp.vfs, srcPath, target);
            } else if (interp.vfs.isFile(srcPath)) {
                interp.vfs.copyFile(srcPath, target);
            } else {
                return fail(`cp: cannot stat '${s}': No such file or directory\n`, 1);
            }
        }
        return ok();
    },

    mv(interp, args) {
        const { rest } = flagsOf(args.slice(1));
        if (rest.length < 2) return fail("mv: missing destination file operand\n", 1);
        const dest = rest[rest.length - 1];
        const sources = rest.slice(0, -1);
        const destPath = interp.resolvePath(dest);
        for (const s of sources) {
            const srcPath = interp.resolvePath(s);
            if (!interp.vfs.exists(srcPath)) return fail(`mv: cannot stat '${s}': No such file or directory\n`, 1);
            const target = interp.vfs.isDir(destPath) ? `${destPath}/${srcPath.split("/").pop()}` : destPath;
            interp.vfs.rename(srcPath, target);
        }
        return ok();
    },

    wc(interp, args, stdin) {
        const { flags, rest } = flagsOf(args.slice(1));
        const inputs = rest.length ? rest.map((t) => interp.vfs.readFile(interp.resolvePath(t))) : [stdin];
        const lines = [];
        let totalL = 0, totalW = 0, totalC = 0;
        for (const text of inputs) {
            const l = text === "" ? 0 : (text.match(/\n/g) ?? []).length;
            const w = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
            const c = text.length;
            totalL += l; totalW += w; totalC += c;
            lines.push(formatWc(flags, l, w, c));
        }
        if (rest.length > 1) lines.push(formatWc(flags, totalL, totalW, totalC, "total"));
        return ok(lines.join("\n") + "\n");
    },

    head(interp, args, stdin) {
        const { n, rest } = countArg(args, 10);
        const text = rest.length ? interp.vfs.readFile(interp.resolvePath(rest[0])) : stdin;
        const lines = text.split("\n");
        const hadTrailingNl = text.endsWith("\n");
        const body = lines.slice(0, hadTrailingNl ? lines.length - 1 : lines.length);
        return ok(body.slice(0, n).join("\n") + (body.length ? "\n" : ""));
    },

    tail(interp, args, stdin) {
        const { n, rest } = countArg(args, 10);
        const text = rest.length ? interp.vfs.readFile(interp.resolvePath(rest[0])) : stdin;
        const lines = text.split("\n");
        const hadTrailingNl = text.endsWith("\n");
        const body = lines.slice(0, hadTrailingNl ? lines.length - 1 : lines.length);
        const start = Math.max(0, body.length - n);
        return ok(body.slice(start).join("\n") + (body.length ? "\n" : ""));
    },

    tee(interp, args, stdin) {
        const { flags, rest } = flagsOf(args.slice(1));
        for (const t of rest) {
            const path = interp.resolvePath(t);
            if (flags.has("a")) interp.vfs.appendFile(path, stdin);
            else interp.vfs.writeFile(path, stdin);
        }
        return ok(stdin);
    },

    stat(interp, args) {
        const t = args[1];
        if (!t) return fail("stat: missing operand\n", 1);
        const path = interp.resolvePath(t);
        if (!interp.vfs.exists(path)) return fail(`stat: cannot stat '${t}': No such file or directory\n`, 1);
        const isDir = interp.vfs.isDir(path);
        const size = isDir ? 0 : interp.vfs.readFile(path).length;
        return ok(`  File: ${t}\n  Size: ${size}\n  Type: ${isDir ? "directory" : "regular file"}\n`);
    },

    // PORT (simplified): vendor/just-bash-rs/src/commands/fsutil.rs's chmod.
    // Our VFS (fs.js) has no permission bits at all (not even an execute
    // flag), so this is a pure argument-validating no-op: mode syntax and
    // target existence are checked and a verbose message is printed as if
    // the mode had been applied, but nothing is actually stored.
    chmod(interp, args) {
        const real = args.slice(1);
        if (real.includes("--help")) {
            return ok("chmod: change file mode bits (no-op: this virtual filesystem has no permission bits)\nUsage: chmod [OPTIONS] MODE FILE...\n");
        }
        if (real.length < 2) return fail("chmod: missing operand\n", 1);
        let verbose = false;
        let idx = 0;
        while (idx < real.length && real[idx].startsWith("-") && !isValidMode(real[idx])) {
            const a = real[idx];
            if (a === "-R" || a === "--recursive") {
                // no-op: nothing to recurse into (no per-entry mode bits)
            } else if (a === "-v" || a === "--verbose") {
                verbose = true;
            } else if (a === "--") {
                idx++;
                break;
            } else if (a.length > 1 && [...a.slice(1)].every((c) => c === "R" || c === "v")) {
                if (a.includes("v")) verbose = true;
            } else {
                return unknownOption("chmod", a);
            }
            idx++;
        }
        if (real.length - idx < 2) return fail("chmod: missing operand\n", 1);
        const modeArg = real[idx];
        const files = real.slice(idx + 1);
        if (!isValidMode(modeArg)) return fail(`chmod: invalid mode: '${modeArg}'\n`, 1);
        const numericDisplay = /^[0-9]+$/.test(modeArg) ? modeArg.padStart(4, "0") : "0644";

        let stdout = "";
        let stderr = "";
        let anyError = false;
        for (const file of files) {
            const path = interp.resolvePath(file);
            if (!interp.vfs.exists(path)) {
                stderr += `chmod: cannot access '${file}': No such file or directory\n`;
                anyError = true;
                continue;
            }
            if (verbose) stdout += `mode of '${file}' changed to ${numericDisplay}\n`;
        }
        return { stdout, stderr, exitCode: anyError ? 1 : 0 };
    },

    // PORT (simplified): vendor/just-bash-rs/src/commands/fsutil.rs's readlink.
    // Our VFS has no symlinks, so no operand is ever a symbolic link. Without
    // -f, real readlink fails on a non-symlink with no message (exit 1 only)
    // -- reproduced verbatim below. With -f, real readlink canonicalizes the
    // path regardless of whether it's a symlink, which for a filesystem with
    // no symlinks to follow is just the normalized absolute path.
    readlink(interp, args) {
        const real = args.slice(1);
        let canonicalize = false;
        let idx = 0;
        while (idx < real.length && real[idx].startsWith("-")) {
            const a = real[idx];
            if (a === "-f" || a === "--canonicalize") canonicalize = true;
            else if (a === "--") { idx++; break; }
            else return unknownOption("readlink", a);
            idx++;
        }
        const files = real.slice(idx);
        if (files.length === 0) return fail("readlink: missing operand\n", 1);

        let stdout = "";
        let anyError = false;
        for (const file of files) {
            const path = interp.resolvePath(file);
            if (canonicalize) {
                stdout += `${path}\n`;
            } else {
                anyError = true;
            }
        }
        return { stdout, stderr: "", exitCode: anyError ? 1 : 0 };
    },

    // PORT (simplified): vendor/just-bash-rs/src/commands/fsutil.rs's ln.
    // Our VFS has no symlinks or inode aliasing. -s is argument-validated
    // then rejected (no real symlink can be created); a plain hard link is
    // approximated by copying the target's content under the new name
    // (unlike a real hard link, later writes to one name will not appear
    // under the other -- there is no shared inode in this VFS).
    ln(interp, args) {
        const real = args.slice(1);
        let symbolic = false;
        let force = false;
        let verbose = false;
        let idx = 0;
        while (idx < real.length && real[idx].startsWith("-")) {
            const a = real[idx];
            if (a === "-s" || a === "--symbolic") symbolic = true;
            else if (a === "-f" || a === "--force") force = true;
            else if (a === "-v" || a === "--verbose") verbose = true;
            else if (a === "-n" || a === "--no-dereference") { /* no-op */ }
            else if (a === "--") { idx++; break; }
            else if (a.length > 1 && [...a.slice(1)].every((c) => "sfvn".includes(c))) {
                if (a.includes("s")) symbolic = true;
                if (a.includes("f")) force = true;
                if (a.includes("v")) verbose = true;
            } else {
                return unknownOption("ln", a);
            }
            idx++;
        }
        const remaining = real.slice(idx);
        if (remaining.length < 2) return fail("ln: missing file operand\n", 1);
        if (remaining.length > 2) return fail(`ln: extra operand '${remaining[2]}'\n`, 1);
        const [target, linkName] = remaining;
        const linkPath = interp.resolvePath(linkName);

        if (interp.vfs.exists(linkPath)) {
            if (force) {
                try {
                    interp.vfs.remove(linkPath, { recursive: false });
                } catch {
                    // best-effort, matches the Rust port's `let _ = ...remove(...)`
                }
            } else {
                const kind = symbolic ? "symbolic " : "";
                return fail(`ln: failed to create ${kind}link '${linkName}': File exists\n`, 1);
            }
        }

        if (symbolic) {
            return fail("ln: symbolic links are not supported by this virtual filesystem\n", 1);
        }

        const targetPath = interp.resolvePath(target);
        if (interp.vfs.isDir(targetPath)) {
            return fail(`ln: '${target}': hard link not allowed for directory\n`, 1);
        }
        if (!interp.vfs.isFile(targetPath)) {
            return fail(`ln: failed to access '${target}': No such file or directory\n`, 1);
        }
        interp.vfs.copyFile(targetPath, linkPath);

        return ok(verbose ? `'${linkName}' -> '${target}'\n` : "");
    },

    // PORT (simplified): vendor/just-bash-rs/src/commands/fsutil.rs's file.
    // Simplified type detection (partial subset): upstream uses the
    // `file-type` npm package's full magic-byte signature database. This
    // port recognizes a handful of common binary signatures plus the
    // shebang/XML/extension/ASCII-vs-UTF-8 text heuristics.
    file(interp, args) {
        const real = args.slice(1);
        let brief = false;
        let mimeMode = false;
        const files = [];
        for (const arg of real) {
            if (arg.startsWith("--")) {
                const long = arg.slice(2);
                if (long === "brief") brief = true;
                else if (long === "mime" || long === "mime-type") mimeMode = true;
                else if (long === "dereference") { /* no-op */ }
                else return unknownOption("file", arg);
            } else if (arg.startsWith("-") && arg !== "-") {
                for (const c of arg.slice(1)) {
                    if (c === "b") brief = true;
                    else if (c === "i") mimeMode = true;
                    else if (c === "L") { /* no-op */ }
                    else return unknownOption("file", `-${c}`);
                }
            } else {
                files.push(arg);
            }
        }
        if (files.length === 0) return fail("Usage: file [-bLi] FILE...\n", 1);

        let stdout = "";
        let exitCode = 0;
        for (const file of files) {
            const path = interp.resolvePath(file);
            if (!interp.vfs.exists(path)) {
                stdout += brief ? "cannot open\n" : `${file}: cannot open (No such file or directory)\n`;
                exitCode = 1;
                continue;
            }
            let desc, mime;
            if (interp.vfs.isDir(path)) {
                desc = "directory";
                mime = "inode/directory";
            } else {
                [desc, mime] = detectFileType(file, interp.vfs.readFile(path));
            }
            const result = mimeMode ? mime : desc;
            stdout += brief ? `${result}\n` : `${file}: ${result}\n`;
        }
        return { stdout, stderr: "", exitCode };
    },

    // PORT: vendor/just-bash-rs/src/commands/fsutil.rs's du. Recursive
    // traversal over the VFS directly (same style as find.js's walk()).
    du(interp, args) {
        const real = args.slice(1);
        let allFiles = false;
        let human = false;
        let summarize = false;
        let grandTotal = false;
        let maxDepth;
        const targets = [];
        for (const arg of real) {
            if (arg === "-a") allFiles = true;
            else if (arg === "-h") human = true;
            else if (arg === "-s") summarize = true;
            else if (arg === "-c") grandTotal = true;
            else if (arg === "--help") return ok("du: estimate file space usage\nUsage: du [OPTION]... [FILE]...\n");
            else if (arg.startsWith("--max-depth=")) {
                const n = parseInt(arg.slice("--max-depth=".length), 10);
                maxDepth = Number.isNaN(n) ? undefined : n;
            } else if (arg.startsWith("-") && arg.length > 1) {
                for (const c of arg.slice(1)) {
                    if (c === "a") allFiles = true;
                    else if (c === "h") human = true;
                    else if (c === "s") summarize = true;
                    else if (c === "c") grandTotal = true;
                    else return unknownOption("du", `-${c}`);
                }
            } else {
                targets.push(arg);
            }
        }
        if (targets.length === 0) targets.push(".");

        const opts = { allFiles, human, summarize, maxDepth };
        const outLines = [];
        let stderr = "";
        let grand = 0;
        for (const target of targets) {
            const full = interp.resolvePath(target);
            if (!interp.vfs.exists(full)) {
                stderr += `du: cannot access '${target}': No such file or directory\n`;
                continue;
            }
            const perTarget = [];
            const total = duWalk(interp, full, target, 0, opts, perTarget);
            grand += total;
            if (summarize) outLines.push(`${formatSize(total, human)}\t${target}\n`);
            else outLines.push(...perTarget);
        }
        if (grandTotal && targets.length) outLines.push(`${formatSize(grand, human)}\ttotal\n`);
        return { stdout: outLines.join(""), stderr, exitCode: stderr ? 1 : 0 };
    },

    // PORT: vendor/just-bash-rs/src/commands/fsutil.rs's tree.
    tree(interp, args) {
        const real = args.slice(1);
        let showHidden = false;
        let dirsOnly = false;
        let fullPath = false;
        let maxDepth;
        const targets = [];
        for (let i = 0; i < real.length; i++) {
            const arg = real[i];
            if (arg === "-a") showHidden = true;
            else if (arg === "-d") dirsOnly = true;
            else if (arg === "-f") fullPath = true;
            else if (arg === "-L" && i + 1 < real.length) {
                i++;
                const n = parseInt(real[i], 10);
                maxDepth = Number.isNaN(n) ? undefined : n;
            } else if (arg === "--help") {
                return ok("tree: list contents of directories in a tree-like format\n");
            } else if (arg.startsWith("-") && arg.length > 1) {
                for (const c of arg.slice(1)) {
                    if (c === "a") showHidden = true;
                    else if (c === "d") dirsOnly = true;
                    else if (c === "f") fullPath = true;
                    else return unknownOption("tree", `-${c}`);
                }
            } else {
                targets.push(arg);
            }
        }
        if (targets.length === 0) targets.push(".");

        const outLines = [];
        let stderr = "";
        let dirCount = 0;
        let fileCount = 0;
        for (const target of targets) {
            const full = interp.resolvePath(target);
            if (!interp.vfs.exists(full)) {
                stderr += `tree: ${target}: No such file or directory\n`;
                continue;
            }
            outLines.push(`${target}\n`);
            if (!interp.vfs.isDir(full)) {
                fileCount++;
                continue;
            }
            const [d, f] = buildTree(interp, full, "", 0, maxDepth, showHidden, dirsOnly, fullPath, outLines);
            dirCount += d;
            fileCount += f;
        }
        outLines.push("\n");
        outLines.push(`${dirCount} director${dirCount === 1 ? "y" : "ies"}`);
        if (!dirsOnly) outLines.push(`, ${fileCount} file${fileCount === 1 ? "" : "s"}`);
        outLines.push("\n");
        return { stdout: outLines.join(""), stderr, exitCode: stderr ? 1 : 0 };
    },
};

function copyDir(vfs, src, dest) {
    vfs.mkdirp(dest);
    for (const name of vfs.readdir(src)) {
        const s = `${src}/${name}`;
        const d = `${dest}/${name}`;
        if (vfs.isDir(s)) copyDir(vfs, s, d);
        else vfs.copyFile(s, d);
    }
}

function countArg(args, def) {
    const rest = [];
    let n = def;
    const items = args.slice(1);
    for (let i = 0; i < items.length; i++) {
        if (items[i] === "-n" && items[i + 1] !== undefined) { n = parseInt(items[i + 1], 10); i++; }
        else if (/^-\d+$/.test(items[i])) n = -Number(items[i]);
        else rest.push(items[i]);
    }
    return { n, rest };
}

function formatWc(flags, l, w, c, label) {
    const any = flags.has("l") || flags.has("w") || flags.has("c");
    const parts = [];
    if (!any || flags.has("l")) parts.push(l);
    if (!any || flags.has("w")) parts.push(w);
    if (!any || flags.has("c")) parts.push(c);
    return parts.join(" ") + (label ? ` ${label}` : "");
}

// ---------------------------------------------------------------------
// chmod helpers
// ---------------------------------------------------------------------

function isValidMode(mode) {
    if (mode.length > 0 && /^[0-7]+$/.test(mode)) return true;
    if (mode.length === 0) return false;
    return mode.split(",").every((part) => /^[ugoa]*[+\-=][rwxXst]*$/.test(part));
}

// ---------------------------------------------------------------------
// file helpers
// ---------------------------------------------------------------------

const MAGICS = [
    ["\x89PNG\r\n\x1a\n", "PNG image data", "image/png"],
    ["\xFF\xD8\xFF", "JPEG image data", "image/jpeg"],
    ["GIF87a", "GIF image data", "image/gif"],
    ["GIF89a", "GIF image data", "image/gif"],
    ["%PDF", "PDF document", "application/pdf"],
    ["PK\x03\x04", "Zip archive data", "application/zip"],
    ["\x1f\x8b", "gzip compressed data", "application/gzip"],
    ["\x7fELF", "ELF executable", "application/x-elf"],
];

const EXTENSION_TYPES = {
    js: ["JavaScript source", "text/javascript"],
    mjs: ["JavaScript source", "text/javascript"],
    cjs: ["JavaScript source", "text/javascript"],
    ts: ["TypeScript source", "text/typescript"],
    py: ["Python script", "text/x-python"],
    rb: ["Ruby script", "text/x-ruby"],
    go: ["Go source", "text/x-go"],
    rs: ["Rust source", "text/x-rust"],
    c: ["C source", "text/x-c"],
    h: ["C source", "text/x-c"],
    sh: ["Bourne-Again shell script", "text/x-shellscript"],
    bash: ["Bourne-Again shell script", "text/x-shellscript"],
    json: ["JSON data", "application/json"],
    yaml: ["YAML data", "text/yaml"],
    yml: ["YAML data", "text/yaml"],
    xml: ["XML document", "application/xml"],
    html: ["HTML document", "text/html"],
    htm: ["HTML document", "text/html"],
    css: ["CSS stylesheet", "text/css"],
    md: ["Markdown document", "text/markdown"],
    markdown: ["Markdown document", "text/markdown"],
    txt: ["ASCII text", "text/plain"],
    wasm: ["WebAssembly binary module", "application/wasm"],
};

function detectFileType(filename, content) {
    if (content.length === 0) return ["empty", "inode/x-empty"];
    for (const [magic, desc, mime] of MAGICS) {
        if (content.startsWith(magic)) return [desc, mime];
    }
    return detectTextType(content, filename);
}

function detectTextType(content, filename) {
    if (content.startsWith("#!")) {
        const rest = content.slice(2);
        const firstLine = rest.split("\n")[0] ?? "";
        if (firstLine.includes("python")) return ["Python script, ASCII text executable", "text/x-python"];
        if (firstLine.includes("node") || firstLine.includes("bun") || firstLine.includes("deno")) {
            return ["JavaScript script, ASCII text executable", "text/javascript"];
        }
        if (firstLine.includes("bash")) return ["Bourne-Again shell script, ASCII text executable", "text/x-shellscript"];
        if (firstLine.includes("sh")) return ["POSIX shell script, ASCII text executable", "text/x-shellscript"];
        return ["script, ASCII text executable", "text/plain"];
    }

    const trimmed = content.trimStart();
    if (trimmed.startsWith("<?xml")) return ["XML document", "application/xml"];
    if (trimmed.startsWith("<!DOCTYPE html") || trimmed.toLowerCase().startsWith("<html")) {
        return ["HTML document", "text/html"];
    }

    const basename = filename.split("/").filter(Boolean).pop() ?? filename;
    const dot = basename.lastIndexOf(".");
    if (dot > -1) {
        const ext = basename.slice(dot + 1).toLowerCase();
        if (EXTENSION_TYPES[ext]) return EXTENSION_TYPES[ext];
    }

    for (const ch of content) {
        if (ch.charCodeAt(0) > 127) return ["UTF-8 Unicode text", "text/plain; charset=utf-8"];
    }
    return ["ASCII text", "text/plain"];
}

// ---------------------------------------------------------------------
// du helpers
// ---------------------------------------------------------------------

function joinPath(base, name) {
    return base === "/" ? `/${name}` : `${base}/${name}`;
}

function joinDisplay(display, name) {
    return display === "." ? name : `${display.replace(/\/+$/, "")}/${name}`;
}

function formatSize(bytes, human) {
    if (!human) {
        const blocks = Math.ceil(bytes / 1024);
        return String(blocks === 0 ? 1 : blocks);
    }
    if (bytes < 1024) return String(bytes);
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

function duWalk(interp, full, display, depth, opts, outLines) {
    if (interp.vfs.isDir(full)) {
        let total = 0;
        for (const entry of interp.vfs.readdir(full)) {
            total += duWalk(interp, joinPath(full, entry), joinDisplay(display, entry), depth + 1, opts, outLines);
        }
        if (!opts.summarize && (opts.maxDepth === undefined || depth <= opts.maxDepth)) {
            outLines.push(`${formatSize(total, opts.human)}\t${display}\n`);
        }
        return total;
    }
    const size = interp.vfs.readFile(full).length;
    if (!opts.summarize && (opts.allFiles || depth === 0)) {
        outLines.push(`${formatSize(size, opts.human)}\t${display}\n`);
    }
    return size;
}

// ---------------------------------------------------------------------
// tree helpers
// ---------------------------------------------------------------------

function buildTree(interp, full, prefix, depth, maxDepth, showHidden, dirsOnly, fullPath, outLines) {
    if (maxDepth !== undefined && depth >= maxDepth) return [0, 0];
    const entries = interp.vfs.readdir(full)
        .map((name) => [name, interp.vfs.isDir(joinPath(full, name))])
        .filter(([name, isDir]) => (showHidden || !name.startsWith(".")) && (!dirsOnly || isDir));
    entries.sort((a, b) => a[0].localeCompare(b[0]));

    let dirCount = 0;
    let fileCount = 0;
    const len = entries.length;
    entries.forEach(([name, isDir], i) => {
        const entryFull = joinPath(full, name);
        const isLast = i === len - 1;
        const connector = isLast ? "`-- " : "|-- ";
        const childPrefix = `${prefix}${isLast ? "    " : "|   "}`;
        const shown = fullPath ? entryFull : name;
        outLines.push(`${prefix}${connector}${shown}\n`);
        if (isDir) {
            dirCount++;
            const [d, f] = buildTree(interp, entryFull, childPrefix, depth + 1, maxDepth, showHidden, dirsOnly, fullPath, outLines);
            dirCount += d;
            fileCount += f;
        } else {
            fileCount++;
        }
    });
    return [dirCount, fileCount];
}
