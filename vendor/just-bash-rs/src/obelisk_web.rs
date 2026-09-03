//! Lazily-mounted remote directory trees (a GitHub repo browsed over the
//! network), surfaced as ordinary VFS folders under `/workspace`.
//!
//! One deployed activity backs every mount (they all share the uniform
//! stateless-transport WIT signature `func(method: string, params-json:
//! string) -> result<string, string>`, shared with `obelisk_mcp`); which repo
//! a given mount browses is carried in `params-json`, not baked into the
//! activity, so a session can mount as many repos as its `APPS_JSON` registry
//! lists. Two methods back the mount:
//!
//!   * `list`  -> params `{ "owner", "repo", "ref", "path": "<remote path>" }`,
//!     result a JSON array of `{ "name", "type": "file"|"dir", "sha", "size" }`
//!     entries.
//!   * `read`  -> params `{ "owner", "repo", "ref", "path": "<remote path>" }`,
//!     result the file's raw text body.
//!
//! The activity performs the actual GitHub contents-API fetch (`activity/
//! github-contents.js`); this module only adapts it to the VFS `DirProvider`
//! seam so `ls` lists a directory on first access and `cat` fetches a file's
//! bytes on first read. See the plan in the repo README / design notes.
//!
//! `repo.git_ref` is a requested ref (usually a branch), which can move
//! mid-session. The first `list`/`read` call resolves it to a commit SHA via
//! the same transport's `resolve-ref` method and freezes that SHA in
//! `resolved` (shared with the caller, e.g. for the `mount` listing) for
//! every subsequent call, so the tree stays consistent for the rest of the
//! session without paying for a resolution the mount never uses.

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::{Value, json};

use crate::fs::{DirProvider, Vfs, WebEntry, WebEntryKind};
use crate::obelisk_pack::ObeliskHost;

/// Identifies the GitHub repo (and requested ref) a mount browses; sent as
/// fixed extra params alongside `path` on every `list`/`read` call, after
/// `git_ref` has been pinned to a commit SHA (see module docs).
#[derive(Clone)]
pub struct RepoRef {
    pub owner: String,
    pub repo: String,
    pub git_ref: String,
}

/// A web mount backed by a `(method, params-json)` transport activity. Owns its
/// own `ObeliskHost` (interior-mutable, since `DirProvider` is a `&self` seam),
/// like `obelisk_mcp`'s resource loader.
struct GithubMount {
    host: RefCell<Box<dyn ObeliskHost>>,
    ffqn: String,
    repo: RepoRef,
    /// The commit SHA `repo.git_ref` resolved to, filled in by the first
    /// `list`/`read` call. Shared with the caller so it can report whether
    /// (and to what) this mount has pinned, without forcing the resolution
    /// itself.
    resolved: Rc<RefCell<Option<String>>>,
}

impl DirProvider for GithubMount {
    fn list(&self, remote_path: &str) -> Result<Vec<WebEntry>, String> {
        // `list` returns a JSON array serialized as the activity's string result.
        let body = self.call("list", remote_path)?;
        let entries: Value =
            serde_json::from_str(&body).map_err(|e| format!("list did not return JSON: {e}"))?;
        entries
            .as_array()
            .ok_or_else(|| "list did not return a JSON array".to_string())?
            .iter()
            .map(parse_entry)
            .collect()
    }

    fn read(&self, remote_path: &str) -> Result<Vec<u8>, String> {
        // `read` returns the file's raw text as the activity's string result;
        // it is a plain body, not JSON, so it is used verbatim.
        Ok(self.call("read", remote_path)?.into_bytes())
    }
}

impl GithubMount {
    /// One transport call: hand `(method, {"owner", "repo", "ref", "path"})` to
    /// the activity and return the string it produced. The activity's ok arm
    /// is a `string`, so `call_json` returns it as JSON text (quoted); peeling
    /// that single layer yields the activity's own return value (a JSON array
    /// for `list`, a raw file body for `read`).
    fn call(&self, method: &str, remote_path: &str) -> Result<String, String> {
        let git_ref = self.pinned_ref()?;
        let params = json!({
            "owner": self.repo.owner,
            "repo": self.repo.repo,
            "ref": git_ref,
            "path": remote_path,
        })
        .to_string();
        let args = json!([method, params]).to_string();
        match self.host.borrow_mut().call_json(&self.ffqn, &args)? {
            Some(raw) => match serde_json::from_str::<Value>(&raw) {
                Ok(Value::String(body)) => Ok(body),
                Ok(other) => Ok(other.to_string()),
                Err(_) => Ok(raw),
            },
            None => Ok(String::new()),
        }
    }

    /// Resolve `repo.git_ref` to a commit SHA on first use, caching it in
    /// `resolved` so this mount stays frozen at that commit for the rest of
    /// the session.
    fn pinned_ref(&self) -> Result<String, String> {
        if let Some(sha) = self.resolved.borrow().clone() {
            return Ok(sha);
        }
        let params = json!({
            "owner": self.repo.owner,
            "repo": self.repo.repo,
            "ref": self.repo.git_ref,
        })
        .to_string();
        let args = json!(["resolve-ref", params]).to_string();
        let raw = self
            .host
            .borrow_mut()
            .call_json(&self.ffqn, &args)?
            .ok_or_else(|| {
                format!(
                    "commit lookup returned no value for {}/{}@{}",
                    self.repo.owner, self.repo.repo, self.repo.git_ref
                )
            })?;
        let sha = serde_json::from_str::<String>(&raw).map_err(|error| {
            format!(
                "could not decode commit for {}/{}@{}: {error}",
                self.repo.owner, self.repo.repo, self.repo.git_ref
            )
        })?;
        if sha.len() != 40 || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!(
                "could not resolve {}/{}@{} to a commit SHA",
                self.repo.owner, self.repo.repo, self.repo.git_ref
            ));
        }
        *self.resolved.borrow_mut() = Some(sha.clone());
        Ok(sha)
    }
}

fn parse_entry(entry: &Value) -> Result<WebEntry, String> {
    let name = entry
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty() && !name.contains('/'))
        .ok_or_else(|| "mount entry has no usable name".to_string())?;
    let kind = match entry.get("type").and_then(Value::as_str) {
        Some("dir") => WebEntryKind::Dir,
        Some("file") => WebEntryKind::File {
            digest: entry
                .get("sha")
                .and_then(Value::as_str)
                .filter(|sha| !sha.is_empty())
                .ok_or_else(|| format!("mount file {name} has no content digest"))?
                .to_string(),
            size: entry.get("size").and_then(Value::as_u64).unwrap_or(0),
        },
        other => return Err(format!("mount entry {name} has unknown type {other:?}")),
    };
    Ok(WebEntry {
        name: name.to_string(),
        kind,
    })
}

/// Mount the transport `ffqn` as a lazily-listed tree at `mount_dir`, browsing
/// `repo`. The whole remote repo is shown at its root (`base` is empty).
/// `repo.git_ref` is resolved to a commit SHA on first access and cached into
/// `resolved`, not at mount time, so registering a mount that the session
/// never touches makes no network call.
pub fn mount(
    fs: &mut Vfs,
    host: Box<dyn ObeliskHost>,
    ffqn: &str,
    mount_dir: &str,
    repo: RepoRef,
    resolved: Rc<RefCell<Option<String>>>,
) {
    let provider = Rc::new(GithubMount {
        host: RefCell::new(host),
        ffqn: ffqn.to_string(),
        repo,
        resolved,
    });
    fs.register_web_mount(mount_dir.trim_end_matches('/'), "", provider);
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    struct FakeHost {
        reads: BTreeMap<String, String>,
        calls: Rc<RefCell<Vec<(String, String)>>>,
    }

    impl ObeliskHost for FakeHost {
        fn call_json(&mut self, ffqn: &str, params_json: &str) -> Result<Option<String>, String> {
            self.calls
                .borrow_mut()
                .push((ffqn.to_string(), params_json.to_string()));
            self.reads
                .get(params_json)
                .cloned()
                .map(Some)
                .ok_or_else(|| format!("no fixture for {params_json}"))
        }
    }

    /// The activity ok arm is a JSON string, so `call_json` returns it quoted:
    /// double-encode the payload the mount will parse (matches `obelisk_mcp`).
    fn ok_arm(payload: Value) -> String {
        serde_json::to_string(&payload.to_string()).unwrap()
    }

    const RESOLVED_SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    fn test_repo() -> RepoRef {
        RepoRef {
            owner: "obeli-sk".to_string(),
            repo: "components".to_string(),
            git_ref: "main".to_string(),
        }
    }

    fn resolve_args() -> String {
        json!([
            "resolve-ref",
            json!({ "owner": "obeli-sk", "repo": "components", "ref": "main" }).to_string()
        ])
        .to_string()
    }

    fn args(method: &str, path: &str) -> String {
        json!([
            method,
            json!({ "owner": "obeli-sk", "repo": "components", "ref": RESOLVED_SHA, "path": path })
                .to_string()
        ])
        .to_string()
    }

    #[test]
    fn lists_and_reads_through_the_transport() {
        let ffqn = "obelisk-agent:mounts/apps.request";
        let calls = Rc::new(RefCell::new(Vec::new()));
        let host = FakeHost {
            reads: BTreeMap::from([
                (resolve_args(), serde_json::to_string(RESOLVED_SHA).unwrap()),
                (
                    args("list", ""),
                    ok_arm(json!([
                        {"name": "obelisk", "type": "dir"},
                        {"name": "README.md", "type": "file", "sha": "git:readme", "size": 5}
                    ])),
                ),
                // `read`'s ok arm is the raw file body (a plain string result),
                // so the fixture is a single JSON-encoded string, not double. The
                // body is deliberately not valid JSON to guard the regression
                // where the transport tried to re-parse it.
                (
                    args("read", "README.md"),
                    serde_json::to_string("# Components\nnot json {").unwrap(),
                ),
            ]),
            calls: calls.clone(),
        };
        let mut fs = Vfs::new();
        let resolved = Rc::new(RefCell::new(None));
        mount(
            &mut fs,
            Box::new(host),
            ffqn,
            "/workspace/components",
            test_repo(),
            resolved.clone(),
        );
        assert!(
            resolved.borrow().is_none(),
            "mounting itself must not resolve the ref"
        );
        assert!(calls.borrow().is_empty(), "mounting itself makes no call");

        assert_eq!(
            fs.readdir("/workspace/components"),
            Some(vec!["README.md".to_string(), "obelisk".to_string()])
        );
        assert_eq!(resolved.borrow().as_deref(), Some(RESOLVED_SHA));
        assert!(fs.is_dir("/workspace/components/obelisk"));
        assert_eq!(
            fs.read_file("/workspace/components/README.md").as_deref(),
            Some(&b"# Components\nnot json {"[..])
        );

        // The ref resolves exactly once, even across the list and the read.
        let resolve_calls = calls
            .borrow()
            .iter()
            .filter(|(_, params)| params.starts_with("[\"resolve-ref\""))
            .count();
        assert_eq!(resolve_calls, 1);
    }

    #[test]
    fn unknown_entry_type_is_rejected() {
        let entry = json!({"name": "weird", "type": "symlink"});
        assert!(parse_entry(&entry).unwrap_err().contains("unknown type"));
        let unnamed = json!({"type": "file"});
        assert!(
            parse_entry(&unnamed)
                .unwrap_err()
                .contains("no usable name")
        );
    }

    /// Like `FakeHost`, but panics on any `read` call instead of returning an
    /// error, so a wrongly-eager `cp -r` fails loudly instead of silently
    /// swallowing a failed fetch (`copy_tree` ignores `copy_file`'s result).
    struct PanicsOnReadHost {
        reads: BTreeMap<String, String>,
    }

    impl ObeliskHost for PanicsOnReadHost {
        fn call_json(&mut self, ffqn: &str, params_json: &str) -> Result<Option<String>, String> {
            let _ = ffqn;
            let method = serde_json::from_str::<Value>(params_json)
                .ok()
                .and_then(|v| v.as_array().and_then(|a| a.first().cloned()))
                .and_then(|v| v.as_str().map(str::to_string));
            assert_ne!(
                method.as_deref(),
                Some("read"),
                "cp -r must not fetch file content"
            );
            self.reads
                .get(params_json)
                .cloned()
                .map(Some)
                .ok_or_else(|| format!("no fixture for {params_json}"))
        }
    }

    #[test]
    fn recursive_cp_of_a_nested_mount_fetches_nothing() {
        let ffqn = "obelisk-agent:mounts/apps.request";
        let host = PanicsOnReadHost {
            reads: BTreeMap::from([
                (resolve_args(), serde_json::to_string(RESOLVED_SHA).unwrap()),
                (
                    args("list", ""),
                    ok_arm(json!([
                        {"name": "sub", "type": "dir"},
                        {"name": "README.md", "type": "file", "sha": "git:readme", "size": 5}
                    ])),
                ),
                (
                    args("list", "sub"),
                    ok_arm(json!([
                        {"name": "a.txt", "type": "file", "sha": "git:a", "size": 3}
                    ])),
                ),
            ]),
        };
        let mut bash = crate::bash::Bash::new(crate::types::BashOptions::default());
        mount(
            bash.fs_mut(),
            Box::new(host),
            ffqn,
            "/workspace/components",
            test_repo(),
            Rc::new(RefCell::new(None)),
        );

        let r = bash.exec(
            "cp -r /workspace/components /workspace/dest",
            crate::types::ExecOptions::default(),
        );
        assert_eq!(r.exit_code, 0, "stderr: {}", r.stderr);
        assert!(bash.fs().is_pending("/workspace/dest/README.md"));
        assert!(bash.fs().is_pending("/workspace/dest/sub/a.txt"));
    }
}
