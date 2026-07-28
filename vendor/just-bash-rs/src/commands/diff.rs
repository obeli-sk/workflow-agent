//! PORT (simplified): vendor/just-bash/src/commands/diff/diff.ts
//!
//! `diff [-u] [-q] [-s] [-i] FILE1 FILE2`. Upstream delegates the actual
//! hunk computation to the `diff` npm package; this port hand-rolls a
//! classic O(n*m) LCS diff (fine for the line counts an agent shell's
//! files realistically have) and emits GNU-diff-style unified hunks with
//! 3 lines of context. Not ported: `--unified`'s context-count argument
//! (context is always 3), and any of the non-unified output styles
//! (upstream doesn't expose them either, `-u` is accepted but is already
//! the default).

use super::{fail, normalize_path, ok, unknown_option};
use crate::interpreter::{CommandOutput, Interpreter};

fn read_operand(interp: &Interpreter, file: &str, stdin: &str) -> Option<String> {
    if file == "-" {
        return Some(stdin.to_string());
    }
    let path = normalize_path(&interp.cwd, file);
    interp
        .fs
        .read_file(&path)
        .map(|b| String::from_utf8_lossy(b).into_owned())
}

/// Classic LCS table over lines, used to build the shortest edit script.
fn lcs_table(a: &[&str], b: &[&str]) -> Vec<Vec<u32>> {
    let (n, m) = (a.len(), b.len());
    let mut table = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[i][j] = if a[i] == b[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }
    table
}

#[derive(Clone, Copy, PartialEq)]
enum EditKind {
    Equal,
    Delete,
    Insert,
}

struct Edit {
    kind: EditKind,
    line: usize, // index into a (Equal/Delete) or b (Insert)
}

fn diff_lines(a: &[&str], b: &[&str]) -> Vec<Edit> {
    let table = lcs_table(a, b);
    let mut edits = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            edits.push(Edit {
                kind: EditKind::Equal,
                line: i,
            });
            i += 1;
            j += 1;
        } else if table[i + 1][j] >= table[i][j + 1] {
            edits.push(Edit {
                kind: EditKind::Delete,
                line: i,
            });
            i += 1;
        } else {
            edits.push(Edit {
                kind: EditKind::Insert,
                line: j,
            });
            j += 1;
        }
    }
    while i < a.len() {
        edits.push(Edit {
            kind: EditKind::Delete,
            line: i,
        });
        i += 1;
    }
    while j < b.len() {
        edits.push(Edit {
            kind: EditKind::Insert,
            line: j,
        });
        j += 1;
    }
    edits
}

/// Split into hunks: runs of edits separated by more than 2*context equal lines.
fn build_unified_diff(f1: &str, f2: &str, c1: &str, c2: &str) -> String {
    let a: Vec<&str> = split_keep_lines(c1);
    let b: Vec<&str> = split_keep_lines(c2);
    let edits = diff_lines(&a, &b);
    const CONTEXT: usize = 3;

    // Group edits into change runs with context, matching GNU diff's hunking.
    let mut hunks: Vec<Vec<usize>> = Vec::new(); // indices into `edits`
    let mut i = 0;
    while i < edits.len() {
        if edits[i].kind == EditKind::Equal {
            i += 1;
            continue;
        }
        // Found a change; walk backward up to CONTEXT equal lines for the start.
        let mut start = i;
        let mut back = 0;
        while start > 0 && edits[start - 1].kind == EditKind::Equal && back < CONTEXT {
            start -= 1;
            back += 1;
        }
        // Walk forward, absorbing changes separated by <= 2*CONTEXT equal lines.
        let mut end = i;
        loop {
            // advance end past the current change run
            while end < edits.len() && edits[end].kind != EditKind::Equal {
                end += 1;
            }
            // count following equal lines
            let mut equal_run = 0;
            let mut probe = end;
            while probe < edits.len() && edits[probe].kind == EditKind::Equal {
                probe += 1;
                equal_run += 1;
            }
            if probe >= edits.len() || equal_run > 2 * CONTEXT {
                end += equal_run.min(CONTEXT);
                break;
            }
            end = probe;
        }
        hunks.push((start..end).collect());
        i = end;
    }

    if hunks.is_empty() {
        return String::new();
    }

    // Position in `a`/`b` immediately before edit index `idx`: count every
    // edit up to it that consumed a line from that side (Equal consumes
    // both, Delete only `a`, Insert only `b`).
    let old_pos_before = |idx: usize| {
        edits[..idx]
            .iter()
            .filter(|e| e.kind != EditKind::Insert)
            .count()
    };
    let new_pos_before = |idx: usize| {
        edits[..idx]
            .iter()
            .filter(|e| e.kind != EditKind::Delete)
            .count()
    };

    let mut out = format!("--- {f1}\n+++ {f2}\n");
    for hunk in hunks {
        let first = hunk[0];
        let old_start = old_pos_before(first);
        let new_start = new_pos_before(first);
        let mut old_count = 0;
        let mut new_count = 0;
        let mut body = String::new();
        for idx in &hunk {
            let e = &edits[*idx];
            match e.kind {
                EditKind::Equal => {
                    old_count += 1;
                    new_count += 1;
                    body.push_str(&format!(" {}\n", a[e.line]));
                }
                EditKind::Delete => {
                    old_count += 1;
                    body.push_str(&format!("-{}\n", a[e.line]));
                }
                EditKind::Insert => {
                    new_count += 1;
                    body.push_str(&format!("+{}\n", b[e.line]));
                }
            }
        }
        let old_header = if old_count == 0 {
            format!("{old_start}")
        } else {
            format!("{},{old_count}", old_start + 1)
        };
        let new_header = if new_count == 0 {
            format!("{new_start}")
        } else {
            format!("{},{new_count}", new_start + 1)
        };
        out.push_str(&format!("@@ -{old_header} +{new_header} @@\n"));
        out.push_str(&body);
    }
    out
}

/// Split into lines without a trailing empty element for a final newline
/// (matches upstream's trailing-newline handling for line-oriented diffing).
fn split_keep_lines(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = content.split('\n').collect();
    if content.ends_with('\n') {
        lines.pop();
    }
    lines
}

pub fn diff(interp: &Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let mut brief = false;
    let mut report_same = false;
    let mut ignore_case = false;
    let mut files: Vec<String> = Vec::new();

    for arg in args {
        match arg.as_str() {
            "-u" | "--unified" => {}
            "-q" | "--brief" => brief = true,
            "-s" | "--report-identical-files" => report_same = true,
            "-i" | "--ignore-case" => ignore_case = true,
            other if other.starts_with("--") && other != "--" => {
                return unknown_option("diff", other);
            }
            other if other.starts_with('-') && other.len() > 1 && other != "-" => {
                return unknown_option("diff", other);
            }
            other => files.push(other.to_string()),
        }
    }

    if files.len() < 2 {
        return fail("diff: missing operand\n".to_string(), 2);
    }
    let (f1, f2) = (&files[0], &files[1]);

    let Some(c1) = read_operand(interp, f1, &stdin) else {
        return fail(format!("diff: {f1}: No such file or directory\n"), 2);
    };
    let Some(c2) = read_operand(interp, f2, &stdin) else {
        return fail(format!("diff: {f2}: No such file or directory\n"), 2);
    };

    let (t1, t2) = if ignore_case {
        (c1.to_lowercase(), c2.to_lowercase())
    } else {
        (c1.clone(), c2.clone())
    };

    if t1 == t2 {
        return if report_same {
            ok(format!("Files {f1} and {f2} are identical\n"))
        } else {
            ok(String::new())
        };
    }

    if brief {
        return CommandOutput {
            stdout: format!("Files {f1} and {f2} differ\n"),
            stderr: String::new(),
            exit_code: 1,
        };
    }

    let output = build_unified_diff(f1, f2, &c1, &c2);
    CommandOutput {
        stdout: output,
        stderr: String::new(),
        exit_code: 1,
    }
}

#[cfg(test)]
mod tests {
    use crate::bash::Bash;
    use crate::types::{BashOptions, ExecOptions, ExecResult};

    fn fresh() -> Bash {
        Bash::new(BashOptions::default())
    }

    fn run(bash: &mut Bash, script: &str) -> ExecResult {
        bash.exec(script, ExecOptions::default())
    }

    fn with_files(pairs: &[(&str, &str)]) -> Bash {
        let mut bash = fresh();
        for (path, content) in pairs {
            bash.fs_mut().write_file(path, content.as_bytes()).unwrap();
        }
        bash
    }

    #[test]
    fn identical_files_are_silent() {
        let mut bash = with_files(&[
            ("/a.txt", "line1\nline2\nline3\n"),
            ("/b.txt", "line1\nline2\nline3\n"),
        ]);
        let r = run(&mut bash, "diff /a.txt /b.txt");
        assert_eq!(r.stdout, "");
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    fn different_files_show_unified_diff() {
        let mut bash = with_files(&[("/a.txt", "hello\n"), ("/b.txt", "world\n")]);
        let r = run(&mut bash, "diff /a.txt /b.txt");
        assert!(r.stdout.contains("---"));
        assert!(r.stdout.contains("+++"));
        assert!(r.stdout.contains("-hello"));
        assert!(r.stdout.contains("+world"));
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn brief_mode() {
        let mut bash = with_files(&[("/a.txt", "aaa\n"), ("/b.txt", "bbb\n")]);
        let r = run(&mut bash, "diff -q /a.txt /b.txt");
        assert_eq!(r.stdout, "Files /a.txt and /b.txt differ\n");
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn report_identical() {
        let mut bash = with_files(&[("/a.txt", "same\n"), ("/b.txt", "same\n")]);
        let r = run(&mut bash, "diff -s /a.txt /b.txt");
        assert_eq!(r.stdout, "Files /a.txt and /b.txt are identical\n");
    }

    #[test]
    fn ignore_case_flag() {
        let mut bash = with_files(&[("/a.txt", "Hello World\n"), ("/b.txt", "hello world\n")]);
        let r = run(&mut bash, "diff -i /a.txt /b.txt");
        assert_eq!(r.stdout, "");
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    fn context_around_changes() {
        let mut bash = with_files(&[("/a.txt", "1\n2\n3\n4\n5\n"), ("/b.txt", "1\n2\nX\n4\n5\n")]);
        let r = run(&mut bash, "diff /a.txt /b.txt");
        assert!(r.stdout.contains("@@"));
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn missing_file_errors() {
        let mut bash = with_files(&[("/exists.txt", "content\n")]);
        let r = run(&mut bash, "diff /missing.txt /exists.txt");
        assert_eq!(r.stderr, "diff: /missing.txt: No such file or directory\n");
        assert_eq!(r.exit_code, 2);
    }

    #[test]
    fn missing_operand_errors() {
        let mut bash = fresh();
        let r = run(&mut bash, "diff /a.txt");
        assert!(r.stderr.contains("missing operand"));
        assert_eq!(r.exit_code, 2);
    }

    #[test]
    fn stdin_as_first_file() {
        let mut bash = with_files(&[("/b.txt", "from file\n")]);
        let r = run(&mut bash, "echo \"from stdin\" | diff - /b.txt");
        assert!(r.stdout.contains("-from stdin"));
        assert!(r.stdout.contains("+from file"));
    }
}
