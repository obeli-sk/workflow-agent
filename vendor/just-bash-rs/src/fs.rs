//! PORT: vendor/just-bash/src/fs/ (in-memory-fs, read-write-fs, overlay-fs)
//!
//! The virtual filesystem that backs the session workspace. The workflow holds
//! one instance for the whole durable session and mounts the obelisk-control
//! pack into it. Upstream ships a full overlay/mountable stack with symlinks;
//! this port starts with the in-memory core the shell actually needs: files,
//! implied directories, a minimal absolute-path symlink (added for the phase-4
//! pack bridge, see `symlink` below), and the handful of operations
//! redirections and the file-aware builtins call.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

/// Fetches a deployment-owned file's bytes from the content-addressed store by
/// its `sha256:...` content digest. Installed on the `Vfs` by the session's
/// deployment mount (`obelisk_pack::mount`) so the file tree is browsable
/// immediately while eligible files' bytes are pulled only when first read
/// (see `Vfs::register_lazy` / `Vfs::read_file`).
pub trait BlobLoader {
    fn load(&self, digest: &str) -> Result<Vec<u8>, String>;
}

/// Lists and reads a lazily-mounted directory tree (a remote repo browsed over
/// the network). Unlike `BlobLoader`, the structure is not known at mount time:
/// `list` is called on first `ls` of a mounted directory to discover its
/// children, and `read` fetches a file's bytes on first read. `remote_path` is
/// the path within the mount's remote root (empty for the mount root itself).
/// Installed by `Vfs::register_web_mount`; see `obelisk_web`.
pub trait DirProvider {
    fn list(&self, remote_path: &str) -> Result<Vec<WebEntry>, String>;
    fn read(&self, remote_path: &str) -> Result<Vec<u8>, String>;
}

/// One child of a lazily-listed directory: a subdirectory (itself lazy) or a
/// file with its authoritative byte length.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WebEntry {
    pub name: String,
    pub kind: WebEntryKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WebEntryKind {
    Dir,
    File { size: u64 },
}

/// Largest lazy blob the VFS will materialize into workflow memory.
pub const MAX_LAZY_FETCH_BYTES: u64 = 1024 * 1024;

/// Content-addressed metadata for an unmodified mounted file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LazyFileRef {
    pub digest: String,
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileReadError {
    NotFound(String),
    Unavailable(String),
    TooLarge {
        path: String,
        reference: LazyFileRef,
    },
}

/// A directory tree mounted from a remote `DirProvider`, rooted at `root` in the
/// VFS and at `base` in the provider's remote namespace.
#[derive(Clone)]
struct WebMount {
    root: String,
    base: String,
    provider: Rc<dyn DirProvider>,
}

/// The read-path overlay for web mounts, materialized on access (like
/// `lazy_cache`): `dirs`/`files` are children discovered by expanding a listed
/// directory, `expanded` marks directories already listed, and `cache` holds
/// fetched file bytes. Kept behind a `RefCell` so listing and reading stay
/// `&self` calls, matching the rest of the read surface.
#[derive(Clone, Default, Debug)]
struct WebState {
    expanded: BTreeSet<String>,
    dirs: BTreeSet<String>,
    files: BTreeMap<String, u64>,
    cache: BTreeMap<String, Vec<u8>>,
}

/// An in-memory tree of text files keyed by absolute, normalized path.
///
/// Directories are tracked explicitly (including ancestors) so `readdir` can
/// list them even when empty. Paths passed in are expected to be absolute; they
/// are normalized defensively so `.`/`..` never escape the root.
#[derive(Clone, Default)]
pub struct Vfs {
    files: BTreeMap<String, Vec<u8>>,
    dirs: BTreeSet<String>,
    /// Symlink path -> absolute target path. Consulted by `resolve` so reads,
    /// writes, and directory listings are transparent through a link; see
    /// `symlink`'s doc comment for what is deliberately not supported.
    symlinks: BTreeMap<String, String>,
    /// Files carrying an execute bit (set by `chmod +x`). The only permission
    /// bit modelled: a path-invoked script (`./x.sh`) must be executable or the
    /// shell reports `Permission denied`, matching real bash.
    executable: BTreeSet<String>,
    /// Deployment-owned files whose bytes have not been fetched yet: resolved
    /// path -> content reference. Populated by `register_lazy` so the mounted
    /// deployment tree lists (`ls`, `exists`, `is_file`) without any CAS
    /// round-trips; bounded files are pulled by `loader` on the first read.
    pending: BTreeMap<String, LazyFileRef>,
    /// Bytes fetched for a `pending` entry, cached so each file is fetched at
    /// most once. Interior mutability keeps `read_file` a `&self` call, so the
    /// whole read-side command surface is unchanged by lazy loading.
    lazy_cache: RefCell<BTreeMap<String, Vec<u8>>>,
    /// Loader for `pending` bytes. `None` outside a mounted session (the bare
    /// interpreter and unit tests), where nothing is ever `pending`.
    loader: Option<Rc<dyn BlobLoader>>,
    /// Path-specific loaders for mounts backed by a different blob source.
    mounted_loaders: BTreeMap<String, Rc<dyn BlobLoader>>,
    /// Web mounts (lazily-listed remote directory trees), set at mount time and
    /// read-only after; the discovered structure lives in `web`.
    mounts: Vec<WebMount>,
    /// Overlay for web mounts, materialized on access. See `WebState`.
    web: RefCell<WebState>,
}

impl std::fmt::Debug for Vfs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vfs")
            .field("files", &self.files)
            .field("dirs", &self.dirs)
            .field("symlinks", &self.symlinks)
            .field("executable", &self.executable)
            .field("pending", &self.pending)
            .field("lazy_cache", &self.lazy_cache)
            .field("loader", &self.loader.as_ref().map(|_| "..."))
            .field("mounted_loaders", &self.mounted_loaders.keys())
            .field("web_mounts", &self.mounts.iter().map(|m| &m.root).collect::<Vec<_>>())
            .field("web", &self.web)
            .finish()
    }
}

impl Vfs {
    pub fn new() -> Self {
        let mut dirs = BTreeSet::new();
        dirs.insert("/".to_string());
        Self {
            files: BTreeMap::new(),
            dirs,
            symlinks: BTreeMap::new(),
            executable: BTreeSet::new(),
            pending: BTreeMap::new(),
            lazy_cache: RefCell::new(BTreeMap::new()),
            loader: None,
            mounted_loaders: BTreeMap::new(),
            mounts: Vec::new(),
            web: RefCell::new(WebState::default()),
        }
    }

    /// Mount a lazily-listed remote directory tree at `root`, sourced from
    /// `provider` at remote path `base`. The tree lists nothing until a
    /// directory under `root` is first read (`ls`), and each file's bytes are
    /// fetched on first read; see `WebState` and `DirProvider`.
    pub fn register_web_mount(&mut self, root: &str, base: &str, provider: Rc<dyn DirProvider>) {
        let root = Self::normalize(root);
        if let Some(parent) = Self::parent(&root) {
            self.ensure_dirs(&parent);
        }
        self.web.borrow_mut().dirs.insert(root.clone());
        self.mounts.push(WebMount {
            root,
            base: base.to_string(),
            provider,
        });
    }

    /// The mount index and remote path for a VFS path inside a web mount, or
    /// `None` if the path is not under any mount root.
    fn web_remote(&self, path: &str) -> Option<(usize, String)> {
        for (index, mount) in self.mounts.iter().enumerate() {
            if path == mount.root {
                return Some((index, mount.base.clone()));
            }
            if let Some(rest) = path.strip_prefix(&format!("{}/", mount.root)) {
                let remote = if mount.base.is_empty() {
                    rest.to_string()
                } else {
                    format!("{}/{rest}", mount.base)
                };
                return Some((index, remote));
            }
        }
        None
    }

    /// List a web directory once, recording its children (subdirs and files)
    /// into the overlay. A listing error still marks the directory expanded so
    /// a failed fetch is not retried on every access.
    fn ensure_expanded(&self, dir: &str) {
        {
            let web = self.web.borrow();
            if web.expanded.contains(dir) || !web.dirs.contains(dir) {
                return;
            }
        }
        let Some((index, remote)) = self.web_remote(dir) else {
            return;
        };
        let provider = self.mounts[index].provider.clone();
        let entries = provider.list(&remote);
        let mut web = self.web.borrow_mut();
        web.expanded.insert(dir.to_string());
        if let Ok(entries) = entries {
            for entry in entries {
                let child = format!("{dir}/{}", entry.name);
                match entry.kind {
                    WebEntryKind::Dir => {
                        web.dirs.insert(child);
                    }
                    WebEntryKind::File { size } => {
                        web.files.insert(child, size);
                    }
                }
            }
        }
    }

    /// Fetch a web-mounted file's bytes on first read, size-capped and cached.
    fn read_web_file(&self, path: &str) -> Result<Vec<u8>, FileReadError> {
        if let Some(bytes) = self.web.borrow().cache.get(path) {
            return Ok(bytes.clone());
        }
        if let Some(parent) = Self::parent(path) {
            self.ensure_expanded(&parent);
        }
        let size = match self.web.borrow().files.get(path).copied() {
            Some(size) => size,
            None => return Err(FileReadError::NotFound(path.to_string())),
        };
        if size > MAX_LAZY_FETCH_BYTES {
            return Err(FileReadError::TooLarge {
                path: path.to_string(),
                reference: LazyFileRef {
                    digest: String::new(),
                    size,
                },
            });
        }
        let Some((index, remote)) = self.web_remote(path) else {
            return Err(FileReadError::NotFound(path.to_string()));
        };
        let provider = self.mounts[index].provider.clone();
        let bytes = provider
            .read(&remote)
            .map_err(|_| FileReadError::Unavailable(path.to_string()))?;
        if bytes.len() as u64 > MAX_LAZY_FETCH_BYTES {
            return Err(FileReadError::TooLarge {
                path: path.to_string(),
                reference: LazyFileRef {
                    digest: String::new(),
                    size: bytes.len() as u64,
                },
            });
        }
        self.web
            .borrow_mut()
            .cache
            .insert(path.to_string(), bytes.clone());
        Ok(bytes)
    }

    /// Install the loader that fetches bounded `pending` files on first read.
    pub fn set_blob_loader(&mut self, loader: Rc<dyn BlobLoader>) {
        self.loader = Some(loader);
    }

    /// Register a deployment-owned file by digest and size. The path lists
    /// immediately but holds no bytes yet. Reads fetch the body lazily only
    /// when it is within `MAX_LAZY_FETCH_BYTES`. Overwrites content at `path`,
    /// including a previously fetched/cached body (so `deployment refresh` can
    /// re-point a file at a new digest and discard the stale bytes).
    pub fn register_lazy(&mut self, path: &str, digest: &str, size: u64) {
        self.register_lazy_inner(path, digest, size, None);
    }

    /// Register a lazy file whose bytes come from a mount-specific loader.
    pub fn register_lazy_with_loader(
        &mut self,
        path: &str,
        digest: &str,
        size: u64,
        loader: Rc<dyn BlobLoader>,
    ) {
        self.register_lazy_inner(path, digest, size, Some(loader));
    }

    fn register_lazy_inner(
        &mut self,
        path: &str,
        digest: &str,
        size: u64,
        loader: Option<Rc<dyn BlobLoader>>,
    ) {
        let path = self.resolve(path);
        self.files.remove(&path);
        self.executable.remove(&path);
        self.lazy_cache.borrow_mut().remove(&path);
        match loader {
            Some(loader) => {
                self.mounted_loaders.insert(path.clone(), loader);
            }
            None => {
                self.mounted_loaders.remove(&path);
            }
        }
        if let Some(parent) = Self::parent(&path) {
            self.ensure_dirs(&parent);
        }
        self.pending.insert(
            path,
            LazyFileRef {
                digest: digest.to_string(),
                size,
            },
        );
    }

    /// Set or clear a file's execute bit (`chmod`). The path is resolved
    /// through symlinks first, like every other operation.
    pub fn set_executable(&mut self, path: &str, on: bool) {
        let path = self.resolve(path);
        if on {
            self.executable.insert(path);
        } else {
            self.executable.remove(&path);
        }
    }

    /// Whether a file has its execute bit set.
    pub fn is_executable(&self, path: &str) -> bool {
        self.executable.contains(&self.resolve(path))
    }

    /// Collapse `.`/`..` and redundant slashes into an absolute path. A leading
    /// slash is always produced; a non-absolute input is treated as rooted.
    pub fn normalize(path: &str) -> String {
        let mut stack: Vec<&str> = Vec::new();
        for segment in path.split('/') {
            match segment {
                "" | "." => {}
                ".." => {
                    stack.pop();
                }
                other => stack.push(other),
            }
        }
        format!("/{}", stack.join("/"))
    }

    fn parent(path: &str) -> Option<String> {
        let path = Self::normalize(path);
        if path == "/" {
            return None;
        }
        match path.rfind('/') {
            Some(0) => Some("/".to_string()),
            Some(idx) => Some(path[..idx].to_string()),
            None => Some("/".to_string()),
        }
    }

    /// Record `path` and all of its ancestors as directories.
    fn ensure_dirs(&mut self, path: &str) {
        let mut cur = Self::normalize(path);
        loop {
            self.dirs.insert(cur.clone());
            match Self::parent(&cur) {
                Some(p) => cur = p,
                None => break,
            }
        }
    }

    /// Rewrite `path` through the longest matching symlink prefix (exact match
    /// or an ancestor directory), so every other operation is symlink-
    /// transparent. Bounded to a handful of hops as loop protection: a link
    /// cycle resolves to whatever the last hop produces rather than hanging or
    /// erroring (see `symlink`'s doc comment for what's out of scope).
    fn resolve(&self, path: &str) -> String {
        let mut current = Self::normalize(path);
        for _ in 0..8 {
            let hit = self
                .symlinks
                .iter()
                .find(|(link, _)| current == **link || current.starts_with(&format!("{link}/")));
            match hit {
                Some((link, target)) => {
                    let suffix = &current[link.len()..];
                    current = format!("{target}{suffix}");
                }
                None => break,
            }
        }
        current
    }

    /// Create a symlink at `link` pointing to `target`. `target` must already
    /// be an absolute path (it is normalized, not resolved against `link`'s
    /// directory, so a relative target is not supported). Overwrites any
    /// existing symlink at `link`; does not check whether `link` already names
    /// a file or directory (matching the one caller this exists for: replacing
    /// a stale `current` link). Not supported: symlink loops (see `resolve`),
    /// relative targets, and any `ls -l`-style "name -> target" display (this
    /// port's `ls` lists resolved entries transparently, with no indicator).
    pub fn symlink(&mut self, target: &str, link: &str) -> Result<(), FsError> {
        self.symlinks
            .insert(Self::normalize(link), Self::normalize(target));
        Ok(())
    }

    pub fn is_symlink(&self, path: &str) -> bool {
        self.symlinks.contains_key(&Self::normalize(path))
    }

    pub fn exists(&self, path: &str) -> bool {
        self.is_file(path) || self.is_dir(path)
    }

    pub fn is_file(&self, path: &str) -> bool {
        let path = self.resolve(path);
        if self.files.contains_key(&path) || self.pending.contains_key(&path) {
            return true;
        }
        if self.web.borrow().files.contains_key(&path) {
            return true;
        }
        if let Some(parent) = Self::parent(&path) {
            self.ensure_expanded(&parent);
            return self.web.borrow().files.contains_key(&path);
        }
        false
    }

    /// True if `path` is a lazily-mounted file whose bytes have not been
    /// modified locally: its `content_digest` is already known (registered by
    /// `register_lazy`) and its blob lives in the CAS, so a caller need neither
    /// fetch nor re-upload it. A local write clears the pending entry, so an
    /// edited (or freshly written) file returns false. Reading a pending file
    /// caches its bytes but leaves it pending, so a mere read stays unmodified.
    pub fn is_pending(&self, path: &str) -> bool {
        self.pending.contains_key(&self.resolve(path))
    }

    /// The digest and authoritative byte length of an unmodified mounted file.
    pub fn lazy_file_ref(&self, path: &str) -> Option<LazyFileRef> {
        self.pending.get(&self.resolve(path)).cloned()
    }

    /// Byte length from local bytes or mounted metadata, without fetching.
    pub fn file_size(&self, path: &str) -> Option<u64> {
        let path = self.resolve(path);
        if let Some(bytes) = self.files.get(&path) {
            return Some(bytes.len() as u64);
        }
        if let Some(reference) = self.pending.get(&path) {
            return Some(reference.size);
        }
        if let Some(parent) = Self::parent(&path) {
            self.ensure_expanded(&parent);
        }
        self.web.borrow().files.get(&path).copied()
    }

    pub fn is_dir(&self, path: &str) -> bool {
        let path = self.resolve(path);
        if self.dirs.contains(&path) {
            return true;
        }
        if self.web.borrow().dirs.contains(&path) {
            return true;
        }
        if let Some(parent) = Self::parent(&path) {
            self.ensure_expanded(&parent);
            return self.web.borrow().dirs.contains(&path);
        }
        false
    }

    /// Read a file's bytes, returning mounted metadata when the size limit
    /// rejects the read. A bounded `pending` file is fetched from the CAS via
    /// the installed `loader` on first read and cached.
    pub fn read_file_checked(&self, path: &str) -> Result<Vec<u8>, FileReadError> {
        let path = self.resolve(path);
        if let Some(bytes) = self.files.get(&path) {
            return Ok(bytes.clone());
        }
        if let Some(bytes) = self.lazy_cache.borrow().get(&path) {
            return Ok(bytes.clone());
        }
        let Some(reference) = self.pending.get(&path) else {
            return self.read_web_file(&path);
        };
        if reference.size > MAX_LAZY_FETCH_BYTES {
            return Err(FileReadError::TooLarge {
                path,
                reference: reference.clone(),
            });
        }
        let bytes = self
            .mounted_loaders
            .get(&path)
            .or(self.loader.as_ref())
            .ok_or_else(|| FileReadError::Unavailable(path.clone()))?
            .load(&reference.digest)
            .map_err(|_| FileReadError::Unavailable(path.clone()))?;
        if bytes.len() as u64 > MAX_LAZY_FETCH_BYTES {
            return Err(FileReadError::TooLarge {
                path,
                reference: LazyFileRef {
                    digest: reference.digest.clone(),
                    size: bytes.len() as u64,
                },
            });
        }
        self.lazy_cache.borrow_mut().insert(path, bytes.clone());
        Ok(bytes)
    }

    /// Read a file for callers whose existing interface treats every read
    /// failure as absence.
    pub fn read_file(&self, path: &str) -> Option<Vec<u8>> {
        self.read_file_checked(path).ok()
    }

    /// Write (truncating) a file, creating parent directories as needed. Fails
    /// if the path names an existing directory.
    pub fn write_file(&mut self, path: &str, data: &[u8]) -> Result<(), FsError> {
        let path = self.resolve(path);
        if self.dirs.contains(&path) {
            return Err(FsError::IsDirectory(path));
        }
        if let Some(parent) = Self::parent(&path) {
            self.ensure_dirs(&parent);
        }
        // A truncating write discards any not-yet-fetched (or cached) lazy body.
        self.pending.remove(&path);
        self.mounted_loaders.remove(&path);
        self.lazy_cache.borrow_mut().remove(&path);
        self.files.insert(path, data.to_vec());
        Ok(())
    }

    pub fn append_file(&mut self, path: &str, data: &[u8]) -> Result<(), FsError> {
        let path = self.resolve(path);
        if self.dirs.contains(&path) {
            return Err(FsError::IsDirectory(path));
        }
        if let Some(parent) = Self::parent(&path) {
            self.ensure_dirs(&parent);
        }
        // Materialize a lazy file before appending so its fetched bytes are
        // preserved rather than replaced by the appended tail.
        if self.pending.contains_key(&path) {
            let existing = self
                .read_file_checked(&path)
                .map_err(|_| FsError::ReadUnavailable(path.clone()))?;
            self.pending.remove(&path);
            self.mounted_loaders.remove(&path);
            self.lazy_cache.borrow_mut().remove(&path);
            self.files.insert(path.clone(), existing);
        }
        self.files.entry(path).or_default().extend_from_slice(data);
        Ok(())
    }

    /// Copy a single file from `src` to `dest`. A lazily-mounted, unmodified
    /// (`pending`) source copies *by reference*: `dest` is registered lazy with
    /// the same content digest, so nothing is fetched from the CAS (a component
    /// WASM blob can be tens of MB, and the copy is meant to be as cheap as the
    /// mount). A modified or eager source copies its bytes. Returns false if
    /// `src` is not a readable file (a directory or a missing/unfetchable path);
    /// `cp`/`mv` walk directories themselves.
    pub fn copy_file(&mut self, src: &str, dest: &str) -> bool {
        let src = self.resolve(src);
        if let Some(reference) = self.pending.get(&src).cloned() {
            match self.mounted_loaders.get(&src).cloned() {
                Some(loader) => {
                    self.register_lazy_with_loader(dest, &reference.digest, reference.size, loader)
                }
                None => self.register_lazy(dest, &reference.digest, reference.size),
            }
            return true;
        }
        match self.read_file(&src) {
            Some(bytes) => self.write_file(dest, &bytes).is_ok(),
            None => false,
        }
    }

    /// Create a directory. With `parents`, creates ancestors and succeeds if it
    /// already exists (like `mkdir -p`); otherwise fails on an existing path or
    /// a missing parent.
    pub fn mkdir(&mut self, path: &str, parents: bool) -> Result<(), FsError> {
        let path = self.resolve(path);
        if self.files.contains_key(&path) {
            return Err(FsError::FileExists(path));
        }
        if parents {
            self.ensure_dirs(&path);
            return Ok(());
        }
        if self.dirs.contains(&path) {
            return Err(FsError::FileExists(path));
        }
        match Self::parent(&path) {
            Some(parent) if !self.dirs.contains(&parent) => Err(FsError::NotFound(parent)),
            _ => {
                self.dirs.insert(path);
                Ok(())
            }
        }
    }

    /// Immediate child names of a directory, sorted. `None` if the path is not a
    /// directory.
    pub fn readdir(&self, path: &str) -> Option<Vec<String>> {
        let dir = self.resolve(path);
        let web_dir = self.web.borrow().dirs.contains(&dir);
        if !self.dirs.contains(&dir) && !web_dir {
            return None;
        }
        self.ensure_expanded(&dir);
        let mut names = BTreeSet::new();
        for entry in self
            .files
            .keys()
            .chain(self.dirs.iter())
            .chain(self.pending.keys())
            .chain(self.symlinks.keys())
        {
            if entry == &dir {
                continue;
            }
            if Self::parent(entry).as_deref() == Some(dir.as_str())
                && let Some(name) = entry.rsplit('/').next()
            {
                names.insert(name.to_string());
            }
        }
        let web = self.web.borrow();
        for entry in web.dirs.iter().chain(web.files.keys()) {
            if entry == &dir {
                continue;
            }
            if Self::parent(entry).as_deref() == Some(dir.as_str())
                && let Some(name) = entry.rsplit('/').next()
            {
                names.insert(name.to_string());
            }
        }
        Some(names.into_iter().collect())
    }

    /// Remove a file. With `recursive`, also removes a directory and everything
    /// under it. Without it, removing a directory fails. A symlink itself is
    /// removed (not resolved through) when `path` names it exactly, matching
    /// real `rm`'s no-dereference behavior.
    pub fn remove(&mut self, path: &str, recursive: bool) -> Result<(), FsError> {
        let raw = Self::normalize(path);
        if self.symlinks.remove(&raw).is_some() {
            return Ok(());
        }
        let path = self.resolve(path);
        if self.files.remove(&path).is_some() || self.pending.remove(&path).is_some() {
            self.executable.remove(&path);
            self.mounted_loaders.remove(&path);
            self.lazy_cache.borrow_mut().remove(&path);
            return Ok(());
        }
        if self.dirs.contains(&path) {
            if !recursive {
                return Err(FsError::IsDirectory(path));
            }
            if path == "/" {
                return Err(FsError::IsDirectory(path));
            }
            let prefix = format!("{path}/");
            self.files
                .retain(|k, _| k != &path && !k.starts_with(&prefix));
            self.dirs.retain(|k| k != &path && !k.starts_with(&prefix));
            self.executable
                .retain(|k| k != &path && !k.starts_with(&prefix));
            self.pending
                .retain(|k, _| k != &path && !k.starts_with(&prefix));
            self.mounted_loaders
                .retain(|k, _| k != &path && !k.starts_with(&prefix));
            self.lazy_cache
                .borrow_mut()
                .retain(|k, _| k != &path && !k.starts_with(&prefix));
            return Ok(());
        }
        // Web-mounted entries live only in the overlay; drop the file, or the
        // whole discovered subtree for a recursive directory removal.
        {
            let mut web = self.web.borrow_mut();
            if web.files.remove(&path).is_some() {
                web.cache.remove(&path);
                return Ok(());
            }
            if web.dirs.contains(&path) {
                if !recursive {
                    return Err(FsError::IsDirectory(path));
                }
                let prefix = format!("{path}/");
                web.dirs.retain(|k| k != &path && !k.starts_with(&prefix));
                web.expanded.retain(|k| k != &path && !k.starts_with(&prefix));
                web.files.retain(|k, _| !k.starts_with(&prefix));
                web.cache.retain(|k, _| !k.starts_with(&prefix));
                return Ok(());
            }
        }
        Err(FsError::NotFound(path))
    }
}

/// Filesystem errors, carrying the offending path so callers can format the
/// coreutils-style diagnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsError {
    NotFound(String),
    IsDirectory(String),
    FileExists(String),
    ReadUnavailable(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_read_roundtrip() {
        let mut fs = Vfs::new();
        fs.write_file("/a/b/file.txt", b"hello").unwrap();
        assert_eq!(
            fs.read_file("/a/b/file.txt").as_deref(),
            Some(&b"hello"[..])
        );
        assert!(fs.is_dir("/a"));
        assert!(fs.is_dir("/a/b"));
        assert!(fs.is_file("/a/b/file.txt"));
    }

    #[test]
    fn append_creates_and_extends() {
        let mut fs = Vfs::new();
        fs.append_file("/log", b"one\n").unwrap();
        fs.append_file("/log", b"two\n").unwrap();
        assert_eq!(fs.read_file("/log").as_deref(), Some(&b"one\ntwo\n"[..]));
    }

    #[test]
    fn readdir_lists_immediate_children() {
        let mut fs = Vfs::new();
        fs.write_file("/dir/a", b"").unwrap();
        fs.write_file("/dir/b", b"").unwrap();
        fs.mkdir("/dir/sub", true).unwrap();
        fs.write_file("/dir/sub/deep", b"").unwrap();
        assert_eq!(
            fs.readdir("/dir"),
            Some(vec!["a".to_string(), "b".to_string(), "sub".to_string()])
        );
    }

    #[test]
    fn normalize_collapses_dot_dot() {
        assert_eq!(Vfs::normalize("/a/./b/../c"), "/a/c");
        assert_eq!(Vfs::normalize("/a/../../b"), "/b");
        assert_eq!(Vfs::normalize("/"), "/");
    }

    #[test]
    fn recursive_remove_clears_subtree() {
        let mut fs = Vfs::new();
        fs.write_file("/d/x", b"").unwrap();
        fs.write_file("/d/e/y", b"").unwrap();
        assert!(matches!(
            fs.remove("/d", false),
            Err(FsError::IsDirectory(_))
        ));
        fs.remove("/d", true).unwrap();
        assert!(!fs.exists("/d"));
        assert!(!fs.exists("/d/e/y"));
    }

    #[test]
    fn symlink_is_transparent_to_reads_and_writes() {
        let mut fs = Vfs::new();
        fs.write_file("/deployment/abc/deployment.toml", b"hi")
            .unwrap();
        fs.symlink("/deployment/abc", "/deployment/current")
            .unwrap();
        assert!(fs.is_dir("/deployment/current"));
        assert_eq!(
            fs.read_file("/deployment/current/deployment.toml")
                .as_deref(),
            Some(&b"hi"[..])
        );
        assert_eq!(
            fs.readdir("/deployment/current"),
            Some(vec!["deployment.toml".to_string()])
        );
        fs.write_file("/deployment/current/new.txt", b"added")
            .unwrap();
        assert_eq!(
            fs.read_file("/deployment/abc/new.txt").as_deref(),
            Some(&b"added"[..])
        );
    }

    #[test]
    fn readdir_lists_a_symlink_entry() {
        // Regression: a symlink lives only in the `symlinks` map, so an `ls` of
        // its parent (e.g. `ls /workspace/deployment` after the deployment
        // mount) must still show the link (`current`) alongside real entries.
        let mut fs = Vfs::new();
        fs.write_file("/deployment/abc/deployment.toml", b"hi")
            .unwrap();
        fs.symlink("/deployment/abc", "/deployment/current")
            .unwrap();
        assert_eq!(
            fs.readdir("/deployment"),
            Some(vec!["abc".to_string(), "current".to_string()])
        );
    }

    #[test]
    fn symlink_replacement_does_not_touch_the_old_target() {
        let mut fs = Vfs::new();
        fs.write_file("/deployment/abc/f", b"old").unwrap();
        fs.write_file("/deployment/def/f", b"new").unwrap();
        fs.symlink("/deployment/abc", "/deployment/current")
            .unwrap();
        // Removing the link (not `-r`-recursing into the target) must leave the
        // target directory intact, matching real `rm` on a symlink.
        fs.remove("/deployment/current", true).unwrap();
        assert!(fs.is_dir("/deployment/abc"));
        assert_eq!(
            fs.read_file("/deployment/abc/f").as_deref(),
            Some(&b"old"[..])
        );
        assert!(!fs.is_symlink("/deployment/current"));

        fs.symlink("/deployment/def", "/deployment/current")
            .unwrap();
        assert_eq!(
            fs.read_file("/deployment/current/f").as_deref(),
            Some(&b"new"[..])
        );
    }

    /// A loader that records every digest it is asked for, so a test can assert
    /// a lazy file is fetched exactly once.
    struct CountingLoader {
        blobs: BTreeMap<String, Vec<u8>>,
        loads: RefCell<Vec<String>>,
    }

    impl BlobLoader for CountingLoader {
        fn load(&self, digest: &str) -> Result<Vec<u8>, String> {
            self.loads.borrow_mut().push(digest.to_string());
            self.blobs
                .get(digest)
                .cloned()
                .ok_or_else(|| format!("no blob for {digest}"))
        }
    }

    #[test]
    fn lazy_file_lists_before_read_and_fetches_once_on_read() {
        let loader = Rc::new(CountingLoader {
            blobs: BTreeMap::from([("sha256:a".to_string(), b"hello".to_vec())]),
            loads: RefCell::new(Vec::new()),
        });
        let mut fs = Vfs::new();
        fs.set_blob_loader(loader.clone());
        fs.register_lazy("/dep/a.txt", "sha256:a", 5);

        // Listed and typed as a file with no fetch yet.
        assert!(fs.exists("/dep/a.txt"));
        assert!(fs.is_file("/dep/a.txt"));
        assert_eq!(fs.readdir("/dep"), Some(vec!["a.txt".to_string()]));
        assert!(loader.loads.borrow().is_empty());

        // First read fetches; second read is served from cache.
        assert_eq!(fs.read_file("/dep/a.txt").as_deref(), Some(&b"hello"[..]));
        assert_eq!(fs.read_file("/dep/a.txt").as_deref(), Some(&b"hello"[..]));
        assert_eq!(&*loader.loads.borrow(), &["sha256:a".to_string()]);
    }

    #[test]
    fn mount_specific_loader_coexists_with_default_loader() {
        let deployment_loader = Rc::new(CountingLoader {
            blobs: BTreeMap::from([("sha256:deployment".to_string(), b"deployment".to_vec())]),
            loads: RefCell::new(Vec::new()),
        });
        let mcp_loader = Rc::new(CountingLoader {
            blobs: BTreeMap::from([("sha256:mcp".to_string(), b"resource".to_vec())]),
            loads: RefCell::new(Vec::new()),
        });
        let mut fs = Vfs::new();
        fs.set_blob_loader(deployment_loader.clone());
        fs.register_lazy("/deployment/file", "sha256:deployment", 10);
        fs.register_lazy_with_loader("/mcp/file", "sha256:mcp", 8, mcp_loader.clone());

        assert_eq!(
            fs.read_file("/deployment/file").as_deref(),
            Some(&b"deployment"[..])
        );
        assert_eq!(fs.read_file("/mcp/file").as_deref(), Some(&b"resource"[..]));
        assert_eq!(&*deployment_loader.loads.borrow(), &["sha256:deployment"]);
        assert_eq!(&*mcp_loader.loads.borrow(), &["sha256:mcp"]);
    }

    #[test]
    fn writing_a_lazy_file_wins_over_the_pending_fetch() {
        let loader = Rc::new(CountingLoader {
            blobs: BTreeMap::from([("sha256:a".to_string(), b"remote".to_vec())]),
            loads: RefCell::new(Vec::new()),
        });
        let mut fs = Vfs::new();
        fs.set_blob_loader(loader.clone());
        fs.register_lazy("/dep/a.txt", "sha256:a", 6);
        fs.write_file("/dep/a.txt", b"local").unwrap();
        assert_eq!(fs.read_file("/dep/a.txt").as_deref(), Some(&b"local"[..]));
        assert!(
            loader.loads.borrow().is_empty(),
            "no fetch after a local write"
        );
    }

    #[test]
    fn copying_a_lazy_file_copies_the_reference_without_fetching() {
        let loader = Rc::new(CountingLoader {
            blobs: BTreeMap::from([("sha256:w".to_string(), b"wasm-bytes".to_vec())]),
            loads: RefCell::new(Vec::new()),
        });
        let mut fs = Vfs::new();
        fs.set_blob_loader(loader.clone());
        fs.register_lazy("/dep/current/a.wasm", "sha256:w", 10);

        // Copy a working copy alongside the original: no fetch, both lazy.
        assert!(fs.copy_file("/dep/current/a.wasm", "/dep/work/a.wasm"));
        assert!(fs.is_pending("/dep/work/a.wasm"));
        assert!(fs.is_pending("/dep/current/a.wasm"));
        assert!(loader.loads.borrow().is_empty(), "copy must not fetch");

        // The copy resolves the same blob on demand, fetched once when read.
        assert_eq!(
            fs.read_file("/dep/work/a.wasm").as_deref(),
            Some(&b"wasm-bytes"[..])
        );
        assert_eq!(&*loader.loads.borrow(), &["sha256:w".to_string()]);
    }

    #[test]
    fn missing_loader_or_failed_fetch_reads_as_absent() {
        let mut fs = Vfs::new();
        fs.register_lazy("/dep/a.txt", "sha256:a", 1);
        // Listed, but unreadable without a loader.
        assert!(fs.is_file("/dep/a.txt"));
        assert_eq!(fs.read_file("/dep/a.txt"), None);
    }

    #[test]
    fn oversized_lazy_file_reports_size_without_fetching() {
        let loader = Rc::new(CountingLoader {
            blobs: BTreeMap::from([("sha256:big".to_string(), vec![b'x'; 8])]),
            loads: RefCell::new(Vec::new()),
        });
        let mut fs = Vfs::new();
        fs.set_blob_loader(loader.clone());
        fs.register_lazy(
            "/dep/component.wasm",
            "sha256:big",
            MAX_LAZY_FETCH_BYTES + 1,
        );

        assert_eq!(
            fs.file_size("/dep/component.wasm"),
            Some(MAX_LAZY_FETCH_BYTES + 1)
        );
        assert_eq!(
            fs.read_file_checked("/dep/component.wasm"),
            Err(FileReadError::TooLarge {
                path: "/dep/component.wasm".to_string(),
                reference: LazyFileRef {
                    digest: "sha256:big".to_string(),
                    size: MAX_LAZY_FETCH_BYTES + 1,
                },
            })
        );
        assert_eq!(fs.read_file("/dep/component.wasm"), None);
        assert!(loader.loads.borrow().is_empty());
        assert_eq!(
            fs.append_file("/dep/component.wasm", b"tail"),
            Err(FsError::ReadUnavailable("/dep/component.wasm".to_string()))
        );
        assert!(fs.is_pending("/dep/component.wasm"));
        assert_eq!(
            fs.file_size("/dep/component.wasm"),
            Some(MAX_LAZY_FETCH_BYTES + 1)
        );
    }

    /// A web provider backed by fixed remote listings and file bodies, counting
    /// every `list`/`read` so a test can assert lazy expansion fetches once.
    struct FakeProvider {
        listings: BTreeMap<String, Vec<WebEntry>>,
        files: BTreeMap<String, Vec<u8>>,
        lists: RefCell<Vec<String>>,
        reads: RefCell<Vec<String>>,
    }

    impl DirProvider for FakeProvider {
        fn list(&self, remote_path: &str) -> Result<Vec<WebEntry>, String> {
            self.lists.borrow_mut().push(remote_path.to_string());
            self.listings
                .get(remote_path)
                .cloned()
                .ok_or_else(|| format!("no listing for {remote_path}"))
        }

        fn read(&self, remote_path: &str) -> Result<Vec<u8>, String> {
            self.reads.borrow_mut().push(remote_path.to_string());
            self.files
                .get(remote_path)
                .cloned()
                .ok_or_else(|| format!("no file for {remote_path}"))
        }
    }

    fn dir(name: &str) -> WebEntry {
        WebEntry {
            name: name.to_string(),
            kind: WebEntryKind::Dir,
        }
    }

    fn file(name: &str, size: u64) -> WebEntry {
        WebEntry {
            name: name.to_string(),
            kind: WebEntryKind::File { size },
        }
    }

    #[test]
    fn web_mount_lists_lazily_and_reads_files_on_demand() {
        let provider = Rc::new(FakeProvider {
            listings: BTreeMap::from([
                (
                    "".to_string(),
                    vec![dir("obelisk"), file("README.md", 5)],
                ),
                ("obelisk".to_string(), vec![file("deployment.toml", 3)]),
            ]),
            files: BTreeMap::from([
                ("README.md".to_string(), b"hello".to_vec()),
                ("obelisk/deployment.toml".to_string(), b"abc".to_vec()),
            ]),
            lists: RefCell::new(Vec::new()),
            reads: RefCell::new(Vec::new()),
        });
        let mut fs = Vfs::new();
        fs.register_web_mount("/workspace/components", "", provider.clone());

        // The mount root shows up under its parent without any fetch.
        assert!(fs.is_dir("/workspace/components"));
        assert_eq!(
            fs.readdir("/workspace"),
            Some(vec!["components".to_string()])
        );
        assert!(provider.lists.borrow().is_empty());

        // Listing the root expands it once; the subdir stays unexpanded.
        assert_eq!(
            fs.readdir("/workspace/components"),
            Some(vec!["README.md".to_string(), "obelisk".to_string()])
        );
        assert_eq!(&*provider.lists.borrow(), &["".to_string()]);
        assert!(fs.is_dir("/workspace/components/obelisk"));
        assert!(fs.is_file("/workspace/components/README.md"));

        // Descending fetches the child listing; re-listing the root is cached.
        assert_eq!(
            fs.readdir("/workspace/components/obelisk"),
            Some(vec!["deployment.toml".to_string()])
        );
        fs.readdir("/workspace/components");
        assert_eq!(
            &*provider.lists.borrow(),
            &["".to_string(), "obelisk".to_string()]
        );

        // File bytes fetch once on read, then serve from cache.
        assert_eq!(
            fs.read_file("/workspace/components/obelisk/deployment.toml")
                .as_deref(),
            Some(&b"abc"[..])
        );
        assert_eq!(
            fs.read_file("/workspace/components/obelisk/deployment.toml")
                .as_deref(),
            Some(&b"abc"[..])
        );
        assert_eq!(&*provider.reads.borrow(), &["obelisk/deployment.toml"]);
    }

    #[test]
    fn web_file_edit_shadows_the_remote_copy() {
        let provider = Rc::new(FakeProvider {
            listings: BTreeMap::from([("".to_string(), vec![file("notes.md", 6)])]),
            files: BTreeMap::from([("notes.md".to_string(), b"remote".to_vec())]),
            lists: RefCell::new(Vec::new()),
            reads: RefCell::new(Vec::new()),
        });
        let mut fs = Vfs::new();
        fs.register_web_mount("/workspace/docs", "", provider.clone());
        fs.readdir("/workspace/docs");
        fs.write_file("/workspace/docs/notes.md", b"local").unwrap();
        assert_eq!(
            fs.read_file("/workspace/docs/notes.md").as_deref(),
            Some(&b"local"[..])
        );
        assert!(provider.reads.borrow().is_empty(), "a local edit wins with no fetch");
    }

    #[test]
    fn oversized_web_file_reports_size_without_fetching() {
        let provider = Rc::new(FakeProvider {
            listings: BTreeMap::from([(
                "".to_string(),
                vec![file("big.bin", MAX_LAZY_FETCH_BYTES + 1)],
            )]),
            files: BTreeMap::new(),
            lists: RefCell::new(Vec::new()),
            reads: RefCell::new(Vec::new()),
        });
        let mut fs = Vfs::new();
        fs.register_web_mount("/workspace/components", "", provider.clone());
        fs.readdir("/workspace/components");
        assert_eq!(
            fs.file_size("/workspace/components/big.bin"),
            Some(MAX_LAZY_FETCH_BYTES + 1)
        );
        assert!(matches!(
            fs.read_file_checked("/workspace/components/big.bin"),
            Err(FileReadError::TooLarge { .. })
        ));
        assert!(provider.reads.borrow().is_empty());
    }
}
