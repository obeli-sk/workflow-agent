// In-memory virtual filesystem. Paths are always absolute inside the VFS;
// callers normalize relative paths against cwd before calling in.
//
// PORT: vendor/just-bash-rs/src/fs.rs
//
// The tree of nodes (root/children Maps) covers the eager files and
// directories the shell itself creates. Everything mount-related (symlinks,
// lazy/pending files, deferred mounts, web mounts, the executable bit) is
// layered on top as separate overlays, consulted by `isFile`/`isDir`/
// `exists`/`readFile`/`writeFile`/`readdir`/`remove` before or after the
// plain tree lookup, mirroring the corresponding checks in fs.rs. Content is
// always a JS string (this port's convention throughout, see `readFile`),
// not a byte buffer, so `MAX_LAZY_FETCH_BYTES` bounds string length rather
// than a true byte count; that is a deliberate deviation from fs.rs's
// `Vec<u8>`-based cap, acceptable because nothing in this codebase deals in
// raw bytes.

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

// Largest lazy file this VFS will materialize.
// PORT: fs.rs's MAX_LAZY_FETCH_BYTES.
export const MAX_LAZY_FETCH_BYTES = 1024 * 1024;

// True if `digest` is namespaced in our own CAS scheme (`sha256:...`). A
// `lazyFileRef().digest` is only trustworthy as a `content_digest` when this
// holds: deployment mounts and MCP resources are always CAS-addressed this
// way, but a git/web mount's digest is the remote's own foreign hash (e.g. a
// GitHub blob's 40-hex git SHA-1, no `sha256:` prefix at all) and must not be
// reused as one. Deliberately a prefix check, not a strict-shape one: plenty
// of tests use short placeholder digests like `sha256:1`, and a malformed
// real one is still caught later by the server's own verify step.
// PORT: fs.rs's `is_cas_namespaced_digest`.
export function isCasNamespacedDigest(digest) {
    return digest.startsWith("sha256:");
}

function dirNode() {
    return { type: "dir", children: new Map() };
}

function fileNode(content = "") {
    return { type: "file", content };
}

export class FsError extends Error {
    constructor(message, code, details) {
        super(message);
        this.code = code;
        if (details) Object.assign(this, details);
    }
}

export class Vfs {
    constructor() {
        this.root = dirNode();
        // Loader for `pending` bytes with no mount-specific loader of their
        // own. `loader(digest) -> content`. See `setBlobLoader`.
        this.blobLoader = null;
        // Symlink path -> absolute target path. See `resolve`.
        this.symlinks = new Map();
        // Resolved paths carrying an execute bit (`chmod +x`). See
        // `setExecutable`/`isExecutable`.
        this.executable = new Set();
        // Web mounts (lazily-listed remote directory trees): { root, base,
        // provider }. See `registerWebMount`.
        this.mounts = [];
        // Overlay for web mounts, materialized on access. Files discovered
        // there are registered in the ordinary lazy-file tree so their
        // content pointers survive snapshots.
        this.web = { expanded: new Set(), dirs: new Set() };
        // One-shot deferred mounts: [{ root, populate }]. See
        // `registerDeferredMount`/`ensureMountedFor`.
        this.deferred = [];
    }

    // Install the loader that fetches bounded `pending` files on first read
    // (see `registerLazy`). `fn(digest) -> content`.
    setBlobLoader(fn) {
        this.blobLoader = fn;
    }

    _segments(path) {
        const norm = normalizePath(path, "/");
        return norm === "/" ? [] : norm.slice(1).split("/");
    }

    // Plain tree walk: the node at an already-resolved, normalized path, or
    // null. No symlink resolution, no lazy/web materialization; callers that
    // need those go through `resolve` and the overlays first.
    lookup(path) {
        const segs = this._segments(path);
        let node = this.root;
        for (const seg of segs) {
            if (node.type !== "dir") return null;
            node = node.children.get(seg);
            if (!node) return null;
        }
        return node;
    }

    _ensureDir(path) {
        const segs = this._segments(path);
        let node = this.root;
        for (const seg of segs) {
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
        this._ensureDir(this.resolve(path));
    }

    // Rewrite `path` through the longest matching symlink prefix (exact
    // match, or the path is inside a linked directory), bounded to a few
    // hops so a link cycle resolves to whatever the last hop produces rather
    // than looping forever. Every other operation calls this first, the same
    // way fs.rs calls `self.resolve(path)` at the top of nearly every method.
    // PORT: fs.rs's `resolve` (there: first BTreeMap-order match; here:
    // explicit longest-prefix, a minor deliberate improvement since links
    // never nest in practice but longest-prefix is the more obviously
    // correct tie-break).
    resolve(path) {
        let current = normalizePath(path, "/");
        for (let hop = 0; hop < 8; hop++) {
            let best = null;
            for (const [link, target] of this.symlinks) {
                if (current === link || current.startsWith(`${link}/`)) {
                    if (!best || link.length > best[0].length) best = [link, target];
                }
            }
            if (!best) break;
            current = best[1] + current.slice(best[0].length);
        }
        return current;
    }

    // Create a symlink at `link` pointing to `target`. `target` must already
    // be absolute (normalized, not resolved against `link`'s directory).
    // Overwrites any existing symlink at `link`. Not supported: symlink
    // loops beyond `resolve`'s hop bound, relative targets, or any `ls -l`
    // "name -> target" display.
    symlink(target, link) {
        this.symlinks.set(normalizePath(link, "/"), normalizePath(target, "/"));
    }

    isSymlink(path) {
        return this.symlinks.has(normalizePath(path, "/"));
    }

    // Set or clear a file's execute bit (`chmod`). Resolved through symlinks
    // first, like every other operation.
    setExecutable(path, on) {
        const p = this.resolve(path);
        if (on) this.executable.add(p);
        else this.executable.delete(p);
    }

    isExecutable(path) {
        return this.executable.has(this.resolve(path));
    }

    // Register a deployment-owned (or MCP-resource-owned) file by digest and
    // size. The path lists immediately but holds no bytes yet; a read fetches
    // the body lazily, once, only when it is within MAX_LAZY_FETCH_BYTES.
    // Overwrites any node already at `path`, including a previously
    // fetched/cached body.
    registerLazy(path, digest, size) {
        this._registerLazyInner(path, digest, size, null);
    }

    // Register a lazy file whose bytes come from a mount-specific loader
    // rather than the default one installed by `setBlobLoader`.
    registerLazyWithLoader(path, digest, size, loader) {
        this._registerLazyInner(path, digest, size, loader);
    }

    _registerLazyInner(path, digest, size, loader) {
        const p = this.resolve(path);
        const dir = this._ensureDir(dirname(p));
        const name = basename(p);
        const node = fileNode(null);
        node.pending = { digest, size };
        if (loader) node.loader = loader;
        dir.children.set(name, node);
        this.executable.delete(p);
    }

    // True if `path` is a lazily-mounted file whose bytes have not been
    // modified locally (registered by `registerLazy`/`registerLazyWithLoader`
    // and never locally written). Reading a pending file caches its bytes but
    // leaves it pending; only a write clears it.
    isPending(path) {
        const node = this.lookup(this.resolve(path));
        return !!(node && node.type === "file" && !!node.pending);
    }

    // The digest and authoritative byte length of an unmodified mounted
    // file, or null.
    lazyFileRef(path) {
        const node = this.lookup(this.resolve(path));
        if (node && node.type === "file" && node.pending) {
            return { digest: node.pending.digest, size: node.pending.size };
        }
        return null;
    }

    // Register a one-shot deferred mount rooted at `root`. The tree is not
    // populated until the first `ensureMountedFor` whose path falls under
    // `root`, at which point `populate(vfs)` runs. The root is pre-created as
    // an empty directory so it lists under its parent before the mount
    // fires.
    registerDeferredMount(root, populate) {
        const normRoot = normalizePath(root, "/");
        this._ensureDir(normRoot);
        this.deferred.push({ root: normRoot, populate });
    }

    // Run the deferred mount whose root is at or above `path`, if any; a
    // no-op once that mount has fired. The interpreter's command-dispatch
    // chokepoint should call this before each command that touches a path
    // (mirroring fs.rs's doc comment on `ensure_mounted_for`); not yet wired
    // here.
    ensureMountedFor(path) {
        const p = normalizePath(path, "/");
        const idx = this.deferred.findIndex(({ root }) => p === root || p.startsWith(`${root}/`));
        if (idx === -1) return;
        const [{ populate }] = this.deferred.splice(idx, 1);
        populate(this);
    }

    // Drop the deferred mount rooted at `root` without running it.
    clearDeferredMount(root) {
        const normRoot = normalizePath(root, "/");
        this.deferred = this.deferred.filter(({ root: r }) => r !== normRoot);
    }

    // Mount a lazily-listed remote directory tree at `root`, sourced from
    // `provider` at remote path `base`. `provider` is `{ list(remotePath),
    // read(remotePath) }`: `list` returns
    // `Array<{name, kind: "dir"} | {name, kind: "file", digest, size}>` and is called
    // at most once per directory (only when something under it is actually
    // accessed); `read` returns the file's content and is called at most
    // once per file, cached after.
    registerWebMount(root, base, provider) {
        const normRoot = normalizePath(root, "/");
        this._ensureDir(dirname(normRoot));
        this.web.dirs.add(normRoot);
        this.mounts.push({ root: normRoot, base, provider });
    }

    // The mount and remote path for a VFS path inside a web mount, or null.
    _webRemote(path) {
        for (const mount of this.mounts) {
            if (path === mount.root) return { mount, remote: mount.base };
            if (path.startsWith(`${mount.root}/`)) {
                const rest = path.slice(mount.root.length + 1);
                const remote = mount.base ? `${mount.base}/${rest}` : rest;
                return { mount, remote };
            }
        }
        return null;
    }

    // List a web directory once, recording its children into the overlay. A
    // listing error still marks the directory expanded so a failed fetch is
    // not retried on every access.
    _ensureExpanded(dir) {
        if (this.web.expanded.has(dir) || !this.web.dirs.has(dir)) return;
        const remote = this._webRemote(dir);
        if (!remote) return;
        let entries = [];
        let ok = true;
        try {
            entries = remote.mount.provider.list(remote.remote) || [];
        } catch {
            ok = false;
        }
        this.web.expanded.add(dir);
        if (!ok) return;
        for (const entry of entries) {
            const child = `${dir}/${entry.name}`;
            if (entry.kind === "dir") this.web.dirs.add(child);
            else {
                const remotePath = this._webRemote(child)?.remote;
                this.registerLazyWithLoader(child, entry.digest, entry.size, () =>
                    remote.mount.provider.read(remotePath),
                );
            }
        }
    }

    exists(path) {
        return this.isFile(path) || this.isDir(path);
    }

    isDir(path) {
        const p = this.resolve(path);
        const node = this.lookup(p);
        if (node && node.type === "dir") return true;
        if (this.web.dirs.has(p)) return true;
        if (p !== "/") {
            this._ensureExpanded(dirname(p));
            return this.web.dirs.has(p);
        }
        return false;
    }

    isFile(path) {
        const p = this.resolve(path);
        const node = this.lookup(p);
        if (node && node.type === "file") return true;
        if (p !== "/") {
            this._ensureExpanded(dirname(p));
            const expanded = this.lookup(p);
            return !!expanded && expanded.type === "file";
        }
        return false;
    }

    // Read a file's content. A bounded `pending` file is
    // fetched on first read and cached; the pending flag itself is left
    // untouched by a read (only a write clears it, see `writeFile`). A file
    // over MAX_LAZY_FETCH_BYTES, or a failed fetch, throws an `FsError` with
    // code "TOO_LARGE" / "READ_UNAVAILABLE" rather than returning partial or
    // absent content, so callers can tell the two apart.
    readFile(path) {
        const p = this.resolve(path);
        const node = this.lookup(p);
        if (node && node.type === "dir") throw new FsError(`Is a directory: ${path}`, "EISDIR");
        if (node && node.type === "file") {
            if (node.pending) {
                if (node.content === null) node.content = this._fetchPending(path, node);
                return node.content;
            }
            return node.content ?? "";
        }
        if (p !== "/") this._ensureExpanded(dirname(p));
        throw new FsError(`No such file or directory: ${path}`, "ENOENT");
    }

    _fetchPending(path, node) {
        if (node.pending.size > MAX_LAZY_FETCH_BYTES) {
            throw new FsError(`File too large: ${path}`, "TOO_LARGE", {
                digest: node.pending.digest,
                size: node.pending.size,
            });
        }
        const loader = node.loader ?? this.blobLoader;
        if (!loader) throw new FsError(`Read unavailable: ${path}`, "READ_UNAVAILABLE");
        let content;
        try {
            content = loader(node.pending.digest);
        } catch {
            throw new FsError(`Read unavailable: ${path}`, "READ_UNAVAILABLE");
        }
        if (content.length > MAX_LAZY_FETCH_BYTES) {
            throw new FsError(`File too large: ${path}`, "TOO_LARGE", {
                digest: node.pending.digest,
                size: content.length,
            });
        }
        return content;
    }

    // Write (truncating) a file, creating parent directories as needed.
    // Fails if the path names an existing directory. Discards any pending
    // (not-yet-fetched or cached) lazy body: a local write always wins.
    writeFile(path, content) {
        const p = this.resolve(path);
        const existing = this.lookup(p);
        if (existing && existing.type === "dir") throw new FsError(`Is a directory: ${path}`, "EISDIR");
        const dir = this._ensureDir(dirname(p));
        dir.children.set(basename(p), fileNode(content));
    }

    // Materializes a pending file's existing bytes before appending, so the
    // fetched content is preserved rather than replaced by
    // the appended tail; the resulting write clears the pending flag, same
    // as any other `writeFile`.
    appendFile(path, content) {
        if (this.exists(path)) {
            this.writeFile(path, this.readFile(path) + content);
        } else {
            this.writeFile(path, content);
        }
    }

    readdir(path) {
        const dir = this.resolve(path);
        const node = this.lookup(dir);
        if (node && node.type === "file") throw new FsError(`Not a directory: ${path}`, "ENOTDIR");
        const isTreeDir = !!node && node.type === "dir";
        const isWebDir = this.web.dirs.has(dir);
        if (!isTreeDir && !isWebDir) {
            throw new FsError(`No such file or directory: ${path}`, "ENOENT");
        }
        this._ensureExpanded(dir);
        const names = new Set();
        const expandedTreeDir = this.lookup(dir);
        if (expandedTreeDir && expandedTreeDir.type === "dir") {
            for (const name of expandedTreeDir.children.keys()) names.add(name);
        }
        for (const link of this.symlinks.keys()) {
            if (dirname(link) === dir) names.add(basename(link));
        }
        for (const d of this.web.dirs) {
            if (d !== dir && dirname(d) === dir) names.add(basename(d));
        }
        return [...names].sort();
    }

    // Remove a file. With `recursive`, also removes a directory and
    // everything under it. A symlink itself is removed (not resolved
    // through) when `path` names it exactly, matching real `rm`'s
    // no-dereference behavior.
    remove(path, { recursive = false } = {}) {
        const raw = normalizePath(path, "/");
        if (this.symlinks.has(raw)) {
            this.symlinks.delete(raw);
            return;
        }
        const p = this.resolve(path);
        const parentPath = dirname(p);
        const name = basename(p);
        const parent = this.lookup(parentPath);
        if (parent && parent.type === "dir" && parent.children.has(name)) {
            const node = parent.children.get(name);
            if (node.type === "dir" && node.children.size > 0 && !recursive) {
                throw new FsError(`Directory not empty: ${path}`, "ENOTEMPTY");
            }
            if (node.type === "dir") {
                const prefix = `${p}/`;
                for (const e of [...this.executable]) {
                    if (e === p || e.startsWith(prefix)) this.executable.delete(e);
                }
            }
            parent.children.delete(name);
            this.executable.delete(p);
            return;
        }
        // Web-mounted directories live only in the overlay.
        if (this.web.dirs.has(p)) {
            if (!recursive) throw new FsError(`Is a directory: ${path}`, "EISDIR");
            const prefix = `${p}/`;
            for (const d of [...this.web.dirs]) if (d === p || d.startsWith(prefix)) this.web.dirs.delete(d);
            for (const e of [...this.web.expanded]) if (e === p || e.startsWith(prefix)) this.web.expanded.delete(e);
            return;
        }
        throw new FsError(`No such file or directory: ${path}`, "ENOENT");
    }

    rename(from, to) {
        const fromResolved = this.resolve(from);
        const toResolved = this.resolve(to);
        const node = this.lookup(fromResolved);
        if (!node) throw new FsError(`No such file or directory: ${from}`, "ENOENT");
        const fromParent = this.lookup(dirname(fromResolved));
        const toParent = this._ensureDir(dirname(toResolved));
        toParent.children.set(basename(toResolved), node);
        fromParent.children.delete(basename(fromResolved));
        if (this.executable.has(fromResolved)) {
            this.executable.delete(fromResolved);
            this.executable.add(toResolved);
        }
    }

    // Copy a single file from `from` to `to`. A lazily-mounted, unmodified
    // (pending) source copies *by reference*: `to` is registered lazy with
    // the same content digest and loader, so nothing is fetched (a component
    // WASM blob can be tens of MB, and the copy is meant to be as cheap as
    // the mount). A modified or eager source copies its bytes.
    // PORT: fs.rs's `copy_file`.
    copyFile(from, to) {
        const node = this.lookup(this.resolve(from));
        if (node && node.type === "file" && node.pending) {
            const { digest, size } = node.pending;
            if (node.loader) this.registerLazyWithLoader(to, digest, size, node.loader);
            else this.registerLazy(to, digest, size);
            return;
        }
        const content = this.readFile(from);
        this.writeFile(to, content);
    }
}
