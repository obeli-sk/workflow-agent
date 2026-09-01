//! PORT: vendor/just-bash/src/commands/grep/grep.ts (+ search-engine/regex.ts)
//!
//! `grep [-E|-F] [-i] [-v] [-n] [-c] [-l|-L] [-o] [-w] [-x] [-r|-R] [-q]
//! [-h] [-m N] [-A/-B/-C N] [-e PATTERN] PATTERN [FILE...]`.
//!
//! Regex flavor: default mode does a light BRE->ERE translation
//! (`translate_bre`) so `\(`/`\)`/`\{`/`\}`/`\+`/`\?`/`\|` behave as GNU basic
//! regex expects and bare `^`/`$`/`*` are literal outside their special
//! positions; `-E`/`-P` pass the pattern straight to the `regex` crate (which
//! is already ERE-like), so `-P` is simplified to `-E` — genuinely
//! Perl-only features (lookaround, backreferences, non-greedy quantifiers)
//! are out of scope, matching the design doc's note to skip the perl test
//! suite. `-F` fixed-strings escapes the pattern. Not ported: `--include` /
//! `--exclude` / `--exclude-dir`, GNU `[[:<:]]`/`[[:>:]]` word-boundary
//! classes, and BRE backreferences (`\1`) — the `regex` crate has no
//! backreference support.

use regex::{Regex, RegexBuilder};

use super::{fail, normalize_path, ok};
use crate::interpreter::{CommandOutput, Interpreter};

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Basic,
    Extended,
    Fixed,
}

struct Opts {
    ignore_case: bool,
    invert: bool,
    show_line_numbers: bool,
    count_only: bool,
    files_with_matches: bool,
    files_without_match: bool,
    recursive: bool,
    whole_word: bool,
    line_regexp: bool,
    only_matching: bool,
    no_filename: bool,
    quiet: bool,
    max_count: usize,
    before: usize,
    after: usize,
}

pub fn grep(
    interp: &mut Interpreter,
    args: &[String],
    stdin: String,
    force_extended: bool,
) -> CommandOutput {
    run(
        interp,
        args,
        stdin,
        if force_extended {
            Some(Mode::Extended)
        } else {
            None
        },
    )
}

pub fn fgrep(interp: &mut Interpreter, args: &[String], stdin: String) -> CommandOutput {
    run(interp, args, stdin, Some(Mode::Fixed))
}

fn run(
    interp: &mut Interpreter,
    args: &[String],
    stdin: String,
    forced_mode: Option<Mode>,
) -> CommandOutput {
    let mut mode = forced_mode.unwrap_or(Mode::Basic);
    let mut opts = Opts {
        ignore_case: false,
        invert: false,
        show_line_numbers: false,
        count_only: false,
        files_with_matches: false,
        files_without_match: false,
        recursive: false,
        whole_word: false,
        line_regexp: false,
        only_matching: false,
        no_filename: false,
        quiet: false,
        max_count: 0,
        before: 0,
        after: 0,
    };
    let mut patterns: Vec<String> = Vec::new();
    let mut explicit_pattern_source = false;
    let mut files: Vec<String> = Vec::new();
    let mut parse_options = true;
    let mut had_stdin_read = false;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if parse_options && arg == "--" {
            parse_options = false;
            i += 1;
            continue;
        }
        if parse_options && arg.starts_with('-') && arg != "-" {
            if arg == "-e" && i + 1 < args.len() {
                i += 1;
                patterns.extend(args[i].split('\n').map(str::to_string));
                explicit_pattern_source = true;
                i += 1;
                continue;
            }
            if arg == "-f" && i + 1 < args.len() {
                i += 1;
                match read_pattern_file(interp, &args[i], &stdin, &mut had_stdin_read) {
                    Ok(lines) => patterns.extend(lines),
                    Err(err) => return err,
                }
                explicit_pattern_source = true;
                i += 1;
                continue;
            }
            if let Some(file) = arg.strip_prefix("--file=") {
                match read_pattern_file(interp, file, &stdin, &mut had_stdin_read) {
                    Ok(lines) => patterns.extend(lines),
                    Err(err) => return err,
                }
                explicit_pattern_source = true;
                i += 1;
                continue;
            }
            if arg == "--file" && i + 1 < args.len() {
                i += 1;
                match read_pattern_file(interp, &args[i], &stdin, &mut had_stdin_read) {
                    Ok(lines) => patterns.extend(lines),
                    Err(err) => return err,
                }
                explicit_pattern_source = true;
                i += 1;
                continue;
            }
            if let Some(file) = arg.strip_prefix("-f").filter(|s| !s.is_empty()) {
                match read_pattern_file(interp, file, &stdin, &mut had_stdin_read) {
                    Ok(lines) => patterns.extend(lines),
                    Err(err) => return err,
                }
                explicit_pattern_source = true;
                i += 1;
                continue;
            }
            if let Some(n) = arg.strip_prefix("--max-count=") {
                opts.max_count = n.parse().unwrap_or(0);
                i += 1;
                continue;
            }
            if arg == "-m" && i + 1 < args.len() {
                i += 1;
                opts.max_count = args[i].parse().unwrap_or(0);
                i += 1;
                continue;
            }
            if let Some(n) = arg
                .strip_prefix("-m")
                .filter(|s| s.chars().all(|c| c.is_ascii_digit()) && !s.is_empty())
            {
                opts.max_count = n.parse().unwrap_or(0);
                i += 1;
                continue;
            }
            if arg.len() == 2
                && matches!(arg.as_bytes()[1], b'A' | b'B' | b'C')
                && i + 1 < args.len()
            {
                i += 1;
                let n: usize = args[i].parse().unwrap_or(0);
                match arg.as_bytes()[1] {
                    b'A' => opts.after = n,
                    b'B' => opts.before = n,
                    _ => {
                        opts.before = n;
                        opts.after = n;
                    }
                }
                i += 1;
                continue;
            }
            if arg.len() > 2
                && matches!(arg.as_bytes()[1], b'A' | b'B' | b'C')
                && arg[2..].chars().all(|c| c.is_ascii_digit())
            {
                let n: usize = arg[2..].parse().unwrap_or(0);
                match arg.as_bytes()[1] {
                    b'A' => opts.after = n,
                    b'B' => opts.before = n,
                    _ => {
                        opts.before = n;
                        opts.after = n;
                    }
                }
                i += 1;
                continue;
            }

            let flags: Vec<String> = if let Some(long) = arg.strip_prefix("--") {
                vec![format!("--{long}")]
            } else {
                arg[1..].chars().map(|c| c.to_string()).collect()
            };
            for flag in flags {
                match flag.as_str() {
                    "i" | "--ignore-case" => opts.ignore_case = true,
                    "n" | "--line-number" => opts.show_line_numbers = true,
                    "v" | "--invert-match" => opts.invert = true,
                    "c" | "--count" => opts.count_only = true,
                    "l" | "--files-with-matches" => opts.files_with_matches = true,
                    "L" | "--files-without-match" => opts.files_without_match = true,
                    "r" | "R" | "--recursive" => opts.recursive = true,
                    "w" | "--word-regexp" => opts.whole_word = true,
                    "x" | "--line-regexp" => opts.line_regexp = true,
                    "E" | "--extended-regexp" => mode = Mode::Extended,
                    "P" | "--perl-regexp" => mode = Mode::Extended,
                    "F" | "--fixed-strings" => mode = Mode::Fixed,
                    "o" | "--only-matching" => opts.only_matching = true,
                    "h" | "--no-filename" => opts.no_filename = true,
                    "q" | "--quiet" | "--silent" => opts.quiet = true,
                    "--help" => return ok(String::new()),
                    _ => return fail(format!("grep: unrecognized option '{flag}'\n"), 2),
                }
            }
            i += 1;
        } else if !explicit_pattern_source && patterns.is_empty() {
            patterns.push(arg.clone());
            i += 1;
        } else {
            files.push(arg.clone());
            i += 1;
        }
    }

    if patterns.is_empty() && !explicit_pattern_source {
        return fail("grep: missing pattern\n".to_string(), 2);
    }

    // An empty pattern list (e.g. an empty -f file, with no -e patterns)
    // selects nothing: no output, no per-file diagnostics, exit 1 (unless -v).
    let res: Vec<Regex> = if patterns.is_empty() {
        Vec::new()
    } else {
        match build_regexes(
            &patterns,
            mode,
            opts.ignore_case,
            opts.whole_word,
            opts.line_regexp,
        ) {
            Some(res) => res,
            None => {
                return fail(
                    format!(
                        "grep: invalid regular expression: {}\n",
                        patterns.join("\n")
                    ),
                    2,
                );
            }
        }
    };

    if files.is_empty() {
        let content = if had_stdin_read { String::new() } else { stdin };
        let (output, matched, _) = search(&content, &res, &opts, "");
        if opts.quiet {
            return CommandOutput {
                stdout: String::new(),
                stderr: String::new(),
                exit_code: if matched { 0 } else { 1 },
            };
        }
        return CommandOutput {
            stdout: output,
            stderr: String::new(),
            exit_code: if matched { 0 } else { 1 },
        };
    }

    // Expand -r/-R directories into a flat file list. `-` is a literal
    // operand naming standard input, never a directory to recurse into.
    let mut targets: Vec<String> = Vec::new();
    let mut has_file_target = false;
    for file in &files {
        if file == "-" {
            targets.push(file.clone());
        } else if opts.recursive {
            has_file_target = true;
            collect_recursive(interp, file, &mut targets);
        } else {
            has_file_target = true;
            targets.push(file.clone());
        }
    }

    let show_filename =
        (targets.len() > 1 || (opts.recursive && has_file_target)) && !opts.no_filename;
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut any_match = false;
    let mut any_error = false;
    let mut stdin_consumed = had_stdin_read;

    for file in &targets {
        const STDIN_FILENAME: &str = "(standard input)";
        let content = if file == "-" {
            let text = if stdin_consumed {
                String::new()
            } else {
                stdin.clone()
            };
            stdin_consumed = true;
            text
        } else {
            let path = normalize_path(&interp.cwd, file);
            if interp.fs.is_dir(&path) {
                if !opts.recursive {
                    stderr.push_str(&format!("grep: {file}: Is a directory\n"));
                }
                continue;
            }
            let Some(bytes) = interp.fs.read_file(&path) else {
                stderr.push_str(&format!("grep: {file}: No such file or directory\n"));
                any_error = true;
                continue;
            };
            String::from_utf8_lossy(&bytes).into_owned()
        };
        let display_name = if file == "-" { STDIN_FILENAME } else { file };
        let name = if show_filename { display_name } else { "" };
        let (output, matched, _) = search(&content, &res, &opts, name);
        if matched {
            any_match = true;
            if opts.quiet {
                return CommandOutput {
                    stdout: String::new(),
                    stderr: String::new(),
                    exit_code: 0,
                };
            }
            if opts.files_with_matches {
                stdout.push_str(display_name);
                stdout.push('\n');
            } else if !opts.files_without_match {
                stdout.push_str(&output);
            }
        } else if opts.files_without_match {
            stdout.push_str(display_name);
            stdout.push('\n');
        } else if opts.count_only && !opts.files_with_matches {
            stdout.push_str(&output);
        }
    }

    // Exit status reports whether a line was *selected*, never whether a
    // filename was *printed* -- -L shares the ordinary rule (verified
    // against GNU grep 3.12 / BSD grep 2.6.0-FreeBSD).
    let exit_code = if any_error {
        2
    } else if any_match {
        0
    } else {
        1
    };

    if opts.quiet {
        return CommandOutput {
            stdout: String::new(),
            stderr: String::new(),
            exit_code,
        };
    }
    CommandOutput {
        stdout,
        stderr,
        exit_code,
    }
}

fn collect_recursive(interp: &Interpreter, root: &str, out: &mut Vec<String>) {
    let full = normalize_path(&interp.cwd, root);
    if interp.fs.is_file(&full) {
        out.push(root.to_string());
        return;
    }
    if !interp.fs.is_dir(&full) {
        return;
    }
    let Some(entries) = interp.fs.readdir(&full) else {
        return;
    };
    let base = root.trim_end_matches('/');
    for entry in entries {
        if entry.starts_with('.') {
            continue;
        }
        let child = format!("{base}/{entry}");
        collect_recursive(interp, &child, out);
    }
}

/// Search `content` line by line, returning `(formatted_output, any_match,
/// match_count)`. `filename` is `""` to suppress the `file:` prefix. An empty
/// `patterns` slice (an empty `-f` pattern file with no `-e`/positional
/// pattern) never matches any line.
fn search(content: &str, patterns: &[Regex], opts: &Opts, filename: &str) -> (String, bool, usize) {
    let mut lines: Vec<&str> = content.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }

    let mut matched_flags = vec![false; lines.len()];
    let mut match_count = 0usize;
    for (i, line) in lines.iter().enumerate() {
        let is_match = patterns.iter().any(|re| re.is_match(line));
        let selected = if opts.invert { !is_match } else { is_match };
        if selected {
            matched_flags[i] = true;
            match_count += 1;
            if opts.max_count > 0 && match_count >= opts.max_count {
                break;
            }
        }
    }
    let any_match = match_count > 0;

    if opts.count_only {
        let prefix = if !filename.is_empty() {
            format!("{filename}:")
        } else {
            String::new()
        };
        return (format!("{prefix}{match_count}\n"), any_match, match_count);
    }

    let mut print_flags = matched_flags.clone();
    if opts.before > 0 || opts.after > 0 {
        for (i, &is_match) in matched_flags.iter().enumerate() {
            if is_match {
                let before_start = i.saturating_sub(opts.before);
                for flag in &mut print_flags[before_start..i] {
                    *flag = true;
                }
                let after_end = (i + opts.after).min(lines.len().saturating_sub(1));
                if after_end > i {
                    for flag in &mut print_flags[(i + 1)..=after_end] {
                        *flag = true;
                    }
                }
            }
        }
    }

    let mut out = String::new();
    let mut prev_printed: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        if !print_flags[i] {
            continue;
        }
        if let Some(prev) = prev_printed
            && i > prev + 1
            && (opts.before > 0 || opts.after > 0)
        {
            out.push_str("--\n");
        }
        let sep = if matched_flags[i] { ':' } else { '-' };
        if opts.only_matching {
            let mut matches: Vec<(usize, &str)> = patterns
                .iter()
                .flat_map(|re| re.find_iter(line))
                .map(|m| (m.start(), m.as_str()))
                .collect();
            matches.sort_by_key(|(start, _)| *start);
            for (_, text) in matches {
                if !filename.is_empty() {
                    out.push_str(filename);
                    out.push(sep);
                }
                if opts.show_line_numbers {
                    out.push_str(&(i + 1).to_string());
                    out.push(sep);
                }
                out.push_str(text);
                out.push('\n');
            }
        } else {
            if !filename.is_empty() {
                out.push_str(filename);
                out.push(sep);
            }
            if opts.show_line_numbers {
                out.push_str(&(i + 1).to_string());
                out.push(sep);
            }
            out.push_str(line);
            out.push('\n');
        }
        prev_printed = Some(i);
    }
    (out, any_match, match_count)
}

/// Reads pattern lines for `-f`/`--file`. `name == "-"` reads stdin (only the
/// first such read sees its content; a repeated `-f -` hits EOF, matching
/// `Interpreter`'s single-consumer stdin stream). Returns a GNU-style
/// diagnostic (exit 2) for a missing file or a directory.
fn read_pattern_file(
    interp: &mut Interpreter,
    name: &str,
    stdin: &str,
    stdin_read: &mut bool,
) -> Result<Vec<String>, CommandOutput> {
    if name == "-" {
        if *stdin_read {
            return Ok(Vec::new());
        }
        *stdin_read = true;
        return Ok(stdin.lines().map(str::to_string).collect());
    }
    let path = normalize_path(&interp.cwd, name);
    if interp.fs.is_dir(&path) {
        return Err(fail(format!("grep: {name}: Is a directory\n"), 2));
    }
    let Some(bytes) = interp.fs.read_file(&path) else {
        return Err(fail(
            format!("grep: {name}: No such file or directory\n"),
            2,
        ));
    };
    let content = String::from_utf8_lossy(&bytes);
    Ok(content.lines().map(str::to_string).collect())
}

/// Compiles each pattern individually (rather than joining them into one
/// alternation) so a malformed pattern can't silently swallow the separator
/// and absorb its neighbour, and so `-x`'s `^(?:...)$` wrap anchors each
/// alternative rather than only the first/last.
fn build_regexes(
    patterns: &[String],
    mode: Mode,
    ignore_case: bool,
    whole_word: bool,
    line_regexp: bool,
) -> Option<Vec<Regex>> {
    patterns
        .iter()
        .map(|p| build_regex(p, mode, ignore_case, whole_word, line_regexp))
        .collect()
}

fn build_regex(
    pattern: &str,
    mode: Mode,
    ignore_case: bool,
    whole_word: bool,
    line_regexp: bool,
) -> Option<Regex> {
    let core = match mode {
        Mode::Fixed => regex::escape(pattern),
        Mode::Basic => translate_bre(pattern),
        Mode::Extended => pattern.to_string(),
    };
    let wrapped = if line_regexp {
        format!("^(?:{core})$")
    } else if whole_word {
        format!(r"\b(?:{core})\b")
    } else {
        core
    };
    RegexBuilder::new(&wrapped)
        .case_insensitive(ignore_case)
        .build()
        .ok()
}

/// Translate a POSIX BRE into the `regex` crate's ERE-like syntax: `\(` `\)`
/// `\{` `\}` `\+` `\?` `\|` become the metacharacters, bare `( ) { } + ? |`
/// become literals, and `^`/`$`/`*` are literal except where BRE treats them
/// as special (start/end anchors, `*` as a quantifier anywhere but the start
/// of the pattern or a group). Bracket expressions (`[...]`, including
/// `[[:class:]]`) pass straight through since the `regex` crate already
/// understands them. Backreferences (`\1`) are not supported (best-effort:
/// left as literal digits).
pub(crate) fn translate_bre(pattern: &str) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let mut at_start = true;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            let next = chars[i + 1];
            match next {
                '(' => {
                    out.push('(');
                    at_start = true;
                    i += 2;
                    continue;
                }
                ')' => {
                    out.push(')');
                    at_start = false;
                    i += 2;
                    continue;
                }
                '{' => {
                    out.push('{');
                    i += 2;
                    continue;
                }
                '}' => {
                    out.push('}');
                    i += 2;
                    continue;
                }
                '+' => {
                    out.push('+');
                    at_start = false;
                    i += 2;
                    continue;
                }
                '?' => {
                    out.push('?');
                    at_start = false;
                    i += 2;
                    continue;
                }
                '|' => {
                    out.push('|');
                    at_start = true;
                    i += 2;
                    continue;
                }
                _ => {
                    out.push('\\');
                    out.push(next);
                    at_start = false;
                    i += 2;
                    continue;
                }
            }
        }
        if c == '^' {
            if at_start {
                out.push('^');
                // `*` immediately after `^` is still literal in BRE.
            } else {
                out.push_str("\\^");
                at_start = false;
            }
            i += 1;
            continue;
        }
        if c == '$' {
            if i == chars.len() - 1 {
                out.push('$');
            } else {
                out.push_str("\\$");
            }
            at_start = false;
            i += 1;
            continue;
        }
        if c == '*' {
            if at_start {
                out.push_str("\\*");
            } else {
                out.push('*');
            }
            at_start = false;
            i += 1;
            continue;
        }
        if c == '[' {
            // Copy the bracket expression verbatim (handles `]` as first
            // char, `^]` negation, and `[:class:]`).
            let start = i;
            let mut j = i + 1;
            if chars.get(j) == Some(&'^') {
                j += 1;
            }
            if chars.get(j) == Some(&']') {
                j += 1;
            }
            while j < chars.len() && chars[j] != ']' {
                j += 1;
            }
            let end = (j + 1).min(chars.len());
            out.extend(&chars[start..end]);
            i = end;
            at_start = false;
            continue;
        }
        if "+?{}()|".contains(c) {
            out.push('\\');
            out.push(c);
        } else {
            out.push(c);
        }
        at_start = false;
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use crate::bash::Bash;
    use crate::types::{BashOptions, ExecOptions};

    fn fresh() -> Bash {
        Bash::new(BashOptions::default())
    }

    fn run(bash: &mut Bash, script: &str) -> crate::types::ExecResult {
        bash.exec(script, ExecOptions::default())
    }

    #[test]
    fn finds_matching_lines() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/test.txt", b"hello world\nfoo bar\nhello again\n")
            .unwrap();
        let r = run(&mut bash, "grep hello /test.txt");
        assert_eq!(r.stdout, "hello world\nhello again\n");
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    fn no_match_exits_one() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/test.txt", b"hello world\n")
            .unwrap();
        let r = run(&mut bash, "grep missing /test.txt");
        assert_eq!(r.stdout, "");
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn ignore_case() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/test.txt", b"Hello\nhello\nHELLO\n")
            .unwrap();
        let r = run(&mut bash, "grep -i hello /test.txt");
        assert_eq!(r.stdout, "Hello\nhello\nHELLO\n");
    }

    #[test]
    fn line_numbers() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/test.txt", b"aaa\nbbb\naaa\n")
            .unwrap();
        let r = run(&mut bash, "grep -n aaa /test.txt");
        assert_eq!(r.stdout, "1:aaa\n3:aaa\n");
    }

    #[test]
    fn invert_match() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/test.txt", b"keep\nremove\nkeep\n")
            .unwrap();
        let r = run(&mut bash, "grep -v remove /test.txt");
        assert_eq!(r.stdout, "keep\nkeep\n");
    }

    #[test]
    fn count_matches() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/test.txt", b"a\nb\na\na\n")
            .unwrap();
        let r = run(&mut bash, "grep -c a /test.txt");
        assert_eq!(r.stdout, "3\n");
    }

    #[test]
    fn files_with_matches() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/a.txt", b"found here\n").unwrap();
        bash.fs_mut().write_file("/b.txt", b"nothing\n").unwrap();
        let r = run(&mut bash, "grep -l found /a.txt /b.txt");
        assert_eq!(r.stdout, "/a.txt\n");
    }

    #[test]
    fn recursive_search() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/dir/root.txt", b"needle here\n")
            .unwrap();
        bash.fs_mut()
            .write_file("/dir/sub/file.txt", b"another needle\n")
            .unwrap();
        let r = run(&mut bash, "grep -r needle /dir");
        assert_eq!(
            r.stdout,
            "/dir/root.txt:needle here\n/dir/sub/file.txt:another needle\n"
        );
    }

    #[test]
    fn whole_word() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/test.txt", b"cat\ncats\ncat dog\ncaterpillar\n")
            .unwrap();
        let r = run(&mut bash, "grep -w cat /test.txt");
        assert_eq!(r.stdout, "cat\ncat dog\n");
    }

    #[test]
    fn extended_regex_alternation() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/test.txt", b"cat\ndog\nbird\n")
            .unwrap();
        let r = run(&mut bash, r#"grep -E "cat|dog" /test.txt"#);
        assert_eq!(r.stdout, "cat\ndog\n");
    }

    #[test]
    fn basic_regex_star_is_quantifier_after_char() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/test.txt", b"ac\nabc\nabbc\nabbbc\n")
            .unwrap();
        let r = run(&mut bash, r#"grep "ab*c" /test.txt"#);
        assert_eq!(r.stdout, "ac\nabc\nabbc\nabbbc\n");
    }

    #[test]
    fn basic_regex_anchors() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/test.txt", b"hello world\nworld hello\n")
            .unwrap();
        let r = run(&mut bash, r#"grep "^hello" /test.txt"#);
        assert_eq!(r.stdout, "hello world\n");
        // Single-quoted so the shell doesn't try to expand the trailing `$`
        // as a (nonexistent) variable.
        let r = run(&mut bash, "grep 'hello$' /test.txt");
        assert_eq!(r.stdout, "world hello\n");
    }

    #[test]
    fn character_class() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/test.txt", b"cat\nbat\nrat\nhat\n")
            .unwrap();
        let r = run(&mut bash, r#"grep "[cbr]at" /test.txt"#);
        assert_eq!(r.stdout, "cat\nbat\nrat\n");
        let r = run(&mut bash, r#"grep "[^cbr]at" /test.txt"#);
        assert_eq!(r.stdout, "hat\n");
    }

    #[test]
    fn missing_pattern_errors() {
        let mut bash = fresh();
        let r = run(&mut bash, "grep");
        assert_eq!(r.stderr, "grep: missing pattern\n");
        assert_eq!(r.exit_code, 2);
    }

    #[test]
    fn missing_file_exit_code_two() {
        let mut bash = fresh();
        let r = run(&mut bash, "grep pattern /missing.txt");
        assert_eq!(r.stderr, "grep: /missing.txt: No such file or directory\n");
        assert_eq!(r.exit_code, 2);
    }

    #[test]
    fn directory_without_recursive_is_an_error_but_not_fatal() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/dir/file.txt", b"content\n")
            .unwrap();
        let r = run(&mut bash, "grep pattern /dir");
        assert_eq!(r.stdout, "");
        assert_eq!(r.stderr, "grep: /dir: Is a directory\n");
    }

    #[test]
    fn posix_class() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/test.txt", b"abc\n123\na1b\n")
            .unwrap();
        let r = run(&mut bash, "grep -E '^[[:alpha:]]+$' /test.txt");
        assert_eq!(r.stdout, "abc\n");
    }

    #[test]
    fn dash_operand_reads_stdin() {
        let mut bash = fresh();
        let r = run(&mut bash, "printf 'hello world\\nbye\\n' | grep hello -");
        assert_eq!(r.stdout, "hello world\n");
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    fn dash_operand_labels_standard_input_alongside_a_real_file() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/a.txt", b"needle in a\n")
            .unwrap();
        let r = run(
            &mut bash,
            "printf 'needle in stdin\\n' | grep needle /a.txt -",
        );
        assert_eq!(
            r.stdout,
            "/a.txt:needle in a\n(standard input):needle in stdin\n"
        );
    }

    #[test]
    fn files_without_match_exit_code_follows_gnu_not_output() {
        let mut bash = fresh();
        // Every file matches: -L prints nothing but still exits 0.
        bash.fs_mut().write_file("/a.txt", b"needle\n").unwrap();
        let r = run(&mut bash, "grep -L needle /a.txt");
        assert_eq!(r.stdout, "");
        assert_eq!(r.exit_code, 0);

        // No file matches: -L lists it but exits 1.
        bash.fs_mut().write_file("/b.txt", b"nothing\n").unwrap();
        let r = run(&mut bash, "grep -L needle /b.txt");
        assert_eq!(r.stdout, "/b.txt\n");
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn dash_f_reads_patterns_from_file_and_ors_them() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/pat.txt", b"apple\nbanana\n")
            .unwrap();
        bash.fs_mut()
            .write_file("/hay.txt", b"apple pie\ncherry\nbanana split\n")
            .unwrap();
        let r = run(&mut bash, "grep -f /pat.txt /hay.txt");
        assert_eq!(r.stdout, "apple pie\nbanana split\n");
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    fn dash_f_combines_with_dash_x_to_anchor_every_alternative() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/pat.txt", b"foo\nbar\n").unwrap();
        bash.fs_mut()
            .write_file("/data.txt", b"foo\nbar\nfoobar\n")
            .unwrap();
        let r = run(&mut bash, "grep -x -f /pat.txt /data.txt");
        assert_eq!(r.stdout, "foo\nbar\n");
    }

    #[test]
    fn missing_pattern_file_is_an_error() {
        let mut bash = fresh();
        let r = run(&mut bash, "grep -f /missing.txt /hay.txt");
        assert_eq!(r.stderr, "grep: /missing.txt: No such file or directory\n");
        assert_eq!(r.exit_code, 2);
    }
}
