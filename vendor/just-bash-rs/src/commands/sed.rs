//! PORT (simplified): vendor/just-bash/src/commands/sed/{sed,executor,lexer,parser,sed-regex}.ts
//!
//! `sed [-n] [-E|-r] [-i] [-e SCRIPT]... [SCRIPT] [FILE...]`, hand-rolled
//! rather than a port of upstream's lexer/parser/executor (those build a
//! general token stream for a much bigger command set). Supports:
//! addressing by line number, `$` (last line), `/regex/`, `addr1,addr2`
//! ranges, and a leading `!`/trailing negation; commands `s///[flags]`
//! (`g`/`i`/`p` and an `N`th-occurrence digit), `d`, `p`, `q`, and `r file`
//! (queue a file's contents after the current line, `-n`-immune like GNU
//! sed, missing file silently produces nothing); `-n` (suppress automatic
//! printing), repeated `-e`, and `-i` (in-place, no backup-suffix support).
//! Regex flavor reuses `grep::translate_bre` for the BRE default and passes
//! patterns straight through in `-E`/`-r` (ERE) mode.
//! Not ported (the design doc's stretch goal): hold space (`h H g G x`),
//! `a`/`i`/`c` text insertion, branching/labels (`b`/`t`/`:label`),
//! multiline `N`/`D`/`P`, `y` transliteration, step addresses
//! (`first~step`), relative-offset range ends (`addr1,+N`), and grouped
//! `{ ... }` blocks.

use std::collections::HashMap;

use regex::{Captures, Regex, RegexBuilder};

use super::grep::translate_bre;
use super::{fail, normalize_path, ok};
use crate::interpreter::{CommandOutput, Interpreter};

enum Address {
    Line(usize),
    Last,
    Regex(Regex),
}

struct AddrSpec {
    start: Option<Address>,
    end: Option<Address>,
    negate: bool,
}

struct Substitution {
    regex: Regex,
    replacement: String,
    global: bool,
    print: bool,
    occurrence: Option<usize>,
}

enum SedCommand {
    Substitute(Substitution),
    Delete,
    Print,
    Quit,
    ReadFile(String),
}

struct SedStmt {
    addr: AddrSpec,
    cmd: SedCommand,
}

/// Read a `delim`-terminated field, honoring `\<delim>` as a literal
/// delimiter (stripping the backslash) and leaving every other backslash
/// pair untouched for the regex/replacement builder to interpret. Returns
/// the field text and the index of the (unconsumed) closing delimiter.
fn read_delimited(chars: &[char], mut i: usize, delim: char) -> (String, usize) {
    let mut out = String::new();
    while i < chars.len() && chars[i] != delim {
        if chars[i] == '\\' && i + 1 < chars.len() {
            if chars[i + 1] == delim {
                out.push(delim);
            } else {
                out.push(chars[i]);
                out.push(chars[i + 1]);
            }
            i += 2;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    (out, i)
}

fn compile(pattern: &str, extended: bool, ignore_case: bool) -> Result<Regex, String> {
    let core = if extended {
        pattern.to_string()
    } else {
        translate_bre(pattern)
    };
    RegexBuilder::new(&core)
        .case_insensitive(ignore_case)
        .build()
        .map_err(|_| format!("sed: invalid regex: {pattern}"))
}

fn parse_address(
    chars: &[char],
    mut i: usize,
    extended: bool,
) -> Result<(Option<Address>, usize), String> {
    if i < chars.len() && chars[i] == '$' {
        return Ok((Some(Address::Last), i + 1));
    }
    if i < chars.len() && chars[i].is_ascii_digit() {
        let start = i;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
        let n: usize = chars[start..i]
            .iter()
            .collect::<String>()
            .parse()
            .unwrap_or(0);
        return Ok((Some(Address::Line(n)), i));
    }
    if i < chars.len() && chars[i] == '/' {
        i += 1;
        let (pat, ni) = read_delimited(chars, i, '/');
        i = ni;
        if chars.get(i) != Some(&'/') {
            return Err("sed: unterminated address regex\n".to_string());
        }
        i += 1;
        let regex = compile(&pat, extended, false)?;
        return Ok((Some(Address::Regex(regex)), i));
    }
    Ok((None, i))
}

fn parse_s_command(
    chars: &[char],
    mut i: usize,
    extended: bool,
) -> Result<(SedCommand, usize), String> {
    i += 1; // skip 's'
    let delim = *chars
        .get(i)
        .ok_or_else(|| "sed: unterminated `s' command\n".to_string())?;
    i += 1;
    let (pattern_raw, ni) = read_delimited(chars, i, delim);
    i = ni;
    if chars.get(i) != Some(&delim) {
        return Err("sed: unterminated `s' command\n".to_string());
    }
    i += 1;
    let (replacement_raw, ni2) = read_delimited(chars, i, delim);
    i = ni2;
    if chars.get(i) != Some(&delim) {
        return Err("sed: unterminated `s' command\n".to_string());
    }
    i += 1;

    let mut global = false;
    let mut ignore_case = false;
    let mut print = false;
    let mut num = String::new();
    while i < chars.len() && (chars[i].is_ascii_alphabetic() || chars[i].is_ascii_digit()) {
        match chars[i] {
            'g' => global = true,
            'i' | 'I' => ignore_case = true,
            'p' => print = true,
            c if c.is_ascii_digit() => num.push(c),
            _ => {}
        }
        i += 1;
    }
    let occurrence = if num.is_empty() {
        None
    } else {
        num.parse().ok()
    };
    let regex = compile(&pattern_raw, extended, ignore_case)?;
    Ok((
        SedCommand::Substitute(Substitution {
            regex,
            replacement: replacement_raw,
            global,
            print,
            occurrence,
        }),
        i,
    ))
}

fn skip_space(chars: &[char], mut i: usize) -> usize {
    while i < chars.len() && (chars[i] == ' ' || chars[i] == '\t') {
        i += 1;
    }
    i
}

fn parse_one_statement(
    chars: &[char],
    mut i: usize,
    extended: bool,
) -> Result<(SedStmt, usize), String> {
    let (addr1, ni) = parse_address(chars, i, extended)?;
    i = skip_space(chars, ni);
    let mut addr2 = None;
    if addr1.is_some() && chars.get(i) == Some(&',') {
        i = skip_space(chars, i + 1);
        let (a2, ni2) = parse_address(chars, i, extended)?;
        addr2 = a2;
        i = ni2;
    }
    i = skip_space(chars, i);
    let mut negate = false;
    if chars.get(i) == Some(&'!') {
        negate = true;
        i = skip_space(chars, i + 1);
    }
    let Some(&cmd_char) = chars.get(i) else {
        return Err("sed: missing command\n".to_string());
    };
    let (cmd, next_i) = match cmd_char {
        's' => parse_s_command(chars, i, extended)?,
        'd' => (SedCommand::Delete, i + 1),
        'p' => (SedCommand::Print, i + 1),
        'q' => (SedCommand::Quit, i + 1),
        'r' => {
            // GNU `r`: the filename is the rest of the line (leading blanks
            // skipped, `;` is not a separator here), so read to the newline.
            let mut j = skip_space(chars, i + 1);
            let start = j;
            while j < chars.len() && chars[j] != '\n' {
                j += 1;
            }
            let filename: String = chars[start..j].iter().collect();
            (SedCommand::ReadFile(filename), j)
        }
        other => return Err(format!("sed: unknown command: `{other}'\n")),
    };
    Ok((
        SedStmt {
            addr: AddrSpec {
                start: addr1,
                end: addr2,
                negate,
            },
            cmd,
        },
        next_i,
    ))
}

fn parse_script(script: &str, extended: bool) -> Result<Vec<SedStmt>, String> {
    let chars: Vec<char> = script.chars().collect();
    let mut i = 0;
    let mut stmts = Vec::new();
    loop {
        while i < chars.len()
            && (chars[i] == ';' || chars[i] == '\n' || chars[i] == ' ' || chars[i] == '\t')
        {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        let (stmt, next_i) = parse_one_statement(&chars, i, extended)?;
        stmts.push(stmt);
        i = next_i;
    }
    Ok(stmts)
}

fn addr_matches_single(addr: &Address, line_no: usize, is_last: bool, pattern_space: &str) -> bool {
    match addr {
        Address::Line(n) => line_no == *n,
        Address::Last => is_last,
        Address::Regex(re) => re.is_match(pattern_space),
    }
}

/// Evaluate one statement's address against the current line, threading the
/// `active` flag that makes `addr1,addr2` ranges stateful across lines.
fn address_applies(
    addr: &AddrSpec,
    active: &mut bool,
    line_no: usize,
    is_last: bool,
    pattern_space: &str,
) -> bool {
    let raw = match (&addr.start, &addr.end) {
        (None, _) => true,
        (Some(a), None) => addr_matches_single(a, line_no, is_last, pattern_space),
        (Some(a), Some(b)) => {
            if *active {
                if addr_matches_single(b, line_no, is_last, pattern_space) {
                    *active = false;
                }
                true
            } else if addr_matches_single(a, line_no, is_last, pattern_space) {
                if !addr_matches_single(b, line_no, is_last, pattern_space) {
                    *active = true;
                }
                true
            } else {
                false
            }
        }
    };
    if addr.negate { !raw } else { raw }
}

/// Build one replacement instance from a sed replacement template: `&` is
/// the whole match, `\1`-`\9` a capture group, `\&`/`\\` literal `&`/`\`.
fn build_replacement(template: &str, caps: &Captures) -> String {
    let chars: Vec<char> = template.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            let next = chars[i + 1];
            if let Some(d) = next.to_digit(10) {
                if let Some(m) = caps.get(d as usize) {
                    out.push_str(m.as_str());
                }
            } else {
                match next {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    other => out.push(other),
                }
            }
            i += 2;
            continue;
        }
        if chars[i] == '&' {
            if let Some(m) = caps.get(0) {
                out.push_str(m.as_str());
            }
            i += 1;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Apply one `s///` to `input`, returning the new pattern space and whether
/// anything changed. `occurrence` (sed's numeric flag) replaces only that
/// 1-based match; combined with `global` it replaces that match and every
/// one after it.
fn apply_substitution(sub: &Substitution, input: &str) -> (String, bool) {
    let start_n = sub.occurrence.unwrap_or(1);
    let mut out = String::new();
    let mut last_end = 0usize;
    let mut count = 0usize;
    let mut changed = false;
    for caps in sub.regex.captures_iter(input) {
        let m = caps.get(0).unwrap();
        count += 1;
        if count < start_n {
            continue;
        }
        out.push_str(&input[last_end..m.start()]);
        out.push_str(&build_replacement(&sub.replacement, &caps));
        last_end = m.end();
        changed = true;
        if !sub.global {
            break;
        }
    }
    out.push_str(&input[last_end..]);
    (out, changed)
}

fn run_sed(
    stmts: &[SedStmt],
    content: &str,
    suppress_auto: bool,
    file_cache: &HashMap<String, String>,
) -> String {
    let mut lines: Vec<&str> = content.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let total = lines.len();
    let mut range_active = vec![false; stmts.len()];
    let mut out = String::new();

    for (idx, line) in lines.iter().enumerate() {
        let line_no = idx + 1;
        let is_last = line_no == total;
        let mut pattern_space = line.to_string();
        let mut deleted = false;
        let mut quit_after = false;
        // `r` output is queued and flushed after the current line's
        // auto-print, verbatim and regardless of `-n` (GNU behavior).
        let mut appends: Vec<&str> = Vec::new();
        for (si, stmt) in stmts.iter().enumerate() {
            if !address_applies(
                &stmt.addr,
                &mut range_active[si],
                line_no,
                is_last,
                &pattern_space,
            ) {
                continue;
            }
            match &stmt.cmd {
                SedCommand::Substitute(sub) => {
                    let (new_space, changed) = apply_substitution(sub, &pattern_space);
                    pattern_space = new_space;
                    if changed && sub.print {
                        out.push_str(&pattern_space);
                        out.push('\n');
                    }
                }
                SedCommand::Delete => deleted = true,
                SedCommand::Print => {
                    out.push_str(&pattern_space);
                    out.push('\n');
                }
                SedCommand::Quit => quit_after = true,
                SedCommand::ReadFile(name) => {
                    if let Some(text) = file_cache.get(name) {
                        appends.push(text);
                    }
                }
            }
            if deleted || quit_after {
                break;
            }
        }
        if !deleted && !suppress_auto {
            out.push_str(&pattern_space);
            out.push('\n');
        }
        for text in appends {
            out.push_str(text);
        }
        if quit_after {
            break;
        }
    }

    out
}

pub fn sed(interp: &mut Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let mut suppress_auto = false;
    let mut extended = false;
    let mut in_place = false;
    let mut scripts: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-n" || arg == "--quiet" || arg == "--silent" {
            suppress_auto = true;
        } else if arg == "-E" || arg == "-r" || arg == "--regexp-extended" {
            extended = true;
        } else if arg == "-i" || arg == "--in-place" {
            in_place = true;
        } else if arg == "-e" && i + 1 < args.len() {
            i += 1;
            scripts.push(args[i].clone());
        } else if let Some(rest) = arg.strip_prefix("--expression=") {
            scripts.push(rest.to_string());
        } else if let Some(rest) = arg.strip_prefix("-e") {
            if !rest.is_empty() {
                scripts.push(rest.to_string());
            }
        } else if arg.starts_with('-') && arg != "-" {
            // Unrecognized flag: not in the ported subset, ignored.
        } else if scripts.is_empty() {
            scripts.push(arg.clone());
        } else {
            files.push(arg.clone());
        }
        i += 1;
    }

    let joined = scripts.join("\n");
    let stmts = match parse_script(&joined, extended) {
        Ok(s) => s,
        Err(e) => return fail(e, 1),
    };

    // Resolve `r file` targets up front (missing files silently read as
    // nothing, like GNU sed) so `run_sed` needs no filesystem access.
    let mut file_cache: HashMap<String, String> = HashMap::new();
    for stmt in &stmts {
        if let SedCommand::ReadFile(name) = &stmt.cmd
            && !file_cache.contains_key(name)
        {
            let path = normalize_path(&interp.cwd, name);
            if let Some(bytes) = interp.fs.read_file(&path) {
                file_cache.insert(name.clone(), String::from_utf8_lossy(&bytes).into_owned());
            }
        }
    }

    if files.is_empty() {
        return ok(run_sed(&stmts, &stdin, suppress_auto, &file_cache));
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = 0;
    for file in &files {
        let path = normalize_path(&interp.cwd, file);
        match interp.fs.read_file(&path).as_deref() {
            Some(bytes) => {
                let content = String::from_utf8_lossy(bytes).into_owned();
                let out = run_sed(&stmts, &content, suppress_auto, &file_cache);
                if in_place {
                    let _ = interp.fs.write_file(&path, out.as_bytes());
                } else {
                    stdout.push_str(&out);
                }
            }
            None => {
                stderr.push_str(&format!("sed: {file}: No such file or directory\n"));
                exit_code = 1;
            }
        }
    }
    CommandOutput {
        stdout,
        stderr,
        exit_code,
    }
}

#[cfg(test)]
mod tests {
    use crate::bash::Bash;
    use crate::types::{BashOptions, ExecOptions, ExecResult};

    fn fresh() -> Bash {
        Bash::new(BashOptions {
            cwd: "/test".into(),
            ..Default::default()
        })
    }

    fn run(bash: &mut Bash, script: &str) -> ExecResult {
        bash.exec(script, ExecOptions::default())
    }

    fn env_with_fixtures() -> Bash {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file(
                "/test/file.txt",
                b"hello world\nhello universe\ngoodbye world\n",
            )
            .unwrap();
        bash.fs_mut()
            .write_file(
                "/test/numbers.txt",
                b"line 1\nline 2\nline 3\nline 4\nline 5\n",
            )
            .unwrap();
        bash
    }

    #[test]
    fn replace_first_occurrence() {
        let mut bash = env_with_fixtures();
        let r = run(&mut bash, "sed 's/hello/hi/' /test/file.txt");
        assert_eq!(r.stdout, "hi world\nhi universe\ngoodbye world\n");
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    fn global_flag() {
        let mut bash = env_with_fixtures();
        let r = run(&mut bash, "sed 's/l/L/g' /test/file.txt");
        assert_eq!(r.stdout, "heLLo worLd\nheLLo universe\ngoodbye worLd\n");
    }

    #[test]
    fn print_specific_line_with_n() {
        let mut bash = env_with_fixtures();
        let r = run(&mut bash, "sed -n '3p' /test/numbers.txt");
        assert_eq!(r.stdout, "line 3\n");
    }

    #[test]
    fn print_range_with_n() {
        let mut bash = env_with_fixtures();
        let r = run(&mut bash, "sed -n '2,4p' /test/numbers.txt");
        assert_eq!(r.stdout, "line 2\nline 3\nline 4\n");
    }

    #[test]
    fn delete_matching_lines() {
        let mut bash = env_with_fixtures();
        let r = run(&mut bash, "sed '/hello/d' /test/file.txt");
        assert_eq!(r.stdout, "goodbye world\n");
    }

    #[test]
    fn delete_line_number_and_range() {
        let mut bash = env_with_fixtures();
        assert_eq!(
            run(&mut bash, "sed '2d' /test/numbers.txt").stdout,
            "line 1\nline 3\nline 4\nline 5\n"
        );
        let mut bash2 = env_with_fixtures();
        assert_eq!(
            run(&mut bash2, "sed '2,4d' /test/numbers.txt").stdout,
            "line 1\nline 5\n"
        );
    }

    #[test]
    fn stdin_pipe() {
        let mut bash = fresh();
        let r = run(&mut bash, "echo 'foo bar' | sed 's/bar/baz/'");
        assert_eq!(r.stdout, "foo baz\n");
    }

    #[test]
    fn custom_delimiter() {
        let mut bash = fresh();
        let r = run(&mut bash, "echo '/path/to/file' | sed 's#/path#/newpath#'");
        assert_eq!(r.stdout, "/newpath/to/file\n");
    }

    #[test]
    fn bracket_regex() {
        let mut bash = env_with_fixtures();
        let r = run(&mut bash, "sed 's/[0-9]/X/' /test/numbers.txt");
        assert_eq!(r.stdout, "line X\nline X\nline X\nline X\nline X\n");
    }

    #[test]
    fn missing_file_errors() {
        let mut bash = env_with_fixtures();
        let r = run(&mut bash, "sed 's/a/b/' /test/nonexistent.txt");
        assert_eq!(r.stdout, "");
        assert_eq!(
            r.stderr,
            "sed: /test/nonexistent.txt: No such file or directory\n"
        );
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn empty_replacement() {
        let mut bash = env_with_fixtures();
        let r = run(&mut bash, "sed 's/world//' /test/file.txt");
        assert_eq!(r.stdout, "hello \nhello universe\ngoodbye \n");
    }

    #[test]
    fn ignore_case_flag() {
        let mut bash = env_with_fixtures();
        let r = run(&mut bash, "sed 's/HELLO/hi/i' /test/file.txt");
        assert_eq!(r.stdout, "hi world\nhi universe\ngoodbye world\n");
    }

    #[test]
    fn combine_i_and_g_flags() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/test.txt", b"Hello HELLO hello\n")
            .unwrap();
        let r = run(&mut bash, "sed 's/hello/hi/gi' /test.txt");
        assert_eq!(r.stdout, "hi hi hi\n");
    }

    #[test]
    fn substitute_by_line_address() {
        let mut bash = env_with_fixtures();
        assert_eq!(
            run(&mut bash, "sed '1s/line/LINE/' /test/numbers.txt").stdout,
            "LINE 1\nline 2\nline 3\nline 4\nline 5\n"
        );
        let mut bash2 = env_with_fixtures();
        assert_eq!(
            run(&mut bash2, "sed '$ s/line/LINE/' /test/numbers.txt").stdout,
            "line 1\nline 2\nline 3\nline 4\nLINE 5\n"
        );
        let mut bash3 = env_with_fixtures();
        assert_eq!(
            run(&mut bash3, "sed '2,4s/line/LINE/' /test/numbers.txt").stdout,
            "line 1\nLINE 2\nLINE 3\nLINE 4\nline 5\n"
        );
    }

    #[test]
    fn dollar_address_delete() {
        let mut bash = env_with_fixtures();
        assert_eq!(
            run(&mut bash, "sed '$ d' /test/numbers.txt").stdout,
            "line 1\nline 2\nline 3\nline 4\n"
        );
        let mut bash2 = env_with_fixtures();
        assert_eq!(
            run(&mut bash2, "sed '$d' /test/numbers.txt").stdout,
            "line 1\nline 2\nline 3\nline 4\n"
        );
    }

    #[test]
    fn multiple_e_expressions() {
        let mut bash = env_with_fixtures();
        let r = run(
            &mut bash,
            "sed -e 's/hello/hi/' -e 's/world/there/' /test/file.txt",
        );
        assert_eq!(r.stdout, "hi there\nhi universe\ngoodbye there\n");
    }

    #[test]
    fn ampersand_replacement() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/test.txt", b"hello\n").unwrap();
        let r = run(&mut bash, "sed 's/hello/[&]/' /test.txt");
        assert_eq!(r.stdout, "[hello]\n");
        let mut bash2 = fresh();
        bash2.fs_mut().write_file("/test.txt", b"world\n").unwrap();
        let r2 = run(&mut bash2, "sed 's/world/&-&-&/' /test.txt");
        assert_eq!(r2.stdout, "world-world-world\n");
    }

    #[test]
    fn in_place_edit() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/t.txt", b"hello world\n")
            .unwrap();
        let r = run(&mut bash, "sed -i 's/hello/hi/' /t.txt");
        assert_eq!(r.stdout, "");
        assert_eq!(r.exit_code, 0);
        assert_eq!(run(&mut bash, "cat /t.txt").stdout, "hi world\n");
    }

    #[test]
    fn quit_command() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/t.txt", b"1\n2\n3\n4\n5\n")
            .unwrap();
        let r = run(&mut bash, "sed '3q' /t.txt");
        assert_eq!(r.stdout, "1\n2\n3\n");
    }

    #[test]
    fn escaped_parens_with_extended_flag() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/t.txt", b"const x = require('foo');\n")
            .unwrap();
        let r = run(
            &mut bash,
            r#"sed -E "s/const x = require\('foo'\);/import x from 'foo';/g" /t.txt"#,
        );
        assert_eq!(r.stdout, "import x from 'foo';\n");
    }

    #[test]
    fn semicolons_in_pattern_and_replacement() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/t.txt", b"a;b;c\n").unwrap();
        let r = run(&mut bash, "sed 's/a;b/x;y/' /t.txt");
        assert_eq!(r.stdout, "x;y;c\n");
    }

    #[test]
    fn pattern_address_delete_and_substitute() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/t.txt", b"foo\nbar\nbaz\n")
            .unwrap();
        assert_eq!(run(&mut bash, "sed '/bar/d' /t.txt").stdout, "foo\nbaz\n");
        let mut bash2 = fresh();
        bash2
            .fs_mut()
            .write_file("/t.txt", b"apple\nbanana\napricot\n")
            .unwrap();
        let r = run(&mut bash2, "sed '/^a/s/a/A/g' /t.txt");
        assert_eq!(r.stdout, "Apple\nbanana\nApricot\n");
    }

    #[test]
    fn read_file_appends_after_line() {
        let mut bash = env_with_fixtures();
        bash.fs_mut()
            .write_file("/test/block.txt", b"INSERTED A\nINSERTED B\n")
            .unwrap();
        let r = run(&mut bash, "sed '2r /test/block.txt' /test/numbers.txt");
        assert_eq!(
            r.stdout,
            "line 1\nline 2\nINSERTED A\nINSERTED B\nline 3\nline 4\nline 5\n"
        );
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    fn read_file_in_place() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/deployment.toml", b"a\nb\nc\n")
            .unwrap();
        bash.fs_mut()
            .write_file("/block.txt", b"[cowsay]\nsay = true\n")
            .unwrap();
        let r = run(&mut bash, "sed -i '2r /block.txt' /deployment.toml");
        assert_eq!(r.stdout, "");
        assert_eq!(r.exit_code, 0);
        assert_eq!(
            run(&mut bash, "cat /deployment.toml").stdout,
            "a\nb\n[cowsay]\nsay = true\nc\n"
        );
    }

    #[test]
    fn read_file_last_line_and_regex_address() {
        let mut bash = env_with_fixtures();
        bash.fs_mut()
            .write_file("/test/tail.txt", b"THE END\n")
            .unwrap();
        assert_eq!(
            run(&mut bash, "sed '$r /test/tail.txt' /test/numbers.txt").stdout,
            "line 1\nline 2\nline 3\nline 4\nline 5\nTHE END\n"
        );
        let mut bash2 = env_with_fixtures();
        bash2
            .fs_mut()
            .write_file("/test/tail.txt", b"MATCHED\n")
            .unwrap();
        assert_eq!(
            run(
                &mut bash2,
                "sed '/line 3/r /test/tail.txt' /test/numbers.txt"
            )
            .stdout,
            "line 1\nline 2\nline 3\nMATCHED\nline 4\nline 5\n"
        );
    }

    #[test]
    fn read_missing_file_is_silent() {
        let mut bash = env_with_fixtures();
        let r = run(&mut bash, "sed '2r /test/nope.txt' /test/numbers.txt");
        assert_eq!(r.stdout, "line 1\nline 2\nline 3\nline 4\nline 5\n");
        assert_eq!(r.stderr, "");
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    fn read_file_not_suppressed_by_n() {
        let mut bash = env_with_fixtures();
        bash.fs_mut()
            .write_file("/test/note.txt", b"NOTE\n")
            .unwrap();
        let r = run(&mut bash, "sed -n '2r /test/note.txt' /test/numbers.txt");
        assert_eq!(r.stdout, "NOTE\n");
    }

    #[test]
    fn nth_occurrence_substitution() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/t.txt", b"foo bar foo baz foo\n")
            .unwrap();
        let r = run(&mut bash, "sed 's/foo/XXX/2' /t.txt");
        assert_eq!(r.stdout, "foo bar XXX baz foo\n");
    }
}
