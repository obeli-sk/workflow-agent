//! PORT: vendor/just-bash/src/commands/sort/{sort,comparator,parser}.ts and
//! src/commands/uniq/uniq.ts
//!
//! `sort` supports `-r -n -u -f -c -k -t`; `-b` (ignore leading blanks),
//! `-h`/`-M`/`-V`/`-d` (human numeric, month, version, dictionary-order sort
//! modes), `-s` (stable), and `-o` (write to file) are not ported — the
//! agent shell's sort usage is whole-line or single-key numeric/lexical, and
//! those modes add a lot of string-shape parsing for comparatively rare
//! scripts. `uniq` supports `-c -d -u -i`.

use std::collections::HashSet;

use super::{fail, ok, read_concat};
use crate::interpreter::{CommandOutput, Interpreter};

struct KeySpec {
    start_field: usize,
    start_char: Option<usize>,
    end_field: Option<usize>,
    end_char: Option<usize>,
    numeric: bool,
    reverse: bool,
    ignore_case: bool,
}

fn parse_key_spec(spec: &str) -> Option<KeySpec> {
    // Split spec into the field/char portion and trailing modifier letters.
    let (main, modifiers) = split_key_modifiers(spec);
    let parts: Vec<&str> = main.split(',').collect();
    if parts.is_empty() || parts[0].is_empty() {
        return None;
    }
    let start_parts: Vec<&str> = parts[0].split('.').collect();
    let start_field: usize = start_parts[0].parse().ok().filter(|&n: &usize| n >= 1)?;
    let start_char = start_parts
        .get(1)
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n >= 1);

    let mut end_field = None;
    let mut end_char = None;
    let mut numeric = modifiers.contains('n');
    let mut reverse = modifiers.contains('r');
    let mut ignore_case = modifiers.contains('f');

    if parts.len() > 1 && !parts[1].is_empty() {
        let (end_main, end_mods) = split_key_modifiers(parts[1]);
        numeric |= end_mods.contains('n');
        reverse |= end_mods.contains('r');
        ignore_case |= end_mods.contains('f');
        let end_parts: Vec<&str> = end_main.split('.').collect();
        if !end_parts[0].is_empty() {
            end_field = end_parts[0].parse::<usize>().ok().filter(|&n| n >= 1);
            end_char = end_parts
                .get(1)
                .and_then(|s| s.parse::<usize>().ok())
                .filter(|&n| n >= 1);
        }
    }

    Some(KeySpec {
        start_field,
        start_char,
        end_field,
        end_char,
        numeric,
        reverse,
        ignore_case,
    })
}

/// Split off the trailing run of modifier letters (`b d f h M n r V`) from a
/// key-spec field, returning `(field_part, modifiers)`.
fn split_key_modifiers(s: &str) -> (&str, &str) {
    let cut = s
        .rfind(|c: char| !"bdfhMnrV".contains(c))
        .map(|i| i + 1)
        .unwrap_or(0);
    (&s[..cut], &s[cut..])
}

fn extract_key(line: &str, key: &KeySpec, delimiter: Option<&str>) -> String {
    let fields: Vec<&str> = match delimiter {
        Some(d) => line.split(d).collect(),
        None => line.split_whitespace().collect(),
    };
    let start_idx = key.start_field - 1;
    if start_idx >= fields.len() {
        return String::new();
    }
    if key.end_field.is_none() {
        let mut field = fields.get(start_idx).copied().unwrap_or("");
        if let Some(sc) = key.start_char {
            field = field.get(sc - 1..).unwrap_or("");
        }
        return field.to_string();
    }
    let end_idx = key
        .end_field
        .unwrap()
        .saturating_sub(1)
        .min(fields.len().saturating_sub(1));
    let sep = delimiter.unwrap_or(" ");
    let mut out = String::new();
    for (i, f) in fields.iter().enumerate().take(end_idx + 1).skip(start_idx) {
        let mut field = *f;
        if i == start_idx
            && let Some(sc) = key.start_char
        {
            field = field.get(sc - 1..).unwrap_or("");
        }
        if i == end_idx
            && let Some(ec) = key.end_char
        {
            let take_to = if i == start_idx
                && let Some(sc) = key.start_char
            {
                ec.saturating_sub(sc) + 1
            } else {
                ec
            };
            field = field.get(..take_to.min(field.len())).unwrap_or(field);
        }
        if i > start_idx {
            out.push_str(sep);
        }
        out.push_str(field);
    }
    out
}

fn compare_values(a: &str, b: &str, numeric: bool, ignore_case: bool) -> std::cmp::Ordering {
    let (a, b) = if ignore_case {
        (a.to_lowercase(), b.to_lowercase())
    } else {
        (a.to_string(), b.to_string())
    };
    if numeric {
        let na: f64 = a.trim().parse().unwrap_or(0.0);
        let nb: f64 = b.trim().parse().unwrap_or(0.0);
        na.partial_cmp(&nb).unwrap_or(std::cmp::Ordering::Equal)
    } else {
        a.cmp(&b)
    }
}

pub fn sort(interp: &Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let mut reverse = false;
    let mut numeric = false;
    let mut unique = false;
    let mut ignore_case = false;
    let mut check_only = false;
    let mut keys: Vec<KeySpec> = Vec::new();
    let mut delimiter: Option<String> = None;
    let mut files: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-r" || arg == "--reverse" {
            reverse = true;
        } else if arg == "-n" || arg == "--numeric-sort" {
            numeric = true;
        } else if arg == "-u" || arg == "--unique" {
            unique = true;
        } else if arg == "-f" || arg == "--ignore-case" {
            ignore_case = true;
        } else if arg == "-c" || arg == "--check" {
            check_only = true;
        } else if arg == "-t" || arg == "--field-separator" {
            i += 1;
            delimiter = args.get(i).cloned();
        } else if let Some(rest) = arg.strip_prefix("--field-separator=") {
            delimiter = Some(rest.to_string());
        } else if let Some(rest) = arg.strip_prefix("-t") {
            if !rest.is_empty() {
                delimiter = Some(rest.to_string());
            }
        } else if arg == "-k" || arg == "--key" {
            i += 1;
            if let Some(k) = args.get(i).and_then(|s| parse_key_spec(s)) {
                keys.push(k);
            }
        } else if let Some(rest) = arg.strip_prefix("--key=") {
            if let Some(k) = parse_key_spec(rest) {
                keys.push(k);
            }
        } else if let Some(rest) = arg.strip_prefix("-k") {
            if let Some(k) = parse_key_spec(rest) {
                keys.push(k);
            }
        } else if arg.starts_with("--") {
            return fail(format!("sort: unrecognized option '{arg}'\n"), 1);
        } else if arg.starts_with('-') && arg.len() > 1 {
            for c in arg[1..].chars() {
                match c {
                    'r' => reverse = true,
                    'n' => numeric = true,
                    'u' => unique = true,
                    'f' => ignore_case = true,
                    'c' => check_only = true,
                    _ => return fail(format!("sort: unrecognized option '{arg}'\n"), 1),
                }
            }
        } else {
            files.push(arg.clone());
        }
        i += 1;
    }

    let content = match read_concat(interp, &files, "sort", &stdin) {
        Ok(c) => c,
        Err(e) => return e,
    };
    let mut lines: Vec<&str> = content.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }

    let cmp = |a: &&str, b: &&str| -> std::cmp::Ordering {
        let ord = if keys.is_empty() {
            compare_values(a, b, numeric, ignore_case)
        } else {
            let mut ord = std::cmp::Ordering::Equal;
            for key in &keys {
                let va = extract_key(a, key, delimiter.as_deref());
                let vb = extract_key(b, key, delimiter.as_deref());
                let key_ord = compare_values(&va, &vb, key.numeric, key.ignore_case || ignore_case);
                if key_ord != std::cmp::Ordering::Equal {
                    ord = if key.reverse {
                        key_ord.reverse()
                    } else {
                        key_ord
                    };
                    break;
                }
            }
            ord
        };
        if ord == std::cmp::Ordering::Equal {
            a.cmp(b)
        } else {
            ord
        }
    };

    if check_only {
        let check_file = files.first().cloned().unwrap_or_else(|| "-".to_string());
        for i in 1..lines.len() {
            if cmp(&lines[i - 1], &lines[i]) == std::cmp::Ordering::Greater {
                return fail(
                    format!("sort: {check_file}:{}: disorder: {}\n", i + 1, lines[i]),
                    1,
                );
            }
        }
        return ok(String::new());
    }

    lines.sort_by(cmp);
    if reverse {
        lines.reverse();
    }

    if unique {
        let mut seen = HashSet::new();
        lines.retain(|line| {
            let key = if keys.is_empty() {
                if ignore_case {
                    line.to_lowercase()
                } else {
                    line.to_string()
                }
            } else {
                let v = extract_key(line, &keys[0], delimiter.as_deref());
                if keys[0].ignore_case || ignore_case {
                    v.to_lowercase()
                } else {
                    v
                }
            };
            seen.insert(key)
        });
    }

    let output = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };
    ok(output)
}

pub fn uniq(interp: &Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let mut count = false;
    let mut duplicates_only = false;
    let mut unique_only = false;
    let mut ignore_case = false;
    let mut files: Vec<String> = Vec::new();

    for arg in args {
        match arg.as_str() {
            "-c" | "--count" => count = true,
            "-d" | "--repeated" => duplicates_only = true,
            "-u" | "--unique" => unique_only = true,
            "-i" | "--ignore-case" => ignore_case = true,
            _ if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") => {
                for c in arg[1..].chars() {
                    match c {
                        'c' => count = true,
                        'd' => duplicates_only = true,
                        'u' => unique_only = true,
                        'i' => ignore_case = true,
                        _ => {}
                    }
                }
            }
            _ => files.push(arg.clone()),
        }
    }

    let content = match read_concat(interp, &files, "uniq", &stdin) {
        Ok(c) => c,
        Err(e) => return e,
    };

    let mut lines: Vec<&str> = content.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    if lines.is_empty() {
        return ok(String::new());
    }

    let eq = |a: &str, b: &str| -> bool {
        if ignore_case {
            a.to_lowercase() == b.to_lowercase()
        } else {
            a == b
        }
    };

    let mut groups: Vec<(&str, usize)> = Vec::new();
    let mut current = lines[0];
    let mut current_count = 1usize;
    for &line in &lines[1..] {
        if eq(line, current) {
            current_count += 1;
        } else {
            groups.push((current, current_count));
            current = line;
            current_count = 1;
        }
    }
    groups.push((current, current_count));

    let filtered: Vec<&(&str, usize)> = if duplicates_only {
        groups.iter().filter(|(_, c)| *c > 1).collect()
    } else if unique_only {
        groups.iter().filter(|(_, c)| *c == 1).collect()
    } else {
        groups.iter().collect()
    };

    let mut output = String::new();
    for (line, c) in filtered {
        if count {
            output.push_str(&format!("{:>4} {line}\n", c));
        } else {
            output.push_str(line);
            output.push('\n');
        }
    }
    ok(output)
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

    mod sort_tests {
        use super::*;

        #[test]
        fn sorts_lines_lexically() {
            let mut bash = fresh();
            bash.fs_mut()
                .write_file("/f", b"banana\napple\ncherry\n")
                .unwrap();
            let r = run(&mut bash, "sort /f");
            assert_eq!(r.stdout, "apple\nbanana\ncherry\n");
        }

        #[test]
        fn numeric_sort() {
            let mut bash = fresh();
            bash.fs_mut().write_file("/f", b"10\n2\n1\n").unwrap();
            let r = run(&mut bash, "sort -n /f");
            assert_eq!(r.stdout, "1\n2\n10\n");
        }

        #[test]
        fn reverse_sort() {
            let mut bash = fresh();
            bash.fs_mut().write_file("/f", b"a\nc\nb\n").unwrap();
            let r = run(&mut bash, "sort -r /f");
            assert_eq!(r.stdout, "c\nb\na\n");
        }

        #[test]
        fn unique_after_sort() {
            let mut bash = fresh();
            bash.fs_mut().write_file("/f", b"b\na\nb\nc\na\n").unwrap();
            let r = run(&mut bash, "sort -u /f");
            assert_eq!(r.stdout, "a\nb\nc\n");
        }

        #[test]
        fn key_sort_by_second_field() {
            let mut bash = fresh();
            bash.fs_mut().write_file("/f", b"b 2\na 1\nc 3\n").unwrap();
            let r = run(&mut bash, "sort -k2,2 /f");
            assert_eq!(r.stdout, "a 1\nb 2\nc 3\n");
        }

        #[test]
        fn reads_stdin() {
            let mut bash = fresh();
            let r = run(&mut bash, "printf 'b\\na\\n' | sort");
            assert_eq!(r.stdout, "a\nb\n");
        }

        #[test]
        fn check_mode_reports_disorder() {
            let mut bash = fresh();
            bash.fs_mut().write_file("/f", b"b\na\n").unwrap();
            let r = run(&mut bash, "sort -c /f");
            assert_eq!(r.exit_code, 1);
            assert!(r.stderr.contains("disorder"));
        }
    }

    mod uniq_tests {
        use super::*;

        #[test]
        fn removes_adjacent_duplicates() {
            let mut bash = fresh();
            bash.fs_mut()
                .write_file("/f", b"apple\napple\nbanana\nbanana\nbanana\ncherry\n")
                .unwrap();
            let r = run(&mut bash, "uniq /f");
            assert_eq!(r.stdout, "apple\nbanana\ncherry\n");
        }

        #[test]
        fn count_flag() {
            let mut bash = fresh();
            bash.fs_mut()
                .write_file("/f", b"apple\napple\nbanana\nbanana\nbanana\ncherry\n")
                .unwrap();
            let r = run(&mut bash, "uniq -c /f");
            assert_eq!(r.stdout, "   2 apple\n   3 banana\n   1 cherry\n");
        }

        #[test]
        fn duplicates_only_and_unique_only() {
            let mut bash = fresh();
            bash.fs_mut()
                .write_file("/f", b"apple\napple\nbanana\nbanana\nbanana\ncherry\n")
                .unwrap();
            assert_eq!(run(&mut bash, "uniq -d /f").stdout, "apple\nbanana\n");
            assert_eq!(run(&mut bash, "uniq -u /f").stdout, "cherry\n");
        }

        #[test]
        fn only_removes_adjacent() {
            let mut bash = fresh();
            bash.fs_mut().write_file("/f", b"a\nb\na\nc\nc\n").unwrap();
            let r = run(&mut bash, "uniq /f");
            assert_eq!(r.stdout, "a\nb\na\nc\n");
        }

        #[test]
        fn reads_stdin() {
            let mut bash = fresh();
            let r = run(&mut bash, "printf 'x\\nx\\ny\\n' | uniq");
            assert_eq!(r.stdout, "x\ny\n");
        }

        #[test]
        fn missing_file_error() {
            let mut bash = fresh();
            let r = run(&mut bash, "uniq /nonexistent.txt");
            assert_eq!(
                r.stderr,
                "uniq: /nonexistent.txt: No such file or directory\n"
            );
            assert_eq!(r.exit_code, 1);
        }
    }
}
