//! PORT (simplified): vendor/just-bash/src/commands/find/{find,matcher,parser}.ts
//!
//! `find [PATH...] [-name PAT] [-iname PAT] [-path PAT] [-ipath PAT]
//! [-type f|d] [-maxdepth N] [-mindepth N] [-empty] [!]/[-not] [-print]
//! [-print0]`. Predicates implicitly AND together (in traversal preorder,
//! parent before sorted children, matching upstream's default output order).
//! Scope, per the design doc's usage-driven call: this covers the
//! name/type/path-matching subset an agent shell plausibly needs. Not
//! ported: `-o`/`-or` and parenthesized grouping (only implicit AND plus a
//! leading `!`/`-not` per predicate), `-exec` (arbitrary command
//! execution with its own quoting rules), `-printf`, `-delete`, and the
//! metadata predicates `-mtime`/`-newer`/`-size`/`-perm` (this port's `Vfs`
//! tracks file content and directory structure only, no mtime/mode/size
//! metadata to test against).

use super::{fail, normalize_path, ok};
use crate::glob::match_segment;
use crate::interpreter::{CommandOutput, Interpreter};

enum Predicate {
    Name(String, bool),
    Path(String, bool),
    Type(char),
    Empty,
}

struct FindOpts {
    maxdepth: usize,
    mindepth: usize,
    print0: bool,
    predicates: Vec<(bool, Predicate)>,
}

const HELP: &str = "\
find: search for files in a directory hierarchy
usage: find [path...] [expression]
  -name PATTERN    file name matches shell pattern PATTERN
  -iname PATTERN   like -name but case insensitive
  -path PATTERN    file path matches shell pattern PATTERN
  -ipath PATTERN   like -path but case insensitive
  -type f|d        file is a regular file or a directory
  -maxdepth N      descend at most N levels
  -mindepth N      do not apply tests at levels less than N
  -empty           file is empty or directory is empty
  -print, -print0  print the file name (print0: NUL-separated)
";

fn parse_find_args(args: &[String]) -> Result<(Vec<String>, FindOpts), CommandOutput> {
    let mut paths = Vec::new();
    let mut opts = FindOpts {
        maxdepth: usize::MAX,
        mindepth: 0,
        print0: false,
        predicates: Vec::new(),
    };
    let mut i = 0;
    let mut negate_next = false;
    let mut seen_predicate = false;
    while i < args.len() {
        let arg = &args[i];
        if !seen_predicate && !arg.starts_with('-') && arg != "!" {
            paths.push(arg.clone());
            i += 1;
            continue;
        }
        seen_predicate = true;
        match arg.as_str() {
            "!" | "-not" => {
                negate_next = true;
                i += 1;
            }
            "-print" => {
                i += 1;
            }
            "-print0" => {
                opts.print0 = true;
                i += 1;
            }
            "-maxdepth" => {
                i += 1;
                opts.maxdepth = args
                    .get(i)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(usize::MAX);
                i += 1;
            }
            "-mindepth" => {
                i += 1;
                opts.mindepth = args.get(i).and_then(|s| s.parse().ok()).unwrap_or(0);
                i += 1;
            }
            "-name" => {
                i += 1;
                let pat = args.get(i).cloned().unwrap_or_default();
                opts.predicates
                    .push((negate_next, Predicate::Name(pat, false)));
                negate_next = false;
                i += 1;
            }
            "-iname" => {
                i += 1;
                let pat = args.get(i).cloned().unwrap_or_default();
                opts.predicates
                    .push((negate_next, Predicate::Name(pat, true)));
                negate_next = false;
                i += 1;
            }
            "-path" => {
                i += 1;
                let pat = args.get(i).cloned().unwrap_or_default();
                opts.predicates
                    .push((negate_next, Predicate::Path(pat, false)));
                negate_next = false;
                i += 1;
            }
            "-ipath" => {
                i += 1;
                let pat = args.get(i).cloned().unwrap_or_default();
                opts.predicates
                    .push((negate_next, Predicate::Path(pat, true)));
                negate_next = false;
                i += 1;
            }
            "-type" => {
                i += 1;
                let t = args.get(i).cloned().unwrap_or_default();
                if t != "f" && t != "d" {
                    return Err(fail(format!("find: Unknown argument to -type: {t}\n"), 1));
                }
                opts.predicates
                    .push((negate_next, Predicate::Type(t.chars().next().unwrap())));
                negate_next = false;
                i += 1;
            }
            "-empty" => {
                opts.predicates.push((negate_next, Predicate::Empty));
                negate_next = false;
                i += 1;
            }
            other => return Err(fail(format!("find: unknown predicate '{other}'\n"), 1)),
        }
    }
    if paths.is_empty() {
        paths.push(".".to_string());
    }
    Ok((paths, opts))
}

fn predicate_matches(
    interp: &Interpreter,
    opts: &FindOpts,
    name: &str,
    display: &str,
    abs: &str,
    is_dir: bool,
    is_file: bool,
) -> bool {
    opts.predicates.iter().all(|(negate, pred)| {
        let result = match pred {
            Predicate::Name(pat, ic) => {
                if *ic {
                    match_segment(&pat.to_lowercase(), &name.to_lowercase())
                } else {
                    match_segment(pat, name)
                }
            }
            Predicate::Path(pat, ic) => {
                if *ic {
                    match_segment(&pat.to_lowercase(), &display.to_lowercase())
                } else {
                    match_segment(pat, display)
                }
            }
            Predicate::Type(t) => match t {
                'f' => is_file,
                'd' => is_dir,
                _ => false,
            },
            Predicate::Empty => {
                if is_dir {
                    interp
                        .fs
                        .readdir(abs)
                        .map(|e| e.is_empty())
                        .unwrap_or(false)
                } else {
                    interp
                        .fs
                        .read_file(abs)
                        .map(|b| b.is_empty())
                        .unwrap_or(false)
                }
            }
        };
        result != *negate
    })
}

#[allow(clippy::too_many_arguments)]
fn walk(
    interp: &Interpreter,
    display: &str,
    abs: &str,
    depth: usize,
    opts: &FindOpts,
    out: &mut Vec<String>,
) {
    let is_dir = interp.fs.is_dir(abs);
    let is_file = interp.fs.is_file(abs);
    let name = abs.rsplit('/').next().unwrap_or(abs);
    if depth >= opts.mindepth
        && predicate_matches(interp, opts, name, display, abs, is_dir, is_file)
    {
        out.push(display.to_string());
    }
    if is_dir
        && depth < opts.maxdepth
        && let Some(entries) = interp.fs.readdir(abs)
    {
        for entry in entries {
            let child_display = if display.ends_with('/') {
                format!("{display}{entry}")
            } else {
                format!("{display}/{entry}")
            };
            let child_abs = format!("{}/{entry}", abs.trim_end_matches('/'));
            walk(interp, &child_display, &child_abs, depth + 1, opts, out);
        }
    }
}

pub fn find(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    if args.iter().any(|a| a == "--help") {
        return ok(HELP.to_string());
    }
    let (paths, opts) = match parse_find_args(args) {
        Ok(v) => v,
        Err(e) => return e,
    };

    let mut out_paths: Vec<String> = Vec::new();
    let mut stderr = String::new();
    let mut had_error = false;
    for raw_path in &paths {
        let abs = normalize_path(&interp.cwd, raw_path);
        if !interp.fs.exists(&abs) {
            stderr.push_str(&format!("find: {raw_path}: No such file or directory\n"));
            had_error = true;
            continue;
        }
        let trimmed = raw_path.trim_end_matches('/');
        let display_root = if trimmed.is_empty() {
            "/".to_string()
        } else {
            trimmed.to_string()
        };
        walk(interp, &display_root, &abs, 0, &opts, &mut out_paths);
    }

    let sep = if opts.print0 { '\0' } else { '\n' };
    let mut stdout = String::new();
    for p in &out_paths {
        stdout.push_str(p);
        stdout.push(sep);
    }
    CommandOutput {
        stdout,
        stderr,
        exit_code: if had_error { 1 } else { 0 },
    }
}

#[cfg(test)]
mod tests {
    use crate::bash::Bash;
    use crate::types::{BashOptions, ExecOptions, ExecResult};

    fn fresh() -> Bash {
        Bash::new(BashOptions {
            cwd: "/project".into(),
            ..Default::default()
        })
    }

    fn run(bash: &mut Bash, script: &str) -> ExecResult {
        bash.exec(script, ExecOptions::default())
    }

    fn project_env() -> Bash {
        let mut bash = fresh();
        for (path, content) in [
            ("/project/README.md", "# Project"),
            ("/project/src/index.ts", "export {}"),
            (
                "/project/src/utils/helpers.ts",
                "export function helper() {}",
            ),
            (
                "/project/src/utils/format.ts",
                "export function format() {}",
            ),
            ("/project/tests/index.test.ts", "test"),
            ("/project/package.json", "{}"),
            ("/project/tsconfig.json", "{}"),
        ] {
            bash.fs_mut().write_file(path, content.as_bytes()).unwrap();
        }
        bash
    }

    #[test]
    fn finds_all_files_and_directories() {
        let mut bash = project_env();
        let r = run(&mut bash, "find /project");
        assert_eq!(
            r.stdout,
            "/project\n\
             /project/README.md\n\
             /project/package.json\n\
             /project/src\n\
             /project/src/index.ts\n\
             /project/src/utils\n\
             /project/src/utils/format.ts\n\
             /project/src/utils/helpers.ts\n\
             /project/tests\n\
             /project/tests/index.test.ts\n\
             /project/tsconfig.json\n"
        );
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    fn name_pattern() {
        let mut bash = project_env();
        let r = run(&mut bash, r#"find /project -name "*.ts""#);
        assert_eq!(
            r.stdout,
            "/project/src/index.ts\n/project/src/utils/format.ts\n/project/src/utils/helpers.ts\n/project/tests/index.test.ts\n"
        );
    }

    #[test]
    fn type_f_and_d() {
        let mut bash = project_env();
        let r = run(&mut bash, "find /project -type d");
        assert_eq!(
            r.stdout,
            "/project\n/project/src\n/project/src/utils\n/project/tests\n"
        );
    }

    #[test]
    fn combine_name_and_type() {
        let mut bash = project_env();
        let r = run(&mut bash, r#"find /project -name "*.ts" -type f"#);
        assert_eq!(
            r.stdout,
            "/project/src/index.ts\n/project/src/utils/format.ts\n/project/src/utils/helpers.ts\n/project/tests/index.test.ts\n"
        );
    }

    #[test]
    fn dot_relative_search() {
        let mut bash = project_env();
        let r = run(&mut bash, r#"find . -name "*.md""#);
        assert_eq!(r.stdout, "./README.md\n");
    }

    #[test]
    fn question_wildcard() {
        let mut bash = project_env();
        let r = run(&mut bash, r#"find /project -name "???*.json""#);
        assert_eq!(r.stdout, "/project/package.json\n/project/tsconfig.json\n");
    }

    #[test]
    fn nonexistent_path_errors() {
        let mut bash = project_env();
        let r = run(&mut bash, "find /nonexistent");
        assert_eq!(r.stdout, "");
        assert_eq!(r.stderr, "find: /nonexistent: No such file or directory\n");
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn unknown_predicate_errors() {
        let mut bash = project_env();
        let r = run(&mut bash, "find /project -unknown");
        assert!(r.stderr.contains("find: unknown predicate '-unknown'"));
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn invalid_type_argument_errors() {
        let mut bash = project_env();
        let r = run(&mut bash, "find /project -type x");
        assert!(r.stderr.contains("Unknown argument to -type"));
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn multiple_search_paths() {
        let mut bash = Bash::new(BashOptions::default());
        bash.fs_mut().write_file("/dir1/a.txt", b"a").unwrap();
        bash.fs_mut().write_file("/dir2/b.txt", b"b").unwrap();
        let r = run(&mut bash, r#"find /dir1 /dir2 -name "*.txt""#);
        assert_eq!(r.stdout, "/dir1/a.txt\n/dir2/b.txt\n");
    }

    #[test]
    fn preserves_full_paths_when_searching_from_root_with_dot() {
        let mut bash = Bash::new(BashOptions {
            cwd: "/".into(),
            ..Default::default()
        });
        bash.fs_mut()
            .write_file("/abc/file.txt", b"content")
            .unwrap();
        let r = run(&mut bash, r#"find . -name "file.txt""#);
        assert_eq!(r.stdout, "./abc/file.txt\n");
    }

    #[test]
    fn normalizes_trailing_slash_in_search_path() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/project/src/index.ts", b"content")
            .unwrap();
        let r = run(&mut bash, r#"find /project/ -name "*.ts""#);
        assert_eq!(r.stdout, "/project/src/index.ts\n");
    }
}
