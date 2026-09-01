// In-memory virtual filesystem. Paths are always absolute inside the VFS;
// callers normalize relative paths against cwd before calling in.

export function normalizePath(path, cwd) {
    if (!path) return cwd;
    const abs = path.startsWith("/") ? path : `${cwd}/${path}`;
    const parts = abs.split("/");
    const out = [];
    for (const part of parts) {
        if (part === "" || part === ".") continue;
        if (part === "..") {
            if (out.length) out.pop();
            continue;
        }
        out.push(part);
    }
    return `/${out.join("/")}`;
}

export function dirname(path) {
    const norm = normalizePath(path, "/");
    const idx = norm.lastIndexOf("/");
    if (idx <= 0) return "/";
    return norm.slice(0, idx);
}

export function basename(path) {
    const norm = normalizePath(path, "/");
    if (norm === "/") return "/";
    return norm.slice(norm.lastIndexOf("/") + 1);
}

function dirNode() {
    return { type: "dir", children: new Map() };
}

function fileNode(content = "") {
    return { type: "file", content };
}

export class FsError extends Error {
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}

export class Vfs {
    constructor() {
        this.root = dirNode();
        this.blobLoader = null;
    }

    setBlobLoader(fn) {
        this.blobLoader = fn;
    }

    _segments(path) {
        const norm = normalizePath(path, "/");
        return norm === "/" ? [] : norm.slice(1).split("/");
    }

    // Returns the node at path, or null. Follows deferred-mount lazy loaders
    // transparently (see registerDeferredMount).
    lookup(path) {
        const segs = this._segments(path);
        let node = this.root;
        for (const seg of segs) {
            if (node.type !== "dir") return null;
            this._materialize(node);
            node = node.children.get(seg);
            if (!node) return null;
        }
        this._materialize(node);
        return node;
    }

    _materialize(node) {
        if (node.type === "dir" && node.lazy && !node.loaded) {
            node.loaded = true;
            const entries = node.lazy() || [];
            for (const [name, isDir] of entries) {
                node.children.set(name, isDir ? dirNode() : fileNode(""));
            }
        }
        if (node.type === "file" && node.lazyContent && node.content === null) {
            node.content = node.lazyContent() ?? "";
        }
    }

    // A directory whose child listing is computed on first access.
    mountLazyDir(path, listFn) {
        const node = this._ensureDir(dirname(path));
        const name = basename(path);
        const lazy = dirNode();
        lazy.lazy = listFn;
        node.children.set(name, lazy);
    }

    mountLazyFile(path, contentFn) {
        const node = this._ensureDir(dirname(path));
        const name = basename(path);
        const file = fileNode(null);
        file.lazyContent = contentFn;
        node.children.set(name, file);
    }

    _ensureDir(path) {
        const segs = this._segments(path);
        let node = this.root;
        for (const seg of segs) {
            this._materialize(node);
            let next = node.children.get(seg);
            if (!next) {
                next = dirNode();
                node.children.set(seg, next);
            }
            if (next.type !== "dir") throw new FsError(`not a directory: ${seg}`, "ENOTDIR");
            node = next;
        }
        return node;
    }

    mkdirp(path) {
        this._ensureDir(path);
    }

    exists(path) {
        return this.lookup(path) !== null;
    }

    isDir(path) {
        const node = this.lookup(path);
        return !!node && node.type === "dir";
    }

    isFile(path) {
        const node = this.lookup(path);
        return !!node && node.type === "file";
    }

    readFile(path) {
        const node = this.lookup(path);
        if (!node) throw new FsError(`No such file or directory: ${path}`, "ENOENT");
        if (node.type !== "file") throw new FsError(`Is a directory: ${path}`, "EISDIR");
        return node.content ?? "";
    }

    writeFile(path, content) {
        const dir = this._ensureDir(dirname(path));
        const name = basename(path);
        const existing = dir.children.get(name);
        if (existing && existing.type === "dir") throw new FsError(`Is a directory: ${path}`, "EISDIR");
        dir.children.set(name, fileNode(content));
    }

    appendFile(path, content) {
        if (this.exists(path)) {
            this.writeFile(path, this.readFile(path) + content);
        } else {
            this.writeFile(path, content);
        }
    }

    readdir(path) {
        const node = this.lookup(path);
        if (!node) throw new FsError(`No such file or directory: ${path}`, "ENOENT");
        if (node.type !== "dir") throw new FsError(`Not a directory: ${path}`, "ENOTDIR");
        return [...node.children.keys()].sort();
    }

    remove(path, { recursive = false } = {}) {
        const parentPath = dirname(path);
        const name = basename(path);
        const parent = this.lookup(parentPath);
        if (!parent || parent.type !== "dir" || !parent.children.has(name)) {
            throw new FsError(`No such file or directory: ${path}`, "ENOENT");
        }
        const node = parent.children.get(name);
        if (node.type === "dir" && node.children.size > 0 && !recursive) {
            throw new FsError(`Directory not empty: ${path}`, "ENOTEMPTY");
        }
        parent.children.delete(name);
    }

    rename(from, to) {
        const node = this.lookup(from);
        if (!node) throw new FsError(`No such file or directory: ${from}`, "ENOENT");
        const fromParent = this.lookup(dirname(from));
        const toParent = this._ensureDir(dirname(to));
        toParent.children.set(basename(to), node);
        fromParent.children.delete(basename(from));
    }

    copyFile(from, to) {
        const content = this.readFile(from);
        this.writeFile(to, content);
    }
}
