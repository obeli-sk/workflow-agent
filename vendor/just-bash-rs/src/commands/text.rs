//! PORT: vendor/just-bash/src/commands/{wc,head,tail,cut,tr,printf,basename,dirname}/*.ts
//!
//! The smaller single-purpose text tools, grouped in one file since none of
//! them warrants its own module. All operate on Rust `String`s (already
//! UTF-8), unlike upstream's separate byte/codepoint (latin1 vs UTF-8) modes
//! for binary-safety; the byte-vs-codepoint distinction and its dedicated
//! test suites (`*.binary.test.ts`, `*.utf8-stdin.test.ts`) are out of scope
//! per the design doc.

use std::collections::HashMap;

use super::{fail, normalize_path, ok, read_concat};
use crate::interpreter::{CommandOutput, Interpreter};

// ---------------------------------------------------------------- wc -----

struct WcStats {
    lines: usize,
    words: usize,
    third: usize,
}

fn count_stats(content: &str, count_chars: bool) -> WcStats {
    let third = if count_chars {
        content.chars().count()
    } else {
        content.len()
    };
    let mut lines = 0;
    let mut words = 0;
    let mut in_word = false;
    for c in content.chars() {
        if c == '\n' {
            lines += 1;
            if in_word {
                words += 1;
                in_word = false;
            }
        } else if c == ' ' || c == '\t' || c == '\r' {
            if in_word {
                words += 1;
                in_word = false;
            }
        } else {
            in_word = true;
        }
    }
    if in_word {
        words += 1;
    }
    WcStats {
        lines,
        words,
        third,
    }
}

fn format_stats(
    s: &WcStats,
    show_lines: bool,
    show_words: bool,
    show_third: bool,
    name: &str,
    width: usize,
) -> String {
    let mut parts = Vec::new();
    if show_lines {
        parts.push(format!("{:>width$}", s.lines, width = width));
    }
    if show_words {
        parts.push(format!("{:>width$}", s.words, width = width));
    }
    if show_third {
        parts.push(format!("{:>width$}", s.third, width = width));
    }
    let mut result = parts.join(" ");
    if !name.is_empty() {
        result.push(' ');
        result.push_str(name);
    }
    result
}

pub fn wc(interp: &Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let mut show_lines = false;
    let mut show_words = false;
    let mut show_bytes = false;
    let mut show_chars = false;
    let mut files: Vec<String> = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-l" | "--lines" => show_lines = true,
            "-w" | "--words" => show_words = true,
            "-c" | "--bytes" => show_bytes = true,
            "-m" | "--chars" => show_chars = true,
            _ if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") => {
                for c in arg[1..].chars() {
                    match c {
                        'l' => show_lines = true,
                        'w' => show_words = true,
                        'c' => show_bytes = true,
                        'm' => show_chars = true,
                        _ => {}
                    }
                }
            }
            _ => files.push(arg.clone()),
        }
    }
    if !show_lines && !show_words && !show_bytes && !show_chars {
        show_lines = true;
        show_words = true;
        show_bytes = true;
    }
    let show_third = show_bytes || show_chars;

    if files.is_empty() {
        let s = count_stats(&stdin, show_chars);
        return ok(format!(
            "{}\n",
            format_stats(&s, show_lines, show_words, show_third, "", 0)
        ));
    }

    let mut all: Vec<(String, WcStats)> = Vec::new();
    let mut stderr = String::new();
    let mut exit_code = 0;
    let mut total = WcStats {
        lines: 0,
        words: 0,
        third: 0,
    };
    for file in &files {
        let path = normalize_path(&interp.cwd, file);
        match interp.fs.read_file(&path) {
            Some(bytes) => {
                let content = String::from_utf8_lossy(bytes);
                let s = count_stats(&content, show_chars);
                total.lines += s.lines;
                total.words += s.words;
                total.third += s.third;
                all.push((file.clone(), s));
            }
            None => {
                stderr.push_str(&format!("wc: {file}: No such file or directory\n"));
                exit_code = 1;
            }
        }
    }

    if all.is_empty() {
        return CommandOutput {
            stdout: String::new(),
            stderr,
            exit_code,
        };
    }

    let multi = files.len() > 1;
    let mut width = if multi { 3 } else { 0 };
    let digits = |n: usize| n.to_string().len();
    let max_lines = if multi { total.lines } else { all[0].1.lines };
    let max_words = if multi { total.words } else { all[0].1.words };
    let max_third = if multi { total.third } else { all[0].1.third };
    if show_lines {
        width = width.max(digits(max_lines));
    }
    if show_words {
        width = width.max(digits(max_words));
    }
    if show_third {
        width = width.max(digits(max_third));
    }

    let mut stdout = String::new();
    for (name, stats) in &all {
        stdout.push_str(&format_stats(
            stats, show_lines, show_words, show_third, name, width,
        ));
        stdout.push('\n');
    }
    if multi {
        stdout.push_str(&format_stats(
            &total, show_lines, show_words, show_third, "total", width,
        ));
        stdout.push('\n');
    }
    CommandOutput {
        stdout,
        stderr,
        exit_code,
    }
}

// --------------------------------------------------------- head/tail -----

struct HeadTailOptions {
    lines: i64,
    bytes: Option<i64>,
    quiet: bool,
    verbose: bool,
    files: Vec<String>,
    from_line: bool,
}

fn parse_head_tail_args(args: &[String], is_tail: bool) -> Result<HeadTailOptions, CommandOutput> {
    let cmd = if is_tail { "tail" } else { "head" };
    let mut lines: i64 = 10;
    let mut bytes: Option<i64> = None;
    let mut quiet = false;
    let mut verbose = false;
    let mut from_line = false;
    let mut files = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-n" && i + 1 < args.len() {
            i += 1;
            let next = &args[i];
            if is_tail && let Some(rest) = next.strip_prefix('+') {
                from_line = true;
                lines = rest.parse().unwrap_or(-1);
            } else {
                lines = next.parse().unwrap_or(-1);
            }
        } else if is_tail && let Some(rest) = arg.strip_prefix("-n+") {
            from_line = true;
            lines = rest.parse().unwrap_or(-1);
        } else if let Some(rest) = arg.strip_prefix("-n") {
            lines = rest.parse().unwrap_or(-1);
        } else if arg == "-c" && i + 1 < args.len() {
            i += 1;
            bytes = Some(args[i].parse().unwrap_or(-1));
        } else if let Some(rest) = arg.strip_prefix("-c") {
            bytes = Some(rest.parse().unwrap_or(-1));
        } else if let Some(rest) = arg.strip_prefix("--bytes=") {
            bytes = Some(rest.parse().unwrap_or(-1));
        } else if let Some(rest) = arg.strip_prefix("--lines=") {
            lines = rest.parse().unwrap_or(-1);
        } else if arg == "-q" || arg == "--quiet" || arg == "--silent" {
            quiet = true;
        } else if arg == "-v" || arg == "--verbose" {
            verbose = true;
        } else if arg.len() > 1
            && arg.starts_with('-')
            && arg[1..].chars().all(|c| c.is_ascii_digit())
        {
            lines = arg[1..].parse().unwrap_or(-1);
        } else if arg.starts_with('-') && arg != "-" {
            return Err(fail(format!("{cmd}: unrecognized option '{arg}'\n"), 1));
        } else {
            files.push(arg.clone());
        }
        i += 1;
    }

    if let Some(b) = bytes
        && b < 0
    {
        return Err(fail(format!("{cmd}: invalid number of bytes\n"), 1));
    }
    if lines < 0 {
        return Err(fail(format!("{cmd}: invalid number of lines\n"), 1));
    }
    Ok(HeadTailOptions {
        lines,
        bytes,
        quiet,
        verbose,
        files,
        from_line,
    })
}

fn byte_slice_from(content: &str, end: usize) -> String {
    let bytes = content.as_bytes();
    let end = end.min(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn byte_slice_tail(content: &str, n: usize) -> String {
    let bytes = content.as_bytes();
    let start = bytes.len().saturating_sub(n);
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

fn get_head(content: &str, lines: i64, bytes: Option<i64>) -> String {
    if let Some(b) = bytes {
        return byte_slice_from(content, b.max(0) as usize);
    }
    if lines == 0 {
        return String::new();
    }
    let mut pos = 0usize;
    let mut count = 0i64;
    while pos < content.len() && count < lines {
        match content[pos..].find('\n') {
            None => return content.to_string(),
            Some(off) => {
                count += 1;
                pos += off + 1;
            }
        }
    }
    content[..pos].to_string()
}

fn get_tail(content: &str, lines: i64, bytes: Option<i64>, from_line: bool) -> String {
    if let Some(b) = bytes {
        if b == 0 {
            return String::new();
        }
        return byte_slice_tail(content, b.max(0) as usize);
    }
    if content.is_empty() {
        return String::new();
    }
    if from_line {
        let mut pos = 0usize;
        let mut count = 1i64;
        while pos < content.len() && count < lines {
            match content[pos..].find('\n') {
                None => return String::new(),
                Some(off) => {
                    count += 1;
                    pos += off + 1;
                }
            }
        }
        return content[pos..].to_string();
    }
    if lines == 0 {
        return String::new();
    }
    let b = content.as_bytes();
    let mut pos: isize = b.len() as isize - 1;
    if pos >= 0 && b[pos as usize] == b'\n' {
        pos -= 1;
    }
    let mut count = 0i64;
    while pos >= 0 && count < lines {
        if b[pos as usize] == b'\n' {
            count += 1;
            if count == lines {
                pos += 1;
                break;
            }
        }
        pos -= 1;
    }
    if pos < 0 {
        pos = 0;
    }
    content[pos as usize..].to_string()
}

fn process_head_tail(
    interp: &Interpreter,
    opts: HeadTailOptions,
    stdin: String,
    cmd: &str,
    transform: impl Fn(&str) -> String,
) -> CommandOutput {
    if opts.files.is_empty() {
        return ok(transform(&stdin));
    }
    let show_headers = opts.verbose || (!opts.quiet && opts.files.len() > 1);
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = 0;
    let mut printed = 0;
    for file in &opts.files {
        let path = normalize_path(&interp.cwd, file);
        match interp.fs.read_file(&path) {
            Some(bytes) => {
                let content = String::from_utf8_lossy(bytes);
                if show_headers {
                    if printed > 0 {
                        stdout.push('\n');
                    }
                    stdout.push_str(&format!("==> {file} <==\n"));
                }
                stdout.push_str(&transform(&content));
                printed += 1;
            }
            None => {
                stderr.push_str(&format!("{cmd}: {file}: No such file or directory\n"));
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

pub fn head(interp: &Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let opts = match parse_head_tail_args(args, false) {
        Ok(o) => o,
        Err(e) => return e,
    };
    let (lines, bytes) = (opts.lines, opts.bytes);
    process_head_tail(interp, opts, stdin, "head", move |c| {
        get_head(c, lines, bytes)
    })
}

pub fn tail(interp: &Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let opts = match parse_head_tail_args(args, true) {
        Ok(o) => o,
        Err(e) => return e,
    };
    let (lines, bytes, from_line) = (opts.lines, opts.bytes, opts.from_line);
    process_head_tail(interp, opts, stdin, "tail", move |c| {
        get_tail(c, lines, bytes, from_line)
    })
}

// --------------------------------------------------------------- cut -----

struct CutRange {
    start: usize,
    end: Option<usize>,
}

fn parse_cut_ranges(spec: &str) -> Result<Vec<CutRange>, String> {
    let mut ranges = Vec::new();
    for part in spec.split(',') {
        if let Some(dash) = part.find('-') {
            let (s, e) = (&part[..dash], &part[dash + 1..]);
            let start = if s.is_empty() {
                1
            } else {
                s.parse::<usize>().map_err(|_| "cut: invalid range")?
            };
            let end = if e.is_empty() {
                None
            } else {
                Some(e.parse::<usize>().map_err(|_| "cut: invalid range")?)
            };
            if start < 1 || matches!(end, Some(e) if e < start) {
                return Err("cut: invalid range".to_string());
            }
            ranges.push(CutRange { start, end });
        } else {
            let n: usize = part.parse().map_err(|_| "cut: invalid range")?;
            if n < 1 {
                return Err("cut: invalid range".to_string());
            }
            ranges.push(CutRange {
                start: n,
                end: Some(n),
            });
        }
    }
    Ok(ranges)
}

pub fn cut(interp: &Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let mut delimiter = "\t".to_string();
    let mut field_spec: Option<String> = None;
    let mut char_spec: Option<String> = None;
    let mut suppress = false;
    let mut files: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-d" {
            i += 1;
            delimiter = args.get(i).cloned().unwrap_or_else(|| "\t".into());
        } else if let Some(rest) = arg.strip_prefix("-d") {
            delimiter = rest.to_string();
        } else if arg == "-f" {
            i += 1;
            field_spec = args.get(i).cloned();
        } else if let Some(rest) = arg.strip_prefix("-f") {
            field_spec = Some(rest.to_string());
        } else if arg == "-c" {
            i += 1;
            char_spec = args.get(i).cloned();
        } else if let Some(rest) = arg.strip_prefix("-c") {
            char_spec = Some(rest.to_string());
        } else if arg == "-s" || arg == "--only-delimited" {
            suppress = true;
        } else if arg.starts_with("--") {
            return fail(format!("cut: unrecognized option '{arg}'\n"), 1);
        } else if arg.starts_with('-') && arg.len() > 1 {
            for c in arg[1..].chars() {
                if c == 's' {
                    suppress = true;
                } else if !"dfc".contains(c) {
                    return fail(format!("cut: unrecognized option '-{c}'\n"), 1);
                }
            }
        } else {
            files.push(arg.clone());
        }
        i += 1;
    }

    if field_spec.is_none() && char_spec.is_none() {
        return fail(
            "cut: you must specify a list of bytes, characters, or fields\n".to_string(),
            1,
        );
    }

    let content = match read_concat(interp, &files, "cut", &stdin) {
        Ok(c) => c,
        Err(e) => return e,
    };

    let mut lines: Vec<&str> = content.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }

    let spec = field_spec
        .as_deref()
        .or(char_spec.as_deref())
        .unwrap_or("1");
    let ranges = match parse_cut_ranges(spec) {
        Ok(r) => r,
        Err(e) => return fail(format!("{e}\n"), 1),
    };

    let mut out = String::new();
    for line in lines {
        if char_spec.is_some() {
            let chars: Vec<char> = line.chars().collect();
            let mut selected = String::new();
            for r in &ranges {
                let start = r.start - 1;
                let end = r.end.unwrap_or(chars.len()).min(chars.len());
                for c in chars.iter().take(end).skip(start) {
                    selected.push(*c);
                }
            }
            out.push_str(&selected);
            out.push('\n');
        } else {
            if suppress && !line.contains(delimiter.as_str()) {
                continue;
            }
            let fields: Vec<&str> = line.split(delimiter.as_str()).collect();
            let mut seen = std::collections::BTreeSet::new();
            let mut selected: Vec<&str> = Vec::new();
            for r in &ranges {
                let start = r.start - 1;
                let end = r.end.unwrap_or(fields.len()).min(fields.len());
                for (idx, f) in fields.iter().enumerate().take(end).skip(start) {
                    if seen.insert(idx) {
                        selected.push(f);
                    }
                }
            }
            out.push_str(&selected.join(&delimiter));
            out.push('\n');
        }
    }
    ok(out)
}

// ---------------------------------------------------------------- tr -----

fn posix_class(name: &str) -> Option<Vec<char>> {
    Some(match name {
        "alnum" => ('0'..='9').chain('A'..='Z').chain('a'..='z').collect(),
        "alpha" => ('A'..='Z').chain('a'..='z').collect(),
        "blank" => vec![' ', '\t'],
        "cntrl" => (0u8..32)
            .chain(std::iter::once(127u8))
            .map(|b| b as char)
            .collect(),
        "digit" => ('0'..='9').collect(),
        "graph" => (33u8..=126).map(|b| b as char).collect(),
        "lower" => ('a'..='z').collect(),
        "print" => (32u8..=126).map(|b| b as char).collect(),
        "punct" => "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~".chars().collect(),
        "space" => vec![' ', '\t', '\n', '\r', '\x0c', '\x0b'],
        "upper" => ('A'..='Z').collect(),
        "xdigit" => "0123456789ABCDEFabcdef".chars().collect(),
        _ => return None,
    })
}

/// Expand a `tr` SET operand: POSIX classes (`[:alpha:]`), `\n`/`\t`/`\r`
/// escapes (any other escaped char is literal), `a-z` ranges, else literal
/// chars.
fn expand_set(spec: &str) -> Vec<char> {
    let chars: Vec<char> = spec.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '['
            && chars.get(i + 1) == Some(&':')
            && let Some(end_rel) = chars[i..].windows(2).position(|w| w == [':', ']'])
        {
            let class_name: String = chars[i + 2..i + end_rel].iter().collect();
            if let Some(mut expanded) = posix_class(&class_name) {
                out.append(&mut expanded);
                i += end_rel + 2;
                continue;
            }
        }
        if chars[i] == '\\' && i + 1 < chars.len() {
            let next = chars[i + 1];
            out.push(match next {
                'n' => '\n',
                't' => '\t',
                'r' => '\r',
                other => other,
            });
            i += 2;
            continue;
        }
        if i + 2 < chars.len() && chars[i + 1] == '-' {
            let start = chars[i] as u32;
            let end = chars[i + 2] as u32;
            if end >= start {
                for code in start..=end {
                    if let Some(c) = char::from_u32(code) {
                        out.push(c);
                    }
                }
            }
            i += 3;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

pub fn tr(args: &[String], stdin: String) -> CommandOutput {
    let mut complement = false;
    let mut delete = false;
    let mut squeeze = false;
    let mut sets: Vec<String> = Vec::new();
    for arg in args {
        if arg == "-c" || arg == "-C" || arg == "--complement" {
            complement = true;
        } else if arg == "-d" || arg == "--delete" {
            delete = true;
        } else if arg == "-s" || arg == "--squeeze-repeats" {
            squeeze = true;
        } else if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") {
            for c in arg[1..].chars() {
                match c {
                    'c' | 'C' => complement = true,
                    'd' => delete = true,
                    's' => squeeze = true,
                    _ => {}
                }
            }
        } else {
            sets.push(arg.clone());
        }
    }
    if sets.is_empty() {
        return fail("tr: missing operand\n".to_string(), 1);
    }
    if !delete && !squeeze && sets.len() < 2 {
        return fail("tr: missing operand after SET1\n".to_string(), 1);
    }

    let set1_raw = expand_set(&sets[0]);
    let set2 = if sets.len() > 1 {
        expand_set(&sets[1])
    } else {
        Vec::new()
    };
    let set1: std::collections::HashSet<char> = set1_raw.iter().copied().collect();

    let mut output = String::new();
    if delete {
        for c in stdin.chars() {
            let in_set1 = set1.contains(&c) != complement;
            if !in_set1 {
                output.push(c);
            }
        }
    } else if squeeze && sets.len() == 1 {
        let mut prev: Option<char> = None;
        for c in stdin.chars() {
            let in_set1 = set1.contains(&c) != complement;
            if in_set1 && Some(c) == prev {
                continue;
            }
            output.push(c);
            prev = Some(c);
        }
    } else {
        let set2_chars: std::collections::HashSet<char> = set2.iter().copied().collect();
        let mut prev: Option<char> = None;
        if complement {
            let target = *set2.last().unwrap_or(&'\0');
            for c in stdin.chars() {
                let out_c = if set1.contains(&c) { c } else { target };
                if squeeze && set2_chars.contains(&out_c) && Some(out_c) == prev {
                    continue;
                }
                output.push(out_c);
                prev = Some(out_c);
            }
        } else {
            let mut map: HashMap<char, char> = HashMap::new();
            let last2 = *set2.last().unwrap_or(&'\0');
            for (idx, &c1) in set1_raw.iter().enumerate() {
                let target = set2.get(idx).copied().unwrap_or(last2);
                map.insert(c1, target);
            }
            for c in stdin.chars() {
                let out_c = map.get(&c).copied().unwrap_or(c);
                if squeeze && set2_chars.contains(&out_c) && Some(out_c) == prev {
                    continue;
                }
                output.push(out_c);
                prev = Some(out_c);
            }
        }
    }
    ok(output)
}

// ------------------------------------------------------------ printf -----

fn process_escapes(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            let next = chars[i + 1];
            match next {
                'n' => {
                    out.push('\n');
                    i += 2;
                }
                't' => {
                    out.push('\t');
                    i += 2;
                }
                'r' => {
                    out.push('\r');
                    i += 2;
                }
                '\\' => {
                    out.push('\\');
                    i += 2;
                }
                '"' | '\'' | '?' => {
                    out.push(next);
                    i += 2;
                }
                'a' => {
                    out.push('\x07');
                    i += 2;
                }
                'b' => {
                    out.push('\x08');
                    i += 2;
                }
                'f' => {
                    out.push('\x0c');
                    i += 2;
                }
                'v' => {
                    out.push('\x0b');
                    i += 2;
                }
                'e' | 'E' => {
                    out.push('\x1b');
                    i += 2;
                }
                '0'..='7' => {
                    let mut j = i + 1;
                    let mut octal = String::new();
                    while j < chars.len() && j < i + 4 && ('0'..='7').contains(&chars[j]) {
                        octal.push(chars[j]);
                        j += 1;
                    }
                    let code = u32::from_str_radix(&octal, 8).unwrap_or(0);
                    out.push(char::from_u32(code).unwrap_or('\0'));
                    i = j;
                }
                'x' => {
                    let (val, j) = read_hex_escape(&chars, i + 2, 2);
                    match val {
                        Some(code) => {
                            out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                            i = j;
                        }
                        None => {
                            out.push_str("\\x");
                            i += 2;
                        }
                    }
                }
                'u' => {
                    let (val, j) = read_hex_escape(&chars, i + 2, 4);
                    match val {
                        Some(code) => {
                            out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                            i = j;
                        }
                        None => {
                            out.push_str("\\u");
                            i += 2;
                        }
                    }
                }
                'U' => {
                    let (val, j) = read_hex_escape(&chars, i + 2, 8);
                    match val {
                        Some(code) => {
                            out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                            i = j;
                        }
                        None => {
                            out.push_str("\\U");
                            i += 2;
                        }
                    }
                }
                _ => {
                    out.push(chars[i]);
                    i += 1;
                }
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

fn read_hex_escape(chars: &[char], start: usize, max_digits: usize) -> (Option<u32>, usize) {
    let mut j = start;
    let mut hex = String::new();
    while j < chars.len() && j < start + max_digits && chars[j].is_ascii_hexdigit() {
        hex.push(chars[j]);
        j += 1;
    }
    if hex.is_empty() {
        (None, start)
    } else {
        (u32::from_str_radix(&hex, 16).ok(), j)
    }
}

/// `%b`'s escape processing: like `process_escapes` but `\c` stops all
/// further output (signalled via the returned bool).
fn process_b_escapes(s: &str) -> (String, bool) {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            let next = chars[i + 1];
            match next {
                'n' => {
                    out.push('\n');
                    i += 2;
                }
                't' => {
                    out.push('\t');
                    i += 2;
                }
                'r' => {
                    out.push('\r');
                    i += 2;
                }
                '\\' => {
                    out.push('\\');
                    i += 2;
                }
                'a' => {
                    out.push('\x07');
                    i += 2;
                }
                'b' => {
                    out.push('\x08');
                    i += 2;
                }
                'f' => {
                    out.push('\x0c');
                    i += 2;
                }
                'v' => {
                    out.push('\x0b');
                    i += 2;
                }
                'c' => return (out, true),
                '0'..='7' => {
                    let mut j = i + 1;
                    let mut octal = String::new();
                    while j < chars.len() && j < i + 4 && ('0'..='7').contains(&chars[j]) {
                        octal.push(chars[j]);
                        j += 1;
                    }
                    let code = u32::from_str_radix(&octal, 8).unwrap_or(0);
                    out.push(char::from_u32(code).unwrap_or('\0'));
                    i = j;
                }
                'x' => {
                    let (val, j) = read_hex_escape(&chars, i + 2, 2);
                    match val {
                        Some(code) => {
                            out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                            i = j;
                        }
                        None => {
                            out.push_str("\\x");
                            i += 2;
                        }
                    }
                }
                _ => {
                    out.push(chars[i]);
                    i += 1;
                }
            }
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    (out, false)
}

struct SpecParts {
    flags: String,
    width: usize,
    precision: Option<usize>,
}

/// Parse the flags/width/precision out of a captured `%...X` spec (`inner`
/// excludes the leading `%` and trailing conversion character).
fn parse_spec(spec: &str) -> SpecParts {
    let inner = &spec[1..spec.len() - 1];
    let mut chars = inner.chars().peekable();
    let mut flags = String::new();
    while let Some(&c) = chars.peek() {
        if "+-0 #'".contains(c) {
            flags.push(c);
            chars.next();
        } else {
            break;
        }
    }
    let mut width_str = String::new();
    while let Some(&c) = chars.peek() {
        if c.is_ascii_digit() {
            width_str.push(c);
            chars.next();
        } else {
            break;
        }
    }
    let mut precision = None;
    if chars.peek() == Some(&'.') {
        chars.next();
        let mut p = String::new();
        while let Some(&c) = chars.peek() {
            if c.is_ascii_digit() {
                p.push(c);
                chars.next();
            } else {
                break;
            }
        }
        precision = Some(p.parse().unwrap_or(0));
    }
    SpecParts {
        flags,
        width: width_str.parse().unwrap_or(0),
        precision,
    }
}

fn parse_int_arg(arg: &str) -> (i64, bool) {
    let trimmed_start = arg.trim_start();
    let has_trailing_ws = trimmed_start != trimmed_start.trim_end();
    let s = trimmed_start.trim_end();
    let s_chars: Vec<char> = s.chars().collect();
    if (s.starts_with('\'') || s.starts_with('"')) && s_chars.len() >= 2 {
        return (s_chars[1] as i64, false);
    }
    let s = s.strip_prefix('+').unwrap_or(s);
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        return match i64::from_str_radix(hex, 16) {
            Ok(n) => (n, has_trailing_ws),
            Err(_) => (0, true),
        };
    }
    if s.len() > 1 && s.starts_with('0') && s[1..].chars().all(|c| ('0'..='7').contains(&c)) {
        return (
            i64::from_str_radix(&s[1..], 8).unwrap_or(0),
            has_trailing_ws,
        );
    }
    if s.is_empty() {
        return (0, has_trailing_ws);
    }
    match s.parse::<i64>() {
        Ok(n) => (n, has_trailing_ws),
        Err(_) => {
            let bytes = s.as_bytes();
            let neg = bytes.first() == Some(&b'-');
            let start = if neg { 1 } else { 0 };
            let mut end = start;
            while end < bytes.len() && bytes[end].is_ascii_digit() {
                end += 1;
            }
            if end > start {
                (s[..end].parse().unwrap_or(0), true)
            } else {
                (0, true)
            }
        }
    }
}

fn format_integer(spec: &str, num: i64) -> String {
    let parts = parse_spec(spec);
    let negative = num < 0;
    let mut num_str = num.unsigned_abs().to_string();
    if let Some(p) = parts.precision {
        while num_str.len() < p {
            num_str.insert(0, '0');
        }
    }
    let sign = if negative {
        "-"
    } else if parts.flags.contains('+') {
        "+"
    } else if parts.flags.contains(' ') {
        " "
    } else {
        ""
    };
    let mut result = format!("{sign}{num_str}");
    if parts.width > result.chars().count() {
        if parts.flags.contains('-') {
            result = format!("{result:<width$}", width = parts.width);
        } else if parts.flags.contains('0') && parts.precision.is_none() {
            let pad = parts.width - sign.len() - num_str.len();
            result = format!("{sign}{}{num_str}", "0".repeat(pad));
        } else {
            result = format!("{result:>width$}", width = parts.width);
        }
    }
    result
}

fn format_octal(spec: &str, num: i64) -> String {
    let parts = parse_spec(spec);
    let mut num_str = format!("{:o}", num.unsigned_abs());
    if let Some(p) = parts.precision {
        while num_str.len() < p {
            num_str.insert(0, '0');
        }
    }
    if parts.flags.contains('#') && !num_str.starts_with('0') {
        num_str.insert(0, '0');
    }
    let mut result = num_str.clone();
    if parts.width > result.chars().count() {
        if parts.flags.contains('-') {
            result = format!("{result:<width$}", width = parts.width);
        } else if parts.flags.contains('0') && parts.precision.is_none() {
            result = format!("{result:0>width$}", width = parts.width);
        } else {
            result = format!("{result:>width$}", width = parts.width);
        }
    }
    result
}

fn format_hex(spec: &str, num: i64) -> String {
    let is_upper = spec.contains('X');
    let parts = parse_spec(spec);
    let mut num_str = if is_upper {
        format!("{:X}", num.unsigned_abs())
    } else {
        format!("{:x}", num.unsigned_abs())
    };
    if let Some(p) = parts.precision {
        while num_str.len() < p {
            num_str.insert(0, '0');
        }
    }
    let prefix = if parts.flags.contains('#') && num != 0 {
        if is_upper { "0X" } else { "0x" }
    } else {
        ""
    };
    let mut result = format!("{prefix}{num_str}");
    if parts.width > result.chars().count() {
        if parts.flags.contains('-') {
            result = format!("{result:<width$}", width = parts.width);
        } else if parts.flags.contains('0') && parts.precision.is_none() {
            let pad = parts.width - prefix.len() - num_str.len();
            result = format!("{prefix}{}{num_str}", "0".repeat(pad));
        } else {
            result = format!("{result:>width$}", width = parts.width);
        }
    }
    result
}

/// `%e/%E/%f/%F/%g/%G`. Only `%f` is exercised by upstream's test suite; the
/// exponential/general forms are a best-effort (Rust's `{:e}` formatting
/// doesn't match C's `e+NN` shape), documented as a simplification.
fn format_float(spec: &str, specifier: char, num: f64) -> String {
    let parts = parse_spec(spec);
    let precision = parts.precision.unwrap_or(6);
    let lower = specifier.to_ascii_lowercase();
    let mut result = match lower {
        'f' => {
            let mut s = format!("{num:.precision$}");
            if parts.flags.contains('#') && precision == 0 && !s.contains('.') {
                s.push('.');
            }
            s
        }
        'e' => format!("{num:.precision$e}"),
        _ => format!("{num}"),
    };
    if specifier.is_ascii_uppercase() {
        result = result.to_uppercase();
    }
    if num >= 0.0 {
        if parts.flags.contains('+') {
            result = format!("+{result}");
        } else if parts.flags.contains(' ') {
            result = format!(" {result}");
        }
    }
    if parts.width > result.chars().count() {
        result = if parts.flags.contains('-') {
            format!("{result:<width$}", width = parts.width)
        } else if parts.flags.contains('0') {
            format!("{result:0>width$}", width = parts.width)
        } else {
            format!("{result:>width$}", width = parts.width)
        };
    }
    result
}

fn format_string(spec: &str, s: &str) -> String {
    let parts = parse_spec(spec);
    let mut result = s.to_string();
    if let Some(p) = parts.precision {
        result = result.chars().take(p).collect();
    }
    if parts.width > result.chars().count() {
        result = if parts.flags.contains('-') {
            format!("{result:<width$}", width = parts.width)
        } else {
            format!("{result:>width$}", width = parts.width)
        };
    }
    result
}

fn format_quoted(s: &str) -> String {
    if s.is_empty() {
        return "''".to_string();
    }
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "_./-".contains(c))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

struct FormatResult {
    text: String,
    args_consumed: usize,
    error: bool,
    err_msg: String,
    stopped: bool,
}

fn format_value(spec: &str, specifier: char, arg: &str) -> (String, bool, String, bool) {
    match specifier {
        'd' | 'i' => {
            let (num, err) = parse_int_arg(arg);
            (
                format_integer(spec, num),
                err,
                if err {
                    format!("printf: {arg}: invalid number\n")
                } else {
                    String::new()
                },
                false,
            )
        }
        'o' => {
            let (num, err) = parse_int_arg(arg);
            (
                format_octal(spec, num),
                err,
                if err {
                    format!("printf: {arg}: invalid number\n")
                } else {
                    String::new()
                },
                false,
            )
        }
        'u' => {
            let (num, err) = parse_int_arg(arg);
            let unsigned = if num < 0 {
                (num as i32 as u32) as i64
            } else {
                num
            };
            let spec_d = spec.replace('u', "d");
            (
                format_integer(&spec_d, unsigned),
                err,
                if err {
                    format!("printf: {arg}: invalid number\n")
                } else {
                    String::new()
                },
                false,
            )
        }
        'x' | 'X' => {
            let (num, err) = parse_int_arg(arg);
            (
                format_hex(spec, num),
                err,
                if err {
                    format!("printf: {arg}: invalid number\n")
                } else {
                    String::new()
                },
                false,
            )
        }
        'e' | 'E' | 'f' | 'F' | 'g' | 'G' => {
            let num: f64 = arg.parse().unwrap_or(0.0);
            (
                format_float(spec, specifier, num),
                false,
                String::new(),
                false,
            )
        }
        'c' => {
            if arg.is_empty() {
                (String::new(), false, String::new(), false)
            } else {
                let byte = arg.as_bytes()[0];
                (String::from(byte as char), false, String::new(), false)
            }
        }
        's' => (format_string(spec, arg), false, String::new(), false),
        'q' => (format_quoted(arg), false, String::new(), false),
        'b' => {
            let (val, stopped) = process_b_escapes(arg);
            (val, false, String::new(), stopped)
        }
        _ => (spec.to_string(), false, String::new(), false),
    }
}

fn format_once(format: &str, args: &[String], arg_pos: usize) -> FormatResult {
    let chars: Vec<char> = format.chars().collect();
    let mut i = 0;
    let mut result = String::new();
    let mut consumed = 0usize;
    let mut error = false;
    let mut err_msg = String::new();
    while i < chars.len() {
        if chars[i] == '%' && i + 1 < chars.len() {
            let spec_start = i;
            i += 1;
            if chars[i] == '%' {
                result.push('%');
                i += 1;
                continue;
            }
            while i < chars.len() && "+-0 #'".contains(chars[i]) {
                i += 1;
            }
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if i < chars.len() && chars[i] == '.' {
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            if i < chars.len() && "hlL".contains(chars[i]) {
                i += 1;
            }
            let specifier = if i < chars.len() { chars[i] } else { '\0' };
            i += 1;
            let spec: String = chars[spec_start..i].iter().collect();
            let arg = args.get(arg_pos + consumed).cloned().unwrap_or_default();
            consumed += 1;
            let (value, spec_error, spec_err_msg, stopped) = format_value(&spec, specifier, &arg);
            result.push_str(&value);
            if spec_error {
                error = true;
                if !spec_err_msg.is_empty() {
                    err_msg = spec_err_msg;
                }
            }
            if stopped {
                return FormatResult {
                    text: result,
                    args_consumed: consumed,
                    error,
                    err_msg,
                    stopped: true,
                };
            }
        } else {
            result.push(chars[i]);
            i += 1;
        }
    }
    FormatResult {
        text: result,
        args_consumed: consumed,
        error,
        err_msg,
        stopped: false,
    }
}

fn is_valid_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// PORT: printf.ts. Supports `%s %d %i %o %u %x %X %c %b %q` and
/// `%e/%E/%f/%F/%g/%G` (only `%f` is exercised upstream), flags `+-0 #`,
/// width/precision digits (not `*`-from-arg), escape processing including
/// `\xHH`/`\uHHHH`/`\UHHHHHHHH`, argument-reuse looping, and `-v NAME`
/// (assigns a shell variable directly; array-subscript targets like
/// `arr[0]` are rejected as "not a valid identifier" since this port has no
/// arrays, matching upstream's own rejection tests but not its array-accept
/// tests). Not ported: `*` width/precision from args, `%(fmt)T` strftime.
pub fn printf(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    if args.is_empty() {
        return fail("printf: usage: printf format [arguments]\n".to_string(), 2);
    }
    let mut target_var: Option<String> = None;
    let mut idx = 0;
    while idx < args.len() {
        let arg = &args[idx];
        if arg == "--" {
            idx += 1;
            break;
        }
        if arg == "-v" {
            if idx + 1 >= args.len() {
                return fail("printf: -v: option requires an argument\n".to_string(), 1);
            }
            let name = args[idx + 1].clone();
            if !is_valid_identifier(&name) {
                return fail(format!("printf: `{name}': not a valid identifier\n"), 2);
            }
            target_var = Some(name);
            idx += 2;
        } else {
            break;
        }
    }
    if idx >= args.len() {
        return fail("printf: usage: printf format [arguments]\n".to_string(), 1);
    }
    let format = &args[idx];
    let format_args = args[idx + 1..].to_vec();

    let processed_format = process_escapes(format);
    let mut output = String::new();
    let mut arg_pos = 0usize;
    let mut had_error = false;
    let mut error_message = String::new();
    loop {
        let r = format_once(&processed_format, &format_args, arg_pos);
        output.push_str(&r.text);
        arg_pos += r.args_consumed;
        if r.error {
            had_error = true;
            if !r.err_msg.is_empty() {
                error_message = r.err_msg;
            }
        }
        if r.stopped || !(arg_pos < format_args.len() && arg_pos > 0) {
            break;
        }
    }

    let exit_code = if had_error { 1 } else { 0 };
    if let Some(name) = target_var {
        interp.env.insert(name, output);
        return CommandOutput {
            stdout: String::new(),
            stderr: error_message,
            exit_code,
        };
    }
    CommandOutput {
        stdout: output,
        stderr: error_message,
        exit_code,
    }
}

// ------------------------------------------------------ basename/dirname --

pub fn basename(args: &[String]) -> CommandOutput {
    let mut multiple = false;
    let mut suffix = String::new();
    let mut names: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "-a" || arg == "--multiple" {
            multiple = true;
        } else if arg == "-s" && i + 1 < args.len() {
            i += 1;
            suffix = args[i].clone();
            multiple = true;
        } else if let Some(rest) = arg.strip_prefix("--suffix=") {
            suffix = rest.to_string();
            multiple = true;
        } else if !arg.starts_with('-') {
            names.push(arg.clone());
        }
        i += 1;
    }
    if names.is_empty() {
        return fail("basename: missing operand\n".to_string(), 1);
    }
    if !multiple && names.len() >= 2 {
        suffix = names.pop().unwrap();
    }
    let mut results = Vec::new();
    for name in &names {
        let clean = name.trim_end_matches('/');
        let mut base = clean.rsplit('/').next().unwrap_or("").to_string();
        if !suffix.is_empty() && base.ends_with(suffix.as_str()) {
            base.truncate(base.len() - suffix.len());
        }
        results.push(base);
    }
    ok(format!("{}\n", results.join("\n")))
}

pub fn dirname(args: &[String]) -> CommandOutput {
    let names: Vec<&String> = args.iter().filter(|a| !a.starts_with('-')).collect();
    if names.is_empty() {
        return fail("dirname: missing operand\n".to_string(), 1);
    }
    let mut results = Vec::new();
    for name in names {
        let clean = name.trim_end_matches('/');
        match clean.rfind('/') {
            None => results.push(".".to_string()),
            Some(0) => results.push("/".to_string()),
            Some(idx) => results.push(clean[..idx].to_string()),
        }
    }
    ok(format!("{}\n", results.join("\n")))
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

    mod wc_tests {
        use super::*;

        #[test]
        fn counts_lines_words_bytes() {
            let mut bash = fresh();
            bash.fs_mut()
                .write_file("/test.txt", b"hello world\nfoo bar\n")
                .unwrap();
            let r = run(&mut bash, "wc /test.txt");
            assert!(r.stdout.contains('2'));
            assert!(r.stdout.contains('4'));
            assert!(r.stdout.contains("20"));
        }

        #[test]
        fn dash_l_only_lines() {
            let mut bash = fresh();
            bash.fs_mut().write_file("/test.txt", b"a\nb\nc\n").unwrap();
            let r = run(&mut bash, "wc -l /test.txt");
            assert_eq!(r.stdout.trim(), "3 /test.txt");
        }

        #[test]
        fn multiple_files_show_total() {
            let mut bash = fresh();
            bash.fs_mut().write_file("/a.txt", b"one\n").unwrap();
            bash.fs_mut().write_file("/b.txt", b"two\n").unwrap();
            let r = run(&mut bash, "wc /a.txt /b.txt");
            assert!(r.stdout.contains("/a.txt"));
            assert!(r.stdout.contains("/b.txt"));
            assert!(r.stdout.contains("total"));
        }

        #[test]
        fn reads_stdin() {
            let mut bash = fresh();
            let r = run(&mut bash, "echo \"hello world\" | wc -w");
            assert_eq!(r.stdout.trim(), "2");
        }

        #[test]
        fn missing_file_errors() {
            let mut bash = fresh();
            let r = run(&mut bash, "wc /missing.txt");
            assert_eq!(r.exit_code, 1);
            assert!(r.stderr.contains("No such file or directory"));
        }
    }

    mod head_tests {
        use super::*;

        #[test]
        fn default_first_ten_lines() {
            let mut bash = fresh();
            let lines = (1..=20)
                .map(|i| format!("line{i}"))
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            bash.fs_mut()
                .write_file("/test.txt", lines.as_bytes())
                .unwrap();
            let r = run(&mut bash, "head /test.txt");
            assert_eq!(
                r.stdout,
                "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n"
            );
        }

        #[test]
        fn dash_n_attached_and_spaced() {
            let mut bash = fresh();
            bash.fs_mut()
                .write_file("/test.txt", b"a\nb\nc\nd\ne\n")
                .unwrap();
            assert_eq!(run(&mut bash, "head -n 3 /test.txt").stdout, "a\nb\nc\n");
            assert_eq!(run(&mut bash, "head -n3 /test.txt").stdout, "a\nb\nc\n");
            assert_eq!(run(&mut bash, "head -2 /test.txt").stdout, "a\nb\n");
        }

        #[test]
        fn headers_for_multiple_files() {
            let mut bash = fresh();
            bash.fs_mut().write_file("/a.txt", b"aaa\n").unwrap();
            bash.fs_mut().write_file("/b.txt", b"bbb\n").unwrap();
            let r = run(&mut bash, "head /a.txt /b.txt");
            assert_eq!(r.stdout, "==> /a.txt <==\naaa\n\n==> /b.txt <==\nbbb\n");
        }

        #[test]
        fn missing_file_error() {
            let mut bash = fresh();
            let r = run(&mut bash, "head /missing.txt");
            assert_eq!(r.exit_code, 1);
            assert_eq!(r.stderr, "head: /missing.txt: No such file or directory\n");
        }

        #[test]
        fn reads_stdin() {
            let mut bash = fresh();
            let r = run(&mut bash, r#"printf 'a\nb\nc\nd\ne\n' | head -n 2"#);
            assert_eq!(r.stdout, "a\nb\n");
        }
    }

    mod tail_tests {
        use super::*;

        #[test]
        fn default_last_ten_lines() {
            let mut bash = fresh();
            let lines = (1..=20)
                .map(|i| format!("line{i}"))
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            bash.fs_mut()
                .write_file("/test.txt", lines.as_bytes())
                .unwrap();
            let r = run(&mut bash, "tail /test.txt");
            assert_eq!(
                r.stdout,
                "line11\nline12\nline13\nline14\nline15\nline16\nline17\nline18\nline19\nline20\n"
            );
        }

        #[test]
        fn dash_n_variants() {
            let mut bash = fresh();
            bash.fs_mut()
                .write_file("/test.txt", b"a\nb\nc\nd\ne\n")
                .unwrap();
            assert_eq!(run(&mut bash, "tail -n 2 /test.txt").stdout, "d\ne\n");
            assert_eq!(run(&mut bash, "tail -n2 /test.txt").stdout, "d\ne\n");
            assert_eq!(run(&mut bash, "tail -3 /test.txt").stdout, "c\nd\ne\n");
        }

        #[test]
        fn from_line_plus_n() {
            let mut bash = fresh();
            bash.fs_mut()
                .write_file("/test.txt", b"line1\nline2\nline3\nline4\nline5\n")
                .unwrap();
            assert_eq!(
                run(&mut bash, "tail -n +3 /test.txt").stdout,
                "line3\nline4\nline5\n"
            );
            let mut bash2 = fresh();
            bash2
                .fs_mut()
                .write_file("/test.txt", b"line1\nline2\n")
                .unwrap();
            assert_eq!(run(&mut bash2, "tail -n +10 /test.txt").stdout, "");
        }

        #[test]
        fn preserves_unterminated_final_line() {
            let mut bash = fresh();
            bash.fs_mut()
                .write_file("/test.txt", b"first\nlast")
                .unwrap();
            assert_eq!(run(&mut bash, "tail -n 1 /test.txt").stdout, "last");
        }

        #[test]
        fn zero_bytes_is_empty() {
            let mut bash = fresh();
            bash.fs_mut().write_file("/test.txt", b"content").unwrap();
            assert_eq!(run(&mut bash, "tail -c 0 /test.txt").stdout, "");
        }

        #[test]
        fn combine_with_head_via_pipe() {
            let mut bash = fresh();
            bash.fs_mut()
                .write_file("/test.txt", b"line1\nline2\nline3\nline4\nline5\n")
                .unwrap();
            let r = run(&mut bash, "cat /test.txt | head -n 3 | tail -n 1");
            assert_eq!(r.stdout, "line3\n");
        }
    }

    mod cut_tests {
        use super::*;

        fn env_with_passwd() -> Bash {
            let mut bash = fresh();
            bash.fs_mut()
                .write_file(
                    "/test/passwd.txt",
                    b"root:x:0:0:root:/root:/bin/bash\nuser:x:1000:1000:User:/home/user:/bin/zsh\n",
                )
                .unwrap();
            bash
        }

        #[test]
        fn first_field_colon_delimiter() {
            let mut bash = env_with_passwd();
            let r = run(&mut bash, "cut -d: -f1 /test/passwd.txt");
            assert_eq!(r.stdout, "root\nuser\n");
        }

        #[test]
        fn multiple_and_range_fields() {
            let mut bash = env_with_passwd();
            assert_eq!(
                run(&mut bash, "cut -d: -f1,3 /test/passwd.txt").stdout,
                "root:0\nuser:1000\n"
            );
            assert_eq!(
                run(&mut bash, "cut -d: -f1-3 /test/passwd.txt").stdout,
                "root:x:0\nuser:x:1000\n"
            );
            assert_eq!(
                run(&mut bash, "cut -d: -f5- /test/passwd.txt").stdout,
                "root:/root:/bin/bash\nUser:/home/user:/bin/zsh\n"
            );
        }

        #[test]
        fn duplicate_fields_selected_by_source_position() {
            let mut bash = fresh();
            bash.fs_mut()
                .write_file("/duplicates", b"same:same:last\n")
                .unwrap();
            let r = run(&mut bash, "cut -d: -f1,2 /duplicates");
            assert_eq!(r.stdout, "same:same\n");
        }

        #[test]
        fn char_mode() {
            let mut bash = fresh();
            bash.fs_mut()
                .write_file("/test/text.txt", b"hello world\nabcdefghij\n")
                .unwrap();
            assert_eq!(
                run(&mut bash, "cut -c1-5 /test/text.txt").stdout,
                "hello\nabcde\n"
            );
            assert_eq!(
                run(&mut bash, "cut -c1,3,5 /test/text.txt").stdout,
                "hlo\nace\n"
            );
        }

        #[test]
        fn default_tab_delimiter() {
            let mut bash = fresh();
            bash.fs_mut()
                .write_file("/test/tabs.txt", b"col1\tcol2\tcol3\nval1\tval2\tval3\n")
                .unwrap();
            let r = run(&mut bash, "cut -f2 /test/tabs.txt");
            assert_eq!(r.stdout, "col2\nval2\n");
        }

        #[test]
        fn stdin_pipe() {
            let mut bash = fresh();
            let r = run(&mut bash, "echo 'a:b:c' | cut -d: -f2");
            assert_eq!(r.stdout, "b\n");
        }

        #[test]
        fn missing_file_error() {
            let mut bash = fresh();
            let r = run(&mut bash, "cut -f1 /test/nonexistent.txt");
            assert_eq!(
                r.stderr,
                "cut: /test/nonexistent.txt: No such file or directory\n"
            );
            assert_eq!(r.exit_code, 1);
        }

        #[test]
        fn missing_spec_error() {
            let mut bash = fresh();
            bash.fs_mut().write_file("/test/text.txt", b"hi\n").unwrap();
            let r = run(&mut bash, "cut /test/text.txt");
            assert_eq!(
                r.stderr,
                "cut: you must specify a list of bytes, characters, or fields\n"
            );
            assert_eq!(r.exit_code, 1);
        }
    }

    mod tr_tests {
        use super::*;

        #[test]
        fn case_conversion() {
            let mut bash = fresh();
            assert_eq!(
                run(&mut bash, "echo 'hello world' | tr 'a-z' 'A-Z'").stdout,
                "HELLO WORLD\n"
            );
            assert_eq!(
                run(&mut bash, "echo 'HELLO WORLD' | tr 'A-Z' 'a-z'").stdout,
                "hello world\n"
            );
        }

        #[test]
        fn delete_mode() {
            let mut bash = fresh();
            assert_eq!(
                run(&mut bash, "echo 'hello world' | tr -d 'aeiou'").stdout,
                "hll wrld\n"
            );
            assert_eq!(
                run(&mut bash, r"printf 'line1\nline2' | tr -d '\n'").stdout,
                "line1line2"
            );
        }

        #[test]
        fn squeeze_mode() {
            let mut bash = fresh();
            let r = run(&mut bash, "echo 'hello    world' | tr -s ' '");
            assert_eq!(r.stdout, "hello world\n");
        }

        #[test]
        fn translate_and_shorter_set2() {
            let mut bash = fresh();
            assert_eq!(
                run(&mut bash, "echo 'abc' | tr 'abc' 'xyz'").stdout,
                "xyz\n"
            );
            assert_eq!(
                run(&mut bash, "echo 'aabbcc' | tr 'abc' 'x'").stdout,
                "xxxxxx\n"
            );
        }

        #[test]
        fn missing_operands() {
            let mut bash = fresh();
            let r = run(&mut bash, "echo 'hello' | tr");
            assert_eq!(r.stderr, "tr: missing operand\n");
            assert_eq!(r.exit_code, 1);
            let r = run(&mut bash, "echo 'hello' | tr 'a-z'");
            assert_eq!(r.stderr, "tr: missing operand after SET1\n");
            assert_eq!(r.exit_code, 1);
        }

        #[test]
        fn complement_delete_keeps_only_digits() {
            let mut bash = fresh();
            let r = run(&mut bash, "echo 'abc123def456' | tr -cd '0-9'");
            assert_eq!(r.stdout, "123456");
        }

        #[test]
        fn complement_posix_class() {
            let mut bash = fresh();
            let r = run(&mut bash, "echo 'hello, world! 123' | tr -cd '[:alnum:]'");
            assert_eq!(r.stdout, "helloworld123");
        }

        #[test]
        fn complement_translate() {
            let mut bash = fresh();
            let r = run(&mut bash, "echo 'abc123def' | tr -c '0-9' 'X'");
            assert_eq!(r.stdout, "XXX123XXXX");
        }

        #[test]
        fn complement_squeeze() {
            let mut bash = fresh();
            let r = run(&mut bash, "echo 'aaa111bbb222' | tr -cs '0-9' 'X'");
            assert_eq!(r.stdout, "X111X222X");
        }
    }

    mod printf_tests {
        use super::*;

        #[test]
        fn basic_specifiers() {
            let mut bash = fresh();
            assert_eq!(
                run(&mut bash, "printf \"Hello %s\" world").stdout,
                "Hello world"
            );
            assert_eq!(
                run(&mut bash, "printf \"Number: %d\" 42").stdout,
                "Number: 42"
            );
            assert_eq!(
                run(&mut bash, "printf \"Value: %f\" 3.14").stdout,
                "Value: 3.140000"
            );
            assert_eq!(run(&mut bash, "printf \"Hex: %x\" 255").stdout, "Hex: ff");
            assert_eq!(run(&mut bash, "printf \"Octal: %o\" 8").stdout, "Octal: 10");
            assert_eq!(run(&mut bash, "printf \"100%%\"").stdout, "100%");
            assert_eq!(
                run(&mut bash, "printf \"%s is %d years old\" Alice 30").stdout,
                "Alice is 30 years old"
            );
        }

        #[test]
        fn escape_sequences() {
            let mut bash = fresh();
            assert_eq!(
                run(&mut bash, "printf \"line1\\nline2\"").stdout,
                "line1\nline2"
            );
            assert_eq!(
                run(&mut bash, "printf \"col1\\tcol2\"").stdout,
                "col1\tcol2"
            );
            assert_eq!(run(&mut bash, "printf \"\\101\\102\\103\"").stdout, "ABC");
            assert_eq!(run(&mut bash, "printf \"\\x41\\x42\\x43\"").stdout, "ABC");
            assert_eq!(run(&mut bash, "printf \"\\u2764\"").stdout, "\u{2764}");
            assert_eq!(run(&mut bash, "printf \"\\U1F600\"").stdout, "\u{1F600}");
        }

        #[test]
        fn width_and_precision() {
            let mut bash = fresh();
            assert_eq!(
                run(&mut bash, "printf \"%10s\" \"hi\"").stdout,
                "        hi"
            );
            assert_eq!(run(&mut bash, "printf \"%.2f\" 3.14159").stdout, "3.14");
            assert_eq!(run(&mut bash, "printf \"%05d\" 42").stdout, "00042");
            assert_eq!(
                run(&mut bash, "printf \"%-10s|\" \"hi\"").stdout,
                "hi        |"
            );
        }

        #[test]
        fn errors() {
            let mut bash = fresh();
            let r = run(&mut bash, "printf");
            assert!(r.stderr.contains("usage"));
            assert_eq!(r.exit_code, 2);
            let r = run(&mut bash, "printf \"%s %s\" only");
            assert_eq!(r.stdout, "only ");
            assert_eq!(r.exit_code, 0);
            let r = run(&mut bash, "printf \"%d\" notanumber");
            assert_eq!(r.stdout, "0");
            assert!(r.stderr.contains("invalid number"));
            assert_eq!(r.exit_code, 1);
        }

        #[test]
        fn dash_v_assigns_variable() {
            let mut bash = fresh();
            let r = run(&mut bash, "printf -v myvar \"%s\" hello; echo $myvar");
            assert_eq!(r.stdout, "hello\n");
            assert_eq!(r.exit_code, 0);
        }

        #[test]
        fn dash_v_rejects_invalid_identifiers() {
            let mut bash = fresh();
            let r = run(&mut bash, "printf -v 'x[;rm -rf /]' '%s' hello");
            assert_eq!(r.exit_code, 2);
            assert!(r.stderr.contains("not a valid identifier"));
        }
    }

    mod basename_dirname_tests {
        use super::*;

        #[test]
        fn basename_basic() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "basename /usr/bin/sort").stdout, "sort\n");
            assert_eq!(run(&mut bash, "basename file.txt").stdout, "file.txt\n");
            assert_eq!(
                run(&mut bash, "basename /path/to/file.txt .txt").stdout,
                "file\n"
            );
            assert_eq!(
                run(&mut bash, "basename -s .txt /path/file.txt").stdout,
                "file\n"
            );
            assert_eq!(
                run(&mut bash, "basename -a /path/one.txt /path/two.txt").stdout,
                "one.txt\ntwo.txt\n"
            );
            assert_eq!(
                run(
                    &mut bash,
                    "basename --suffix=.txt /path/one.txt /path/two.txt"
                )
                .stdout,
                "one\ntwo\n"
            );
        }

        #[test]
        fn basename_missing_operand() {
            let mut bash = fresh();
            let r = run(&mut bash, "basename");
            assert!(r.stderr.contains("missing operand"));
            assert_eq!(r.exit_code, 1);
        }

        #[test]
        fn dirname_basic() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "dirname /usr/bin/sort").stdout, "/usr/bin\n");
            assert_eq!(run(&mut bash, "dirname file.txt").stdout, ".\n");
            assert_eq!(run(&mut bash, "dirname /file.txt").stdout, "/\n");
            assert_eq!(
                run(&mut bash, "dirname /path/to/file1 /another/path/file2").stdout,
                "/path/to\n/another/path\n"
            );
        }

        #[test]
        fn dirname_missing_operand() {
            let mut bash = fresh();
            let r = run(&mut bash, "dirname");
            assert!(r.stderr.contains("missing operand"));
            assert_eq!(r.exit_code, 1);
        }
    }
}
