// Filesystem builtins operating on the VFS: ls/cat/mkdir/rm/rmdir/cp/mv/
// touch, plus the small coreutils that only need the whole-input-in-memory
// model (wc/head/tail/sort/tee).

import { ok, fail } from "./core.js";
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
                if (!flags.has("r") && !flags.has("R")) return fail(`cp: -r not specified; omitting directory '${s}'\n`, 1);
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
