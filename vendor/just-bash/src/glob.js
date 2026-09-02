// Pathname glob matching: *, ?, [...] character classes. No brace expansion
// here (see brace.js, applied earlier in word expansion) and no ** (not part
// of the just-bash-rs parity target).

export function hasGlobChars(text) {
    return /[*?[]/.test(text);
}

export function globToRegExp(pattern) {
    let re = "^";
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === "*") {
            re += ".*";
        } else if (ch === "?") {
            re += ".";
        } else if (ch === "[") {
            let j = i + 1;
            let negate = false;
            if (pattern[j] === "!" || pattern[j] === "^") {
                negate = true;
                j++;
            }
            let cls = "";
            while (j < pattern.length && pattern[j] !== "]") {
                cls += pattern[j];
                j++;
            }
            if (j < pattern.length) {
                re += `[${negate ? "^" : ""}${cls.replace(/\\/g, "\\\\")}]`;
                i = j;
            } else {
                re += "\\[";
            }
        } else {
            re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
        }
    }
    return new RegExp(re + "$");
}

// Match a glob pattern (may contain `/`) against the VFS: each `/`-segment
// with glob chars is expanded against that directory's listing; segments
// without glob chars pass through literally. Returns matching absolute paths,
// sorted. Dotfiles are only matched when the pattern segment itself starts
// with `.`.
export function globPaths(vfs, pattern, cwd) {
    const absolute = pattern.startsWith("/");
    const norm = absolute ? pattern.slice(1) : pattern;
    const segments = norm.split("/").filter((s) => s !== "");
    // Track the absolute path (for VFS lookups) alongside the display path
    // (for the result, matching the pattern's own relative/absolute form).
    let bases = [{ abs: absolute ? "/" : cwd, disp: absolute ? "/" : "" }];
    for (const seg of segments) {
        const next = [];
        for (const base of bases) {
            if (!hasGlobChars(seg)) {
                const candidate = joinPath(base.abs, seg);
                if (vfs.exists(candidate)) next.push({ abs: candidate, disp: joinDisp(base.disp, seg) });
                continue;
            }
            if (!vfs.isDir(base.abs)) continue;
            const re = globToRegExp(seg);
            for (const name of vfs.readdir(base.abs)) {
                if (name.startsWith(".") && !seg.startsWith(".")) continue;
                if (re.test(name)) next.push({ abs: joinPath(base.abs, name), disp: joinDisp(base.disp, name) });
            }
        }
        bases = next;
        if (bases.length === 0) return [];
    }
    return [...new Map(bases.map((b) => [b.abs, b.disp])).values()].sort();
}

function joinPath(base, seg) {
    return base === "/" ? `/${seg}` : `${base}/${seg}`;
}

function joinDisp(disp, seg) {
    if (disp === "/") return `/${seg}`;
    return disp === "" ? seg : `${disp}/${seg}`;
}
