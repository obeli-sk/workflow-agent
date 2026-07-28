//! PORT (simplified): vendor/just-bash/src/shell/glob.ts,
//! vendor/just-bash/src/shell/glob-to-regex.ts
//!
//! Pathname expansion against the in-memory `Vfs`. Upstream's glob engine
//! backs extglob, brace expansion, and array/associative-array key matching;
//! this port only needs plain bash globbing (`*`, `?`, `[...]`) for unquoted
//! words, so it is a small hand-rolled matcher over `Vfs::readdir`, not a
//! filesystem-based crate (there is no real filesystem to match against) and
//! not a full port of the upstream engine.
//!
//! `*`/`?` never match a leading dot in a filename unless the pattern segment
//! itself starts with a dot (bash's default, dotglob off). Multi-component
//! patterns (`sub/*.txt`) walk one path segment at a time. No match leaves the
//! word untouched (nullglob off, matching bash's default and the design doc).

use crate::commands::normalize_path;
use crate::fs::Vfs;

/// True if `s` contains a glob metacharacter that would make pathname
/// expansion apply.
pub fn has_meta(s: &str) -> bool {
    s.contains(['*', '?', '['])
}

/// Expand a glob pattern (relative to `cwd` unless it starts with `/`) against
/// `vfs`, returning matches sorted lexicographically. Empty if nothing
/// matches; callers keep the original literal word in that case.
pub fn expand(pattern: &str, cwd: &str, vfs: &Vfs) -> Vec<String> {
    let absolute = pattern.starts_with('/');
    let segments: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Vec::new();
    }
    let start_dir = if absolute {
        "/".to_string()
    } else {
        cwd.to_string()
    };
    let start_display = if absolute {
        "/".to_string()
    } else {
        String::new()
    };

    let mut paths: Vec<(String, String)> = vec![(start_dir, start_display)];
    for (i, seg) in segments.iter().enumerate() {
        let is_last = i == segments.len() - 1;
        let mut next: Vec<(String, String)> = Vec::new();
        for (dir, disp) in &paths {
            if has_meta(seg) {
                let Some(entries) = vfs.readdir(dir) else {
                    continue;
                };
                for entry in entries {
                    if entry.starts_with('.') && !seg.starts_with('.') {
                        continue;
                    }
                    if !match_segment(seg, &entry) {
                        continue;
                    }
                    let child_abs = normalize_path(dir, &entry);
                    let child_disp = join_display(disp, &entry);
                    if is_last || vfs.is_dir(&child_abs) {
                        next.push((child_abs, child_disp));
                    }
                }
            } else {
                let child_abs = normalize_path(dir, seg);
                let child_disp = join_display(disp, seg);
                if is_last {
                    if vfs.exists(&child_abs) {
                        next.push((child_abs, child_disp));
                    }
                } else if vfs.is_dir(&child_abs) {
                    next.push((child_abs, child_disp));
                }
            }
        }
        paths = next;
    }
    let mut out: Vec<String> = paths.into_iter().map(|(_, disp)| disp).collect();
    out.sort();
    out
}

fn join_display(prefix: &str, segment: &str) -> String {
    if prefix.is_empty() {
        segment.to_string()
    } else if prefix.ends_with('/') {
        format!("{prefix}{segment}")
    } else {
        format!("{prefix}/{segment}")
    }
}

/// Match one path segment (no `/`) against a glob pattern: `*` (any run,
/// including empty), `?` (exactly one char), `[abc]`/`[a-z]`/`[!...]`
/// character classes, and `\x` as a literal `x`. Also reused by `find`'s
/// `-name`/`-path` predicates (there, "segment" is really the whole
/// candidate string, since neither predicate treats `/` specially).
pub(crate) fn match_segment(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let n: Vec<char> = name.chars().collect();
    match_from(&p, 0, &n, 0)
}

fn match_from(p: &[char], pi: usize, n: &[char], ni: usize) -> bool {
    if pi == p.len() {
        return ni == n.len();
    }
    match p[pi] {
        '*' => {
            if match_from(p, pi + 1, n, ni) {
                return true;
            }
            ni < n.len() && match_from(p, pi, n, ni + 1)
        }
        '?' => ni < n.len() && match_from(p, pi + 1, n, ni + 1),
        '[' => match_class(p, pi, n, ni),
        '\\' if pi + 1 < p.len() => {
            ni < n.len() && n[ni] == p[pi + 1] && match_from(p, pi + 2, n, ni + 1)
        }
        c => ni < n.len() && n[ni] == c && match_from(p, pi + 1, n, ni + 1),
    }
}

fn match_class(p: &[char], pi: usize, n: &[char], ni: usize) -> bool {
    let mut j = pi + 1;
    let negate = matches!(p.get(j), Some('!') | Some('^'));
    if negate {
        j += 1;
    }
    let class_start = j;
    while j < p.len() && p[j] != ']' {
        j += 1;
    }
    if j >= p.len() {
        // No closing bracket: treat `[` as a literal character.
        return ni < n.len() && n[ni] == '[' && match_from(p, pi + 1, n, ni + 1);
    }
    if ni >= n.len() {
        return false;
    }
    let c = n[ni];
    let mut matched = false;
    let mut k = class_start;
    while k < j {
        if k + 2 < j && p[k + 1] == '-' {
            if c >= p[k] && c <= p[k + 2] {
                matched = true;
            }
            k += 3;
        } else {
            if p[k] == c {
                matched = true;
            }
            k += 1;
        }
    }
    if matched != negate {
        match_from(p, j + 1, n, ni + 1)
    } else {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vfs_with(files: &[&str]) -> Vfs {
        let mut vfs = Vfs::new();
        for f in files {
            vfs.write_file(f, b"").unwrap();
        }
        vfs
    }

    #[test]
    fn star_matches_sorted_files() {
        let vfs = vfs_with(&["/a.txt", "/b.txt", "/c.log"]);
        assert_eq!(expand("*.txt", "/", &vfs), vec!["a.txt", "b.txt"]);
    }

    #[test]
    fn question_matches_single_char() {
        let vfs = vfs_with(&["/a.txt", "/ab.txt"]);
        assert_eq!(expand("?.txt", "/", &vfs), vec!["a.txt"]);
    }

    #[test]
    fn bracket_class_and_negation() {
        let vfs = vfs_with(&["/a.txt", "/b.txt", "/c.txt"]);
        assert_eq!(expand("[ab].txt", "/", &vfs), vec!["a.txt", "b.txt"]);
        assert_eq!(expand("[!ab].txt", "/", &vfs), vec!["c.txt"]);
    }

    #[test]
    fn dotfiles_excluded_unless_pattern_has_leading_dot() {
        let vfs = vfs_with(&["/.hidden", "/visible"]);
        assert_eq!(expand("*", "/", &vfs), vec!["visible"]);
        assert_eq!(expand(".*", "/", &vfs), vec![".hidden"]);
    }

    #[test]
    fn no_match_returns_empty() {
        let vfs = vfs_with(&["/a.txt"]);
        assert!(expand("*.log", "/", &vfs).is_empty());
    }

    #[test]
    fn multi_segment_pattern_walks_directories() {
        let vfs = vfs_with(&["/sub/a.txt", "/sub/b.log", "/other/c.txt"]);
        assert_eq!(expand("sub/*.txt", "/", &vfs), vec!["sub/a.txt"]);
        assert_eq!(
            expand("*/*.txt", "/", &vfs),
            vec!["other/c.txt", "sub/a.txt"]
        );
    }
}
