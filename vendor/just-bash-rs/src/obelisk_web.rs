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
//!     result a JSON array of `{ "name", "type": "file"|"dir", "size" }`
//!     entries.
//!   * `read`  -> params `{ "owner", "repo", "ref", "path": "<remote path>" }`,
//!     result the file's raw text body.
//!
//! The activity performs the actual GitHub contents-API fetch (`activity/
//! github-contents.js`); this module only adapts it to the VFS `DirProvider`
//! seam so `ls` lists a directory on first access and `cat` fetches a file's
//! bytes on first read. See the plan in the repo README / design notes.

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::{Value, json};

use crate::fs::{DirProvider, Vfs, WebEntry, WebEntryKind};
use crate::obelisk_pack::ObeliskHost;

/// Identifies the GitHub repo (and ref) a mount browses; sent as fixed extra
/// params alongside `path` on every `list`/`read` call.
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
        let params = json!({
            "owner": self.repo.owner,
            "repo": self.repo.repo,
            "ref": self.repo.git_ref,
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
pub fn mount(fs: &mut Vfs, host: Box<dyn ObeliskHost>, ffqn: &str, mount_dir: &str, repo: RepoRef) {
    let provider = Rc::new(GithubMount {
        host: RefCell::new(host),
        ffqn: ffqn.to_string(),
        repo,
    });
    fs.register_web_mount(mount_dir.trim_end_matches('/'), "", provider);
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    struct FakeHost {
        reads: BTreeMap<String, String>,
        calls: RefCell<Vec<(String, String)>>,
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

    fn test_repo() -> RepoRef {
        RepoRef {
            owner: "obeli-sk".to_string(),
            repo: "components".to_string(),
            git_ref: "main".to_string(),
        }
    }

    fn args(method: &str, path: &str) -> String {
        json!([
            method,
            json!({ "owner": "obeli-sk", "repo": "components", "ref": "main", "path": path })
                .to_string()
        ])
        .to_string()
    }

    #[test]
    fn lists_and_reads_through_the_transport() {
        let ffqn = "obelisk-agent:mounts/apps.request";
        let host = FakeHost {
            reads: BTreeMap::from([
                (
                    args("list", ""),
                    ok_arm(json!([
                        {"name": "obelisk", "type": "dir"},
                        {"name": "README.md", "type": "file", "size": 5}
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
            calls: RefCell::new(Vec::new()),
        };
        let mut fs = Vfs::new();
        mount(
            &mut fs,
            Box::new(host),
            ffqn,
            "/workspace/components",
            test_repo(),
        );

        assert_eq!(
            fs.readdir("/workspace/components"),
            Some(vec!["README.md".to_string(), "obelisk".to_string()])
        );
        assert!(fs.is_dir("/workspace/components/obelisk"));
        assert_eq!(
            fs.read_file("/workspace/components/README.md").as_deref(),
            Some(&b"# Components\nnot json {"[..])
        );
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
}
