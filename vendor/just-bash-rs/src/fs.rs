//! PORT: vendor/just-bash/src/fs/ (in-memory-fs, read-write-fs, overlay-fs)
//!
//! The virtual filesystem that backs the session workspace. The workflow holds
//! one instance for the whole durable session and mounts the obelisk-control
//! pack into it. Upstream ships a full overlay/mountable stack with symlinks;
//! this port starts with the in-memory core the shell actually needs: files,
//! implied directories, a minimal absolute-path symlink (added for the phase-4
//! pack bridge, see `symlink` below), and the handful of operations
//! redirections and the file-aware builtins call.

use std::collections::{BTreeMap, BTreeSet};

/// An in-memory tree of text files keyed by absolute, normalized path.
///
/// Directories are tracked explicitly (including ancestors) so `readdir` can
/// list them even when empty. Paths passed in are expected to be absolute; they
/// are normalized defensively so `.`/`..` never escape the root.
#[derive(Debug, Clone, Default)]
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
        }
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
        let path = self.resolve(path);
        self.files.contains_key(&path) || self.dirs.contains(&path)
    }

    pub fn is_file(&self, path: &str) -> bool {
        self.files.contains_key(&self.resolve(path))
    }

    pub fn is_dir(&self, path: &str) -> bool {
        self.dirs.contains(&self.resolve(path))
    }

    pub fn read_file(&self, path: &str) -> Option<&[u8]> {
        self.files.get(&self.resolve(path)).map(Vec::as_slice)
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
        self.files.entry(path).or_default().extend_from_slice(data);
        Ok(())
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
        if !self.dirs.contains(&dir) {
            return None;
        }
        let mut names = BTreeSet::new();
        for entry in self.files.keys().chain(self.dirs.iter()) {
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
        if self.files.remove(&path).is_some() {
            self.executable.remove(&path);
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
            return Ok(());
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_read_roundtrip() {
        let mut fs = Vfs::new();
        fs.write_file("/a/b/file.txt", b"hello").unwrap();
        assert_eq!(fs.read_file("/a/b/file.txt"), Some(&b"hello"[..]));
        assert!(fs.is_dir("/a"));
        assert!(fs.is_dir("/a/b"));
        assert!(fs.is_file("/a/b/file.txt"));
    }

    #[test]
    fn append_creates_and_extends() {
        let mut fs = Vfs::new();
        fs.append_file("/log", b"one\n").unwrap();
        fs.append_file("/log", b"two\n").unwrap();
        assert_eq!(fs.read_file("/log"), Some(&b"one\ntwo\n"[..]));
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
            fs.read_file("/deployment/current/deployment.toml"),
            Some(&b"hi"[..])
        );
        assert_eq!(
            fs.readdir("/deployment/current"),
            Some(vec!["deployment.toml".to_string()])
        );
        fs.write_file("/deployment/current/new.txt", b"added")
            .unwrap();
        assert_eq!(fs.read_file("/deployment/abc/new.txt"), Some(&b"added"[..]));
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
        assert_eq!(fs.read_file("/deployment/abc/f"), Some(&b"old"[..]));
        assert!(!fs.is_symlink("/deployment/current"));

        fs.symlink("/deployment/def", "/deployment/current")
            .unwrap();
        assert_eq!(fs.read_file("/deployment/current/f"), Some(&b"new"[..]));
    }
}
