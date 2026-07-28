//! PORT (simplified): vendor/just-bash/src/commands/{comm,join,nl,od,rev,
//! fold,expand,column,paste,strings,split}/*.ts
//!
//! A second wave of small text-processing coreutils, grouped in one file
//! per the design doc's convention (mirrors `text.rs`'s wc/head/tail/cut/
//! tr/printf group). Execution-limit enforcement (`ExecutionLimitError` et
//! al upstream) is not ported anywhere in this port, and neither is
//! `--help` text for this batch (functional correctness over help output,
//! per the design doc's scope guidance) -- every command still validates
//! its own arguments and produces the right stdout/stderr/exit code.

use std::collections::{HashMap, HashSet};

use super::{fail, normalize_path, ok, read_concat, unknown_option};
use crate::interpreter::{CommandOutput, Interpreter};

/// Split into lines without a trailing empty element for a final newline.
fn lines_no_trailing(content: &str) -> Vec<&str> {
    if content.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<&str> = content.split('\n').collect();
    if content.ends_with('\n') {
        lines.pop();
    }
    lines
}

fn read_operand(interp: &Interpreter, file: &str, stdin: &str) -> Option<String> {
    if file == "-" {
        return Some(stdin.to_string());
    }
    let path = normalize_path(&interp.cwd, file);
    interp
        .fs
        .read_file(&path)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

// ---------------------------------------------------------------------
// comm
// ---------------------------------------------------------------------

pub fn comm(interp: &Interpreter, args: &[String], stdin: &str) -> CommandOutput {
    let mut suppress1 = false;
    let mut suppress2 = false;
    let mut suppress3 = false;
    let mut files: Vec<String> = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-1" => suppress1 = true,
            "-2" => suppress2 = true,
            "-3" => suppress3 = true,
            "-12" | "-21" => {
                suppress1 = true;
                suppress2 = true;
            }
            "-13" | "-31" => {
                suppress1 = true;
                suppress3 = true;
            }
            "-23" | "-32" => {
                suppress2 = true;
                suppress3 = true;
            }
            "-123" | "-132" | "-213" | "-231" | "-312" | "-321" => {
                suppress1 = true;
                suppress2 = true;
                suppress3 = true;
            }
            other if other.starts_with('-') && other != "-" => {
                return unknown_option("comm", other);
            }
            other => files.push(other.to_string()),
        }
    }
    if files.len() != 2 {
        return fail(
            "comm: missing operand\nTry 'comm --help' for more information.\n".to_string(),
            1,
        );
    }
    let Some(c1) = read_operand(interp, &files[0], stdin) else {
        return fail(
            format!("comm: {}: No such file or directory\n", files[0]),
            1,
        );
    };
    let Some(c2) = read_operand(interp, &files[1], stdin) else {
        return fail(
            format!("comm: {}: No such file or directory\n", files[1]),
            1,
        );
    };
    let lines1 = lines_no_trailing(&c1);
    let lines2 = lines_no_trailing(&c2);
    let col2_prefix = if suppress1 { "" } else { "\t" };
    let col3_prefix = format!(
        "{}{}",
        if suppress1 { "" } else { "\t" },
        if suppress2 { "" } else { "\t" }
    );

    let mut output = String::new();
    let (mut i, mut j) = (0, 0);
    while i < lines1.len() || j < lines2.len() {
        // "file2 exhausted" and "line1 sorts first" both mean: emit the
        // current file1 line as a column-1-only entry (mirror for file1
        // exhausted / line2 sorts first below).
        if j >= lines2.len() || (i < lines1.len() && lines1[i] < lines2[j]) {
            if !suppress1 {
                output.push_str(lines1[i]);
                output.push('\n');
            }
            i += 1;
        } else if i >= lines1.len() || lines1[i] > lines2[j] {
            if !suppress2 {
                output.push_str(col2_prefix);
                output.push_str(lines2[j]);
                output.push('\n');
            }
            j += 1;
        } else {
            if !suppress3 {
                output.push_str(&col3_prefix);
                output.push_str(lines1[i]);
                output.push('\n');
            }
            i += 1;
            j += 1;
        }
    }
    ok(output)
}

// ---------------------------------------------------------------------
// join
// ---------------------------------------------------------------------

struct JoinOptions {
    field1: usize,
    field2: usize,
    separator: Option<String>,
    print_unpairable: HashSet<u8>,
    only_unpairable: HashSet<u8>,
    empty_string: String,
    output_format: Option<Vec<(u8, usize)>>,
}

struct ParsedLine {
    fields: Vec<String>,
    join_key: String,
}

fn join_split_line(line: &str, separator: &Option<String>) -> Vec<String> {
    match separator {
        Some(sep) if !sep.is_empty() => line.split(sep.as_str()).map(str::to_string).collect(),
        _ => line
            .split([' ', '\t'])
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
    }
}

fn join_parse_line(
    line: &str,
    separator: &Option<String>,
    join_field: usize,
    ignore_case: bool,
) -> ParsedLine {
    let fields = join_split_line(line, separator);
    let mut join_key = fields
        .get(join_field.saturating_sub(1))
        .cloned()
        .unwrap_or_default();
    if ignore_case {
        join_key = join_key.to_lowercase();
    }
    ParsedLine { fields, join_key }
}

fn join_format_line(
    line1: Option<&ParsedLine>,
    line2: Option<&ParsedLine>,
    opts: &JoinOptions,
) -> String {
    let sep = opts.separator.as_deref().unwrap_or(" ");
    if let Some(format) = &opts.output_format {
        let parts: Vec<String> = format
            .iter()
            .map(|(file, field)| {
                let line = if *file == 1 { line1 } else { line2 };
                if *field == 0 {
                    line.map(|l| l.join_key.clone())
                        .unwrap_or_else(|| opts.empty_string.clone())
                } else {
                    line.and_then(|l| l.fields.get(field - 1).cloned())
                        .unwrap_or_else(|| opts.empty_string.clone())
                }
            })
            .collect();
        return parts.join(sep);
    }
    let mut parts = vec![
        line1
            .or(line2)
            .map(|l| l.join_key.clone())
            .unwrap_or_default(),
    ];
    if let Some(l) = line1 {
        for (i, f) in l.fields.iter().enumerate() {
            if i != opts.field1 - 1 {
                parts.push(f.clone());
            }
        }
    }
    if let Some(l) = line2 {
        for (i, f) in l.fields.iter().enumerate() {
            if i != opts.field2 - 1 {
                parts.push(f.clone());
            }
        }
    }
    parts.join(sep)
}

fn parse_output_format(format: &str) -> Option<Vec<(u8, usize)>> {
    let mut result = Vec::new();
    for part in format.split(',') {
        let (file_str, field_str) = part.trim().split_once('.')?;
        let file: u8 = file_str.parse().ok()?;
        let field: usize = field_str.parse().ok()?;
        if file != 1 && file != 2 {
            return None;
        }
        result.push((file, field));
    }
    Some(result)
}

pub fn join(interp: &Interpreter, args: &[String], stdin: &str) -> CommandOutput {
    let mut field1 = 1usize;
    let mut field2 = 1usize;
    let mut separator: Option<String> = None;
    let mut print_unpairable: HashSet<u8> = HashSet::new();
    let mut only_unpairable: HashSet<u8> = HashSet::new();
    let mut empty_string = String::new();
    let mut output_format = None;
    let mut ignore_case = false;
    let mut files: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-1" if i + 1 < args.len() => {
                i += 1;
                match args[i].parse::<usize>() {
                    Ok(f) if f >= 1 => field1 = f,
                    _ => return fail(format!("join: invalid field number: '{}'\n", args[i]), 1),
                }
            }
            "-2" if i + 1 < args.len() => {
                i += 1;
                match args[i].parse::<usize>() {
                    Ok(f) if f >= 1 => field2 = f,
                    _ => return fail(format!("join: invalid field number: '{}'\n", args[i]), 1),
                }
            }
            "-t" | "--field-separator" if i + 1 < args.len() => {
                i += 1;
                separator = Some(args[i].clone());
            }
            _ if arg.starts_with("-t") && arg.len() > 2 => separator = Some(arg[2..].to_string()),
            "-a" if i + 1 < args.len() => {
                i += 1;
                match args[i].parse::<u8>() {
                    Ok(f) if f == 1 || f == 2 => {
                        print_unpairable.insert(f);
                    }
                    _ => return fail(format!("join: invalid file number: '{}'\n", args[i]), 1),
                }
            }
            "-a1" => {
                print_unpairable.insert(1);
            }
            "-a2" => {
                print_unpairable.insert(2);
            }
            "-v" if i + 1 < args.len() => {
                i += 1;
                match args[i].parse::<u8>() {
                    Ok(f) if f == 1 || f == 2 => {
                        only_unpairable.insert(f);
                    }
                    _ => return fail(format!("join: invalid file number: '{}'\n", args[i]), 1),
                }
            }
            "-v1" => {
                only_unpairable.insert(1);
            }
            "-v2" => {
                only_unpairable.insert(2);
            }
            "-e" if i + 1 < args.len() => {
                i += 1;
                empty_string = args[i].clone();
            }
            "-o" if i + 1 < args.len() => {
                i += 1;
                match parse_output_format(&args[i]) {
                    Some(f) => output_format = Some(f),
                    None => return fail(format!("join: invalid field spec: '{}'\n", args[i]), 1),
                }
            }
            "-i" | "--ignore-case" => ignore_case = true,
            "--" => {
                files.extend(args[i + 1..].iter().cloned());
                break;
            }
            other if other.starts_with('-') && other != "-" => {
                return unknown_option("join", other);
            }
            other => files.push(other.to_string()),
        }
        i += 1;
    }

    if files.len() != 2 {
        let msg = if files.len() < 2 {
            "join: missing file operand\n"
        } else {
            "join: extra operand\n"
        };
        return fail(msg.to_string(), 1);
    }

    let mut contents = Vec::new();
    for file in &files {
        match read_operand(interp, file, stdin) {
            Some(c) => contents.push(c),
            None => return fail(format!("join: {file}: No such file or directory\n"), 1),
        }
    }

    let opts = JoinOptions {
        field1,
        field2,
        separator,
        print_unpairable,
        only_unpairable,
        empty_string,
        output_format,
    };

    let parse_lines = |content: &str, join_field: usize| -> Vec<ParsedLine> {
        lines_no_trailing(content)
            .into_iter()
            .filter(|l| !l.is_empty())
            .map(|l| join_parse_line(l, &opts.separator, join_field, ignore_case))
            .collect()
    };

    let lines1 = parse_lines(&contents[0], opts.field1);
    let lines2 = parse_lines(&contents[1], opts.field2);

    let mut index2: HashMap<&str, Vec<&ParsedLine>> = HashMap::new();
    for line in &lines2 {
        index2.entry(line.join_key.as_str()).or_default().push(line);
    }

    let mut output: Vec<String> = Vec::new();
    let mut matched_keys2: HashSet<&str> = HashSet::new();

    for line1 in &lines1 {
        if let Some(matches) = index2.get(line1.join_key.as_str()) {
            matched_keys2.insert(line1.join_key.as_str());
            if opts.only_unpairable.is_empty() {
                for line2 in matches {
                    output.push(join_format_line(Some(line1), Some(line2), &opts));
                }
            }
        } else if opts.print_unpairable.contains(&1) || opts.only_unpairable.contains(&1) {
            output.push(join_format_line(Some(line1), None, &opts));
        }
    }
    if opts.print_unpairable.contains(&2) || opts.only_unpairable.contains(&2) {
        for line2 in &lines2 {
            if !matched_keys2.contains(line2.join_key.as_str()) {
                output.push(join_format_line(None, Some(line2), &opts));
            }
        }
    }

    ok(if output.is_empty() {
        String::new()
    } else {
        format!("{}\n", output.join("\n"))
    })
}

// ---------------------------------------------------------------------
// nl
// ---------------------------------------------------------------------

fn nl_format_number(num: i64, format: &str, width: usize) -> String {
    let s = num.to_string();
    match format {
        "ln" => format!("{s:<width$}"),
        "rz" => format!("{s:0>width$}"),
        _ => format!("{s:>width$}"), // "rn", the default
    }
}

fn nl_should_number(line: &str, style: char) -> bool {
    match style {
        'a' => true,
        'n' => false,
        _ => !line.trim().is_empty(), // 't', the default
    }
}

fn nl_process(
    content: &str,
    style: char,
    format: &str,
    width: usize,
    separator: &str,
    increment: i64,
    current: i64,
) -> (String, i64) {
    if content.is_empty() {
        return (String::new(), current);
    }
    let has_trailing = content.ends_with('\n');
    let lines = lines_no_trailing(content);
    let mut result_lines = Vec::with_capacity(lines.len());
    let mut n = current;
    for line in lines {
        if nl_should_number(line, style) {
            result_lines.push(format!(
                "{}{separator}{line}",
                nl_format_number(n, format, width)
            ));
            n += increment;
        } else {
            result_lines.push(format!("{}{separator}{line}", " ".repeat(width)));
        }
    }
    let mut out = result_lines.join("\n");
    if has_trailing {
        out.push('\n');
    }
    (out, n)
}

pub fn nl(interp: &Interpreter, args: &[String], stdin: &str) -> CommandOutput {
    let mut style = 't';
    let mut format = "rn".to_string();
    let mut width = 6usize;
    let mut separator = "\t".to_string();
    let mut start = 1i64;
    let mut increment = 1i64;
    let mut files: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-b" if i + 1 < args.len() => {
                i += 1;
                match args[i].as_str() {
                    "a" | "t" | "n" => style = args[i].chars().next().unwrap(),
                    other => {
                        return fail(format!("nl: invalid body numbering style: '{other}'\n"), 1);
                    }
                }
            }
            _ if arg.starts_with("-b") && arg.len() == 3 => match &arg[2..] {
                "a" => style = 'a',
                "t" => style = 't',
                "n" => style = 'n',
                other => return fail(format!("nl: invalid body numbering style: '{other}'\n"), 1),
            },
            "-n" if i + 1 < args.len() => {
                i += 1;
                match args[i].as_str() {
                    "ln" | "rn" | "rz" => format = args[i].clone(),
                    other => {
                        return fail(format!("nl: invalid line numbering format: '{other}'\n"), 1);
                    }
                }
            }
            _ if arg.starts_with("-n") && arg.len() > 2 => match &arg[2..] {
                "ln" | "rn" | "rz" => format = arg[2..].to_string(),
                other => return fail(format!("nl: invalid line numbering format: '{other}'\n"), 1),
            },
            "-w" if i + 1 < args.len() => {
                i += 1;
                match args[i].parse::<usize>() {
                    Ok(w) if w >= 1 => width = w,
                    _ => {
                        return fail(
                            format!("nl: invalid line number field width: '{}'\n", args[i]),
                            1,
                        );
                    }
                }
            }
            _ if arg.starts_with("-w") && arg.len() > 2 => match arg[2..].parse::<usize>() {
                Ok(w) if w >= 1 => width = w,
                _ => {
                    return fail(
                        format!("nl: invalid line number field width: '{}'\n", &arg[2..]),
                        1,
                    );
                }
            },
            "-s" if i + 1 < args.len() => {
                i += 1;
                separator = args[i].clone();
            }
            _ if arg.starts_with("-s") && arg.len() > 2 => separator = arg[2..].to_string(),
            "-v" if i + 1 < args.len() => {
                i += 1;
                match args[i].parse::<i64>() {
                    Ok(v) => start = v,
                    Err(_) => {
                        return fail(
                            format!("nl: invalid starting line number: '{}'\n", args[i]),
                            1,
                        );
                    }
                }
            }
            _ if arg.starts_with("-v") && arg.len() > 2 => match arg[2..].parse::<i64>() {
                Ok(v) => start = v,
                Err(_) => {
                    return fail(
                        format!("nl: invalid starting line number: '{}'\n", &arg[2..]),
                        1,
                    );
                }
            },
            "-i" if i + 1 < args.len() => {
                i += 1;
                match args[i].parse::<i64>() {
                    Ok(v) => increment = v,
                    Err(_) => {
                        return fail(
                            format!("nl: invalid line number increment: '{}'\n", args[i]),
                            1,
                        );
                    }
                }
            }
            _ if arg.starts_with("-i") && arg.len() > 2 => match arg[2..].parse::<i64>() {
                Ok(v) => increment = v,
                Err(_) => {
                    return fail(
                        format!("nl: invalid line number increment: '{}'\n", &arg[2..]),
                        1,
                    );
                }
            },
            "--" => {
                files.extend(args[i + 1..].iter().cloned());
                break;
            }
            other if other.starts_with('-') && other != "-" => return unknown_option("nl", other),
            other => files.push(other.to_string()),
        }
        i += 1;
    }

    let mut output = String::new();
    let mut line_number = start;
    if files.is_empty() {
        let (out, _) = nl_process(
            stdin,
            style,
            &format,
            width,
            &separator,
            increment,
            line_number,
        );
        output = out;
    } else {
        for file in &files {
            let path = normalize_path(&interp.cwd, file);
            let content = match interp.fs.read_file(&path).as_deref() {
                Some(bytes) => String::from_utf8_lossy(bytes).into_owned(),
                None => {
                    return CommandOutput {
                        stdout: output,
                        stderr: format!("nl: {file}: No such file or directory\n"),
                        exit_code: 1,
                    };
                }
            };
            let (out, next) = nl_process(
                &content,
                style,
                &format,
                width,
                &separator,
                increment,
                line_number,
            );
            output.push_str(&out);
            line_number = next;
        }
    }
    ok(output)
}

// ---------------------------------------------------------------------
// od
// ---------------------------------------------------------------------

enum OdFormat {
    Octal,
    Hex,
    Char,
}

fn od_format_char_byte(code: u8) -> String {
    match code {
        0 => "  \\0".to_string(),
        7 => "  \\a".to_string(),
        8 => "  \\b".to_string(),
        9 => "  \\t".to_string(),
        10 => "  \\n".to_string(),
        11 => "  \\v".to_string(),
        12 => "  \\f".to_string(),
        13 => "  \\r".to_string(),
        32..=126 => format!("   {}", code as char),
        _ => format!(" {code:03o}"),
    }
}

pub fn od(interp: &Interpreter, args: &[String], stdin: &str) -> CommandOutput {
    let mut address_none = false;
    let mut formats: Vec<OdFormat> = Vec::new();
    let mut file_args: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-c" => formats.push(OdFormat::Char),
            "-An" => address_none = true,
            "-A" if args.get(i + 1).map(String::as_str) == Some("n") => {
                address_none = true;
                i += 1;
            }
            "-t" if i + 1 < args.len() => {
                i += 1;
                match args[i].as_str() {
                    "x1" => formats.push(OdFormat::Hex),
                    "c" => formats.push(OdFormat::Char),
                    s if s.starts_with('o') => formats.push(OdFormat::Octal),
                    _ => {}
                }
            }
            other if !other.starts_with('-') || other == "-" => file_args.push(other.to_string()),
            _ => {}
        }
        i += 1;
    }
    if formats.is_empty() {
        formats.push(OdFormat::Octal);
    }

    let operands: Vec<String> = if file_args.is_empty() {
        vec!["-".to_string()]
    } else {
        file_args
    };
    let mut input = String::new();
    for operand in &operands {
        if operand == "-" {
            input.push_str(stdin);
            continue;
        }
        let path = normalize_path(&interp.cwd, operand);
        match interp.fs.read_file(&path).as_deref() {
            Some(bytes) => input.push_str(&String::from_utf8_lossy(bytes)),
            None => return fail(format!("od: {operand}: No such file or directory\n"), 1),
        }
    }

    // `od` dumps raw bytes; this interpreter pipes text (String) throughout,
    // so byte-for-byte fidelity beyond UTF-8 was already out of scope before
    // this command (same caveat as the rest of this port's text-only Vfs).
    let bytes: Vec<u8> = input.into_bytes();
    let has_char_format = formats.iter().any(|f| matches!(f, OdFormat::Char));
    let bytes_per_line = 16;

    let mut out = String::new();
    let mut offset = 0;
    while offset < bytes.len() {
        let end = (offset + bytes_per_line).min(bytes.len());
        let chunk = &bytes[offset..end];
        for (fi, format) in formats.iter().enumerate() {
            let formatted: String = chunk
                .iter()
                .map(|&b| match format {
                    OdFormat::Char => od_format_char_byte(b),
                    OdFormat::Hex => {
                        if has_char_format {
                            format!("  {b:02x}")
                        } else {
                            format!(" {b:02x}")
                        }
                    }
                    OdFormat::Octal => format!(" {b:03o}"),
                })
                .collect();
            let prefix = if address_none {
                String::new()
            } else if fi == 0 {
                format!("{offset:07o} ")
            } else {
                "        ".to_string()
            };
            out.push_str(&prefix);
            out.push_str(&formatted);
            out.push('\n');
        }
        offset += bytes_per_line;
    }
    if !address_none && !bytes.is_empty() {
        out.push_str(&format!("{:07o}\n", bytes.len()));
    }
    ok(out)
}

// ---------------------------------------------------------------------
// rev
// ---------------------------------------------------------------------

fn rev_process(content: &str) -> String {
    if content.is_empty() {
        return String::new();
    }
    let has_trailing = content.ends_with('\n');
    let lines = lines_no_trailing(content);
    let reversed: Vec<String> = lines.iter().map(|l| l.chars().rev().collect()).collect();
    let mut out = reversed.join("\n");
    if has_trailing {
        out.push('\n');
    }
    out
}

pub fn rev(interp: &Interpreter, args: &[String], stdin: &str) -> CommandOutput {
    let mut files: Vec<&String> = Vec::new();
    for arg in args {
        if arg.starts_with('-') && arg != "-" {
            return unknown_option("rev", arg);
        }
        files.push(arg);
    }
    let mut output = String::new();
    if files.is_empty() {
        output = rev_process(stdin);
    } else {
        for file in files {
            if file == "-" {
                output.push_str(&rev_process(stdin));
                continue;
            }
            let path = normalize_path(&interp.cwd, file);
            match interp.fs.read_file(&path).as_deref() {
                Some(bytes) => output.push_str(&rev_process(&String::from_utf8_lossy(bytes))),
                None => {
                    return CommandOutput {
                        stdout: output,
                        stderr: format!("rev: {file}: No such file or directory\n"),
                        exit_code: 1,
                    };
                }
            }
        }
    }
    ok(output)
}

// ---------------------------------------------------------------------
// fold
// ---------------------------------------------------------------------

struct FoldOptions {
    width: i64,
    break_at_spaces: bool,
    count_bytes: bool,
}

fn fold_char_width(c: char, current_column: i64, count_bytes: bool) -> i64 {
    if count_bytes {
        return c.len_utf8() as i64;
    }
    match c {
        '\t' => 8 - current_column.max(0) % 8,
        '\u{8}' => -1,
        _ => 1,
    }
}

fn fold_line(line: &str, opts: &FoldOptions) -> String {
    if line.is_empty() {
        return String::new();
    }
    let mut result: Vec<String> = Vec::new();
    let mut current: Vec<char> = Vec::new();
    let mut current_column: i64 = 0;
    let mut last_space_index: Option<usize> = None;
    let mut last_space_column: i64 = 0;

    for c in line.chars() {
        let w = fold_char_width(c, current_column, opts.count_bytes);
        if current_column + w > opts.width && !current.is_empty() {
            if opts.break_at_spaces
                && let Some(idx) = last_space_index
            {
                let head: String = current[..=idx].iter().collect();
                let tail: Vec<char> = current[idx + 1..].to_vec();
                result.push(head);
                current = tail;
                current.push(c);
                current_column = current_column - last_space_column - 1 + w;
            } else {
                result.push(current.iter().collect());
                current.clear();
                current.push(c);
                current_column = w;
            }
            last_space_index = None;
            last_space_column = 0;
        } else {
            current.push(c);
            current_column += w;
            if c == ' ' || c == '\t' {
                last_space_index = Some(current.len() - 1);
                last_space_column = current_column - w;
            }
        }
    }
    if !current.is_empty() {
        result.push(current.iter().collect());
    }
    result.join("\n")
}

fn fold_process(content: &str, opts: &FoldOptions) -> String {
    if content.is_empty() {
        return String::new();
    }
    let has_trailing = content.ends_with('\n');
    let lines = lines_no_trailing(content);
    let folded: Vec<String> = lines.iter().map(|l| fold_line(l, opts)).collect();
    let mut out = folded.join("\n");
    if has_trailing {
        out.push('\n');
    }
    out
}

/// Recognize `-[sb]+w[DIGITS]` (e.g. `-sw40`, `-bsw`, `-sw`): combined
/// `-s`/`-b` short flags immediately followed by `-w`'s width, attached or
/// not. Returns `(flag_letters, width_digits)` on match.
fn fold_sb_w_body(arg: &str) -> Option<(&str, &str)> {
    let body = arg.strip_prefix('-')?;
    let w_idx = body.find('w')?;
    let (flags, rest) = body.split_at(w_idx);
    if flags.is_empty() || !flags.chars().all(|c| c == 's' || c == 'b') {
        return None;
    }
    let digits = &rest[1..]; // past the 'w'
    if digits.chars().all(|c| c.is_ascii_digit()) {
        Some((flags, digits))
    } else {
        None
    }
}

pub fn fold(interp: &Interpreter, args: &[String], stdin: &str) -> CommandOutput {
    let mut opts = FoldOptions {
        width: 80,
        break_at_spaces: false,
        count_bytes: false,
    };
    let mut files: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-w" if i + 1 < args.len() => {
                i += 1;
                match args[i].parse::<i64>() {
                    Ok(w) if w >= 1 => opts.width = w,
                    _ => {
                        return fail(
                            format!("fold: invalid number of columns: '{}'\n", args[i]),
                            1,
                        );
                    }
                }
            }
            _ if arg.starts_with("-w") && arg.len() > 2 => match arg[2..].parse::<i64>() {
                Ok(w) if w >= 1 => opts.width = w,
                _ => {
                    return fail(
                        format!("fold: invalid number of columns: '{}'\n", &arg[2..]),
                        1,
                    );
                }
            },
            "-s" => opts.break_at_spaces = true,
            "-b" => opts.count_bytes = true,
            "--" => {
                files.extend(args[i + 1..].iter().cloned());
                break;
            }
            _ if fold_sb_w_body(arg).is_some() => {
                let (flags, width_digits) = fold_sb_w_body(arg).unwrap();
                if flags.contains('s') {
                    opts.break_at_spaces = true;
                }
                if flags.contains('b') {
                    opts.count_bytes = true;
                }
                let width_str = if width_digits.is_empty() {
                    if i + 1 >= args.len() {
                        return unknown_option("fold", arg);
                    }
                    i += 1;
                    args[i].clone()
                } else {
                    width_digits.to_string()
                };
                match width_str.parse::<i64>() {
                    Ok(w) if w >= 1 => opts.width = w,
                    _ => {
                        return fail(
                            format!("fold: invalid number of columns: '{width_str}'\n"),
                            1,
                        );
                    }
                }
            }
            other if other.starts_with('-') && other.len() > 1 && other != "-" => {
                for c in other[1..].chars() {
                    match c {
                        's' => opts.break_at_spaces = true,
                        'b' => opts.count_bytes = true,
                        _ => return unknown_option("fold", other),
                    }
                }
            }
            other => files.push(other.to_string()),
        }
        i += 1;
    }

    let mut output = String::new();
    if files.is_empty() {
        output = fold_process(stdin, &opts);
    } else {
        for file in &files {
            let path = normalize_path(&interp.cwd, file);
            match interp.fs.read_file(&path).as_deref() {
                Some(bytes) => {
                    output.push_str(&fold_process(&String::from_utf8_lossy(bytes), &opts))
                }
                None => {
                    return CommandOutput {
                        stdout: output,
                        stderr: format!("fold: {file}: No such file or directory\n"),
                        exit_code: 1,
                    };
                }
            }
        }
    }
    ok(output)
}

// ---------------------------------------------------------------------
// expand / unexpand
// ---------------------------------------------------------------------

fn parse_tab_stops(spec: &str) -> Option<Vec<usize>> {
    let mut stops = Vec::new();
    for part in spec.split(',') {
        let n: usize = part.trim().parse().ok()?;
        if n < 1 {
            return None;
        }
        stops.push(n);
    }
    for i in 1..stops.len() {
        if stops[i] <= stops[i - 1] {
            return None;
        }
    }
    if stops.is_empty() { None } else { Some(stops) }
}

fn tab_width_at(column: usize, stops: &[usize]) -> usize {
    if stops.len() == 1 {
        let w = stops[0];
        return w - (column % w);
    }
    for &s in stops {
        if s > column {
            return s - column;
        }
    }
    if stops.len() >= 2 {
        let last_interval = stops[stops.len() - 1] - stops[stops.len() - 2];
        let last_stop = stops[stops.len() - 1];
        let stops_after = (column - last_stop) / last_interval + 1;
        return last_stop + stops_after * last_interval - column;
    }
    1
}

fn next_tab_stop(column: usize, stops: &[usize]) -> usize {
    if stops.len() == 1 {
        let w = stops[0];
        return column + (w - (column % w));
    }
    for &s in stops {
        if s > column {
            return s;
        }
    }
    if stops.len() >= 2 {
        let last_interval = stops[stops.len() - 1] - stops[stops.len() - 2];
        let last_stop = stops[stops.len() - 1];
        let stops_after = (column - last_stop) / last_interval + 1;
        return last_stop + stops_after * last_interval;
    }
    column
}

fn expand_line(line: &str, stops: &[usize], leading_only: bool) -> String {
    let mut result = String::new();
    let mut column = 0usize;
    let mut in_leading = true;
    for c in line.chars() {
        if c == '\t' {
            if leading_only && !in_leading {
                result.push(c);
                column += 1;
            } else {
                let spaces = tab_width_at(column, stops);
                result.push_str(&" ".repeat(spaces));
                column += spaces;
            }
        } else {
            if c != ' ' {
                in_leading = false;
            }
            result.push(c);
            column += 1;
        }
    }
    result
}

fn expand_process(content: &str, stops: &[usize], leading_only: bool) -> String {
    if content.is_empty() {
        return String::new();
    }
    let has_trailing = content.ends_with('\n');
    let lines = lines_no_trailing(content);
    let expanded: Vec<String> = lines
        .iter()
        .map(|l| expand_line(l, stops, leading_only))
        .collect();
    let mut out = expanded.join("\n");
    if has_trailing {
        out.push('\n');
    }
    out
}

/// Shared `-t`/`--tabs` tab-stop-spec parsing for `expand`/`unexpand`.
/// Advances `*i` past any consumed following argument and updates
/// `tab_stops` in place; returns `Some(error)` on invalid syntax.
fn parse_tab_stop_flags(
    cmd: &str,
    args: &[String],
    i: &mut usize,
    tab_stops: &mut Vec<usize>,
) -> Option<CommandOutput> {
    let arg = &args[*i];
    let apply = |spec: &str, tab_stops: &mut Vec<usize>| -> Option<CommandOutput> {
        match parse_tab_stops(spec) {
            Some(s) => {
                *tab_stops = s;
                None
            }
            None => Some(fail(format!("{cmd}: invalid tab size: '{spec}'\n"), 1)),
        }
    };
    if arg == "-t" && *i + 1 < args.len() {
        *i += 1;
        return apply(&args[*i], tab_stops);
    }
    if let Some(rest) = arg.strip_prefix("-t")
        && !rest.is_empty()
    {
        return apply(rest, tab_stops);
    }
    if arg == "--tabs" && *i + 1 < args.len() {
        *i += 1;
        return apply(&args[*i], tab_stops);
    }
    if let Some(rest) = arg.strip_prefix("--tabs=") {
        return apply(rest, tab_stops);
    }
    Some(fail(format!("{cmd}: unrecognized argument\n"), 1))
}

pub fn expand(interp: &Interpreter, args: &[String], stdin: &str) -> CommandOutput {
    let mut tab_stops = vec![8usize];
    let mut leading_only = false;
    let mut files: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let is_tab_flag = arg == "-t"
            || arg.starts_with("-t") && arg.len() > 2
            || arg == "--tabs"
            || arg.starts_with("--tabs=");
        if is_tab_flag {
            if let Some(err) = parse_tab_stop_flags("expand", args, &mut i, &mut tab_stops) {
                return err;
            }
        } else {
            match arg.as_str() {
                "-i" | "--initial" => leading_only = true,
                "--" => {
                    files.extend(args[i + 1..].iter().cloned());
                    break;
                }
                other if other.starts_with('-') && other != "-" => {
                    return unknown_option("expand", other);
                }
                other => files.push(other.to_string()),
            }
        }
        i += 1;
    }

    let mut output = String::new();
    if files.is_empty() {
        output = expand_process(stdin, &tab_stops, leading_only);
    } else {
        for file in &files {
            let path = normalize_path(&interp.cwd, file);
            match interp.fs.read_file(&path).as_deref() {
                Some(bytes) => output.push_str(&expand_process(
                    &String::from_utf8_lossy(bytes),
                    &tab_stops,
                    leading_only,
                )),
                None => {
                    return CommandOutput {
                        stdout: output,
                        stderr: format!("expand: {file}: No such file or directory\n"),
                        exit_code: 1,
                    };
                }
            }
        }
    }
    ok(output)
}

fn unexpand_line(line: &str, stops: &[usize], all_blanks: bool) -> String {
    let mut result = String::new();
    let mut column = 0usize;
    let mut space_run = String::new();
    let mut space_run_start = 0usize;
    let mut in_leading = true;

    fn flush(
        result: &mut String,
        space_run: &mut String,
        space_run_start: usize,
        stops: &[usize],
        all_blanks: bool,
        in_leading: bool,
    ) {
        if space_run.is_empty() {
            return;
        }
        let end_column = space_run_start + space_run.len();
        if !all_blanks && !in_leading {
            result.push_str(space_run);
            space_run.clear();
            return;
        }
        let mut current_pos = space_run_start;
        let mut converted = String::new();
        loop {
            let next_stop = next_tab_stop(current_pos, stops);
            if next_stop <= end_column && next_stop > current_pos {
                converted.push('\t');
                current_pos = next_stop;
            } else {
                break;
            }
        }
        let remaining = end_column - current_pos;
        if remaining > 0 {
            converted.push_str(&" ".repeat(remaining));
        }
        result.push_str(&converted);
        space_run.clear();
    }

    for c in line.chars() {
        if c == ' ' {
            if space_run.is_empty() {
                space_run_start = column;
            }
            space_run.push(c);
            column += 1;
        } else if c == '\t' {
            flush(
                &mut result,
                &mut space_run,
                space_run_start,
                stops,
                all_blanks,
                in_leading,
            );
            result.push(c);
            column = next_tab_stop(column, stops);
        } else {
            flush(
                &mut result,
                &mut space_run,
                space_run_start,
                stops,
                all_blanks,
                in_leading,
            );
            result.push(c);
            column += 1;
            in_leading = false;
        }
    }
    flush(
        &mut result,
        &mut space_run,
        space_run_start,
        stops,
        all_blanks,
        in_leading,
    );
    result
}

fn unexpand_process(content: &str, stops: &[usize], all_blanks: bool) -> String {
    if content.is_empty() {
        return String::new();
    }
    let has_trailing = content.ends_with('\n');
    let lines = lines_no_trailing(content);
    let out_lines: Vec<String> = lines
        .iter()
        .map(|l| unexpand_line(l, stops, all_blanks))
        .collect();
    let mut out = out_lines.join("\n");
    if has_trailing {
        out.push('\n');
    }
    out
}

pub fn unexpand(interp: &Interpreter, args: &[String], stdin: &str) -> CommandOutput {
    let mut tab_stops = vec![8usize];
    let mut all_blanks = false;
    let mut files: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        let is_tab_flag = arg == "-t"
            || arg.starts_with("-t") && arg.len() > 2
            || arg == "--tabs"
            || arg.starts_with("--tabs=");
        if is_tab_flag {
            if let Some(err) = parse_tab_stop_flags("unexpand", args, &mut i, &mut tab_stops) {
                return err;
            }
        } else {
            match arg.as_str() {
                "-a" | "--all" => all_blanks = true,
                "--" => {
                    files.extend(args[i + 1..].iter().cloned());
                    break;
                }
                other if other.starts_with('-') && other != "-" => {
                    return unknown_option("unexpand", other);
                }
                other => files.push(other.to_string()),
            }
        }
        i += 1;
    }

    let mut output = String::new();
    if files.is_empty() {
        output = unexpand_process(stdin, &tab_stops, all_blanks);
    } else {
        for file in &files {
            let path = normalize_path(&interp.cwd, file);
            match interp.fs.read_file(&path).as_deref() {
                Some(bytes) => output.push_str(&unexpand_process(
                    &String::from_utf8_lossy(bytes),
                    &tab_stops,
                    all_blanks,
                )),
                None => {
                    return CommandOutput {
                        stdout: output,
                        stderr: format!("unexpand: {file}: No such file or directory\n"),
                        exit_code: 1,
                    };
                }
            }
        }
    }
    ok(output)
}

// ---------------------------------------------------------------------
// column
// ---------------------------------------------------------------------

fn column_split_fields(line: &str, separator: &Option<String>, no_merge: bool) -> Vec<String> {
    match separator {
        Some(sep) if !sep.is_empty() => {
            let parts: Vec<String> = line.split(sep.as_str()).map(str::to_string).collect();
            if no_merge {
                parts
            } else {
                parts.into_iter().filter(|f| !f.is_empty()).collect()
            }
        }
        _ => {
            if no_merge {
                line.split([' ', '\t']).map(str::to_string).collect()
            } else {
                line.split([' ', '\t'])
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect()
            }
        }
    }
}

fn column_widths(rows: &[Vec<String>]) -> Vec<usize> {
    let mut widths: Vec<usize> = Vec::new();
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            let w = cell.chars().count();
            if i >= widths.len() {
                widths.push(w);
            } else if w > widths[i] {
                widths[i] = w;
            }
        }
    }
    widths
}

fn column_format_table(rows: &[Vec<String>], out_sep: &str) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let widths = column_widths(rows);
    let mut out = String::new();
    for (ri, row) in rows.iter().enumerate() {
        if ri > 0 {
            out.push('\n');
        }
        for (i, cell) in row.iter().enumerate() {
            if i > 0 {
                out.push_str(out_sep);
            }
            out.push_str(cell);
            if i < row.len() - 1 {
                out.push_str(&" ".repeat(widths[i].saturating_sub(cell.chars().count())));
            }
        }
    }
    out
}

fn column_format_fill(items: &[String], width: i64, out_sep: &str) -> String {
    if items.is_empty() {
        return String::new();
    }
    let max_item_width = items.iter().map(|i| i.chars().count()).max().unwrap_or(0);
    let sep_width = out_sep.chars().count();
    let column_width = (max_item_width + sep_width).max(1);
    let num_columns = (((width.max(0) as usize) + sep_width) / column_width).max(1);
    let num_rows = items.len().div_ceil(num_columns);

    let mut out = String::new();
    for row in 0..num_rows {
        if row > 0 {
            out.push('\n');
        }
        let mut emitted = false;
        for col in 0..num_columns {
            let index = col * num_rows + row;
            if index < items.len() {
                let is_last_in_row =
                    col == num_columns - 1 || (col + 1) * num_rows + row >= items.len();
                if emitted {
                    out.push_str(out_sep);
                }
                out.push_str(&items[index]);
                if !is_last_in_row {
                    out.push_str(
                        &" ".repeat(max_item_width.saturating_sub(items[index].chars().count())),
                    );
                }
                emitted = true;
            }
        }
    }
    out
}

pub fn column(interp: &Interpreter, args: &[String], stdin: &str) -> CommandOutput {
    let mut table = false;
    let mut separator: Option<String> = None;
    let mut output_sep: Option<String> = None;
    let mut width: i64 = 80;
    let mut no_merge = false;
    let mut files: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-t" => table = true,
            "-s" if i + 1 < args.len() => {
                i += 1;
                separator = Some(args[i].clone());
            }
            "-o" if i + 1 < args.len() => {
                i += 1;
                output_sep = Some(args[i].clone());
            }
            "-c" if i + 1 < args.len() => {
                i += 1;
                match args[i].parse::<i64>() {
                    Ok(w) => width = w,
                    Err(_) => return fail(format!("column: invalid width: {}\n", args[i]), 1),
                }
            }
            "-n" => no_merge = true,
            other if other.starts_with('-') && other != "-" => {
                return unknown_option("column", other);
            }
            other => files.push(other.to_string()),
        }
        i += 1;
    }
    if width <= 0 {
        return fail(format!("column: invalid width: {width}\n"), 1);
    }
    let out_sep = output_sep.unwrap_or_else(|| "  ".to_string());

    let content = match read_concat(interp, &files, "column", stdin) {
        Ok(c) => c,
        Err(e) => return e,
    };
    if content.trim().is_empty() {
        return ok(String::new());
    }
    let lines = lines_no_trailing(&content);
    let non_empty: Vec<&str> = lines.into_iter().filter(|l| !l.trim().is_empty()).collect();

    let mut output = if table {
        let rows: Vec<Vec<String>> = non_empty
            .iter()
            .map(|l| column_split_fields(l, &separator, no_merge))
            .collect();
        column_format_table(&rows, &out_sep)
    } else {
        let items: Vec<String> = non_empty
            .iter()
            .flat_map(|l| column_split_fields(l, &separator, no_merge))
            .collect();
        column_format_fill(&items, width, &out_sep)
    };
    if !output.is_empty() {
        output.push('\n');
    }
    ok(output)
}

// ---------------------------------------------------------------------
// paste
// ---------------------------------------------------------------------

fn join_with_delimiters(parts: &[String], delimiters: &str) -> String {
    if parts.is_empty() {
        return String::new();
    }
    if parts.len() == 1 {
        return parts[0].clone();
    }
    if delimiters.is_empty() {
        return parts.concat();
    }
    let delim_chars: Vec<char> = delimiters.chars().collect();
    let mut result = parts[0].clone();
    for (i, part) in parts.iter().enumerate().skip(1) {
        result.push(delim_chars[(i - 1) % delim_chars.len()]);
        result.push_str(part);
    }
    result
}

pub fn paste(interp: &Interpreter, args: &[String], stdin: &str) -> CommandOutput {
    let mut delimiter = "\t".to_string();
    let mut serial = false;
    let mut files: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-d" | "--delimiters" if i + 1 < args.len() => {
                i += 1;
                delimiter = args[i].clone();
            }
            _ if arg.starts_with("-d") && arg.len() > 2 => delimiter = arg[2..].to_string(),
            "-s" | "--serial" => serial = true,
            other if other.starts_with('-') && other != "-" => {
                return unknown_option("paste", other);
            }
            other => files.push(other.to_string()),
        }
        i += 1;
    }
    if files.is_empty() {
        return fail(
            "usage: paste [-s] [-d delimiters] file ...\n".to_string(),
            1,
        );
    }

    let stdin_lines: Vec<&str> = lines_no_trailing(stdin);
    let stdin_count = files.iter().filter(|f| f.as_str() == "-").count();

    let mut file_contents: Vec<Vec<String>> = Vec::new();
    let mut stdin_index = 0;
    for file in &files {
        if file == "-" {
            let mut this_stdin = Vec::new();
            let mut idx = stdin_index;
            while idx < stdin_lines.len() {
                this_stdin.push(stdin_lines[idx].to_string());
                idx += stdin_count;
            }
            file_contents.push(this_stdin);
            stdin_index += 1;
        } else {
            let path = normalize_path(&interp.cwd, file);
            match interp.fs.read_file(&path).as_deref() {
                Some(bytes) => {
                    let content = String::from_utf8_lossy(bytes).into_owned();
                    file_contents.push(
                        lines_no_trailing(&content)
                            .into_iter()
                            .map(str::to_string)
                            .collect(),
                    );
                }
                None => return fail(format!("paste: {file}: No such file or directory\n"), 1),
            }
        }
    }

    let mut output = String::new();
    if serial {
        for lines in &file_contents {
            output.push_str(&join_with_delimiters(lines, &delimiter));
            output.push('\n');
        }
    } else {
        let max_lines = file_contents.iter().map(Vec::len).max().unwrap_or(0);
        for idx in 0..max_lines {
            let parts: Vec<String> = file_contents
                .iter()
                .map(|lines| lines.get(idx).cloned().unwrap_or_default())
                .collect();
            output.push_str(&join_with_delimiters(&parts, &delimiter));
            output.push('\n');
        }
    }
    ok(output)
}

// ---------------------------------------------------------------------
// strings
// ---------------------------------------------------------------------

fn is_printable_byte(b: u8) -> bool {
    (32..=126).contains(&b) || b == 9
}

fn format_strings_offset(offset: usize, format: Option<char>) -> String {
    match format {
        Some('o') => format!("{offset:>7o} "),
        Some('x') => format!("{offset:>7x} "),
        Some('d') => format!("{offset:>7} "),
        _ => String::new(),
    }
}

fn extract_strings(bytes: &[u8], min_length: usize, offset_format: Option<char>) -> Vec<String> {
    let mut results = Vec::new();
    let mut current_length = 0usize;
    let mut string_start = 0usize;
    for (i, &b) in bytes.iter().enumerate() {
        if is_printable_byte(b) {
            if current_length == 0 {
                string_start = i;
            }
            current_length += 1;
        } else {
            if current_length >= min_length {
                let prefix = format_strings_offset(string_start, offset_format);
                results.push(format!(
                    "{prefix}{}",
                    String::from_utf8_lossy(&bytes[string_start..i])
                ));
            }
            current_length = 0;
        }
    }
    if current_length >= min_length {
        let prefix = format_strings_offset(string_start, offset_format);
        results.push(format!(
            "{prefix}{}",
            String::from_utf8_lossy(&bytes[string_start..])
        ));
    }
    results
}

pub fn strings(interp: &Interpreter, args: &[String], stdin: &str) -> CommandOutput {
    let mut min_length = 4usize;
    let mut offset_format: Option<char> = None;
    let mut files: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-n" if i + 1 < args.len() => {
                i += 1;
                match args[i].parse::<usize>() {
                    Ok(n) if n >= 1 => min_length = n,
                    _ => {
                        return fail(
                            format!("strings: invalid minimum string length: '{}'\n", args[i]),
                            1,
                        );
                    }
                }
            }
            _ if arg.starts_with("-n")
                && arg.len() > 2
                && arg[2..].bytes().all(|b| b.is_ascii_digit()) =>
            {
                min_length = arg[2..].parse().unwrap();
            }
            _ if arg.len() > 1
                && arg.starts_with('-')
                && arg[1..].bytes().all(|b| b.is_ascii_digit()) =>
            {
                min_length = arg[1..].parse().unwrap();
            }
            "-t" if i + 1 < args.len() => {
                i += 1;
                match args[i].as_str() {
                    "o" => offset_format = Some('o'),
                    "x" => offset_format = Some('x'),
                    "d" => offset_format = Some('d'),
                    other => return fail(format!("strings: invalid radix: '{other}'\n"), 1),
                }
            }
            "-a" | "--all" => {}
            "-e" if i + 1 < args.len() => {
                i += 1;
                if args[i] != "s" && args[i] != "S" {
                    return fail(format!("strings: invalid encoding: '{}'\n", args[i]), 1);
                }
            }
            "--" => {
                files.extend(args[i + 1..].iter().cloned());
                break;
            }
            "-" => files.push("-".to_string()),
            other if other.starts_with('-') && other.len() > 1 => {
                return unknown_option("strings", other);
            }
            other => files.push(other.to_string()),
        }
        i += 1;
    }

    let mut output = String::new();
    if files.is_empty() {
        let found = extract_strings(stdin.as_bytes(), min_length, offset_format);
        if !found.is_empty() {
            output = format!("{}\n", found.join("\n"));
        }
    } else {
        for file in &files {
            let bytes: Vec<u8> = if file == "-" {
                stdin.as_bytes().to_vec()
            } else {
                let path = normalize_path(&interp.cwd, file);
                match interp.fs.read_file(&path).as_deref() {
                    Some(b) => b.to_vec(),
                    None => {
                        return CommandOutput {
                            stdout: output,
                            stderr: format!("strings: {file}: No such file or directory\n"),
                            exit_code: 1,
                        };
                    }
                }
            };
            let found = extract_strings(&bytes, min_length, offset_format);
            if !found.is_empty() {
                output.push_str(&format!("{}\n", found.join("\n")));
            }
        }
    }
    ok(output)
}

// ---------------------------------------------------------------------
// split
// ---------------------------------------------------------------------
//
// Simplified: upstream's `split.ts` builds every output file under a
// staging name first, validates file *identity* (inode-style aliasing,
// hard-link/rename races) immediately before each destructive rename, and
// rolls the whole batch back on any failure -- a security-hardening layer
// against a real, shared, concurrently-mutable filesystem. This `Vfs` is
// in-memory, single-threaded, and has no aliasing, so that whole apparatus
// doesn't apply; this port writes each output file directly.

enum SplitMode {
    Lines(usize),
    Bytes(usize),
    Chunks(usize),
}

fn parse_split_size(spec: &str) -> Option<usize> {
    let split_at = spec
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(spec.len());
    let (num_part, suffix) = spec.split_at(split_at);
    if num_part.is_empty() {
        return None;
    }
    let num: usize = num_part.parse().ok()?;
    let suffix = suffix.trim_end_matches(['b', 'B']).to_uppercase();
    let mult: usize = match suffix.as_str() {
        "" => 1,
        "K" => 1024,
        "M" => 1024 * 1024,
        "G" => 1024 * 1024 * 1024,
        "T" => 1024usize.pow(4),
        "P" => 1024usize.pow(5),
        _ => return None,
    };
    num.checked_mul(mult)
}

fn generate_split_suffix(index: usize, numeric: bool, length: usize) -> String {
    if numeric {
        return format!("{index:0>length$}");
    }
    let chars: Vec<char> = "abcdefghijklmnopqrstuvwxyz".chars().collect();
    let mut suffix = vec!['a'; length];
    let mut remaining = index;
    for slot in suffix.iter_mut().rev() {
        *slot = chars[remaining % 26];
        remaining /= 26;
    }
    suffix.into_iter().collect()
}

fn split_by_lines(content: &[u8], lines_per_file: usize) -> Vec<&[u8]> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut lines = 0;
    for (i, &b) in content.iter().enumerate() {
        if b != b'\n' {
            continue;
        }
        lines += 1;
        if lines == lines_per_file {
            chunks.push(&content[start..=i]);
            start = i + 1;
            lines = 0;
        }
    }
    if start < content.len() {
        chunks.push(&content[start..]);
    }
    chunks
}

fn split_into_chunks(content: &[u8], num_chunks: usize) -> Vec<&[u8]> {
    let mut chunks = Vec::new();
    let bytes_per_chunk = content.len().div_ceil(num_chunks.max(1));
    for i in 0..num_chunks {
        let start = i * bytes_per_chunk;
        let end = (start + bytes_per_chunk).min(content.len());
        if start < end {
            chunks.push(&content[start..end]);
        }
    }
    chunks
}

pub fn split(interp: &mut Interpreter, args: &[String], stdin: &str) -> CommandOutput {
    let mut mode = SplitMode::Lines(1000);
    let mut numeric_suffix = false;
    let mut suffix_length = 2usize;
    let mut additional_suffix = String::new();
    let mut positional: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        match arg.as_str() {
            "-l" if i + 1 < args.len() => {
                i += 1;
                match args[i].parse::<usize>() {
                    Ok(n) if n >= 1 => mode = SplitMode::Lines(n),
                    _ => {
                        return fail(
                            format!("split: invalid number of lines: '{}'\n", args[i]),
                            1,
                        );
                    }
                }
            }
            _ if arg.starts_with("-l")
                && arg.len() > 2
                && arg[2..].bytes().all(|b| b.is_ascii_digit()) =>
            {
                mode = SplitMode::Lines(arg[2..].parse().unwrap());
            }
            "-b" if i + 1 < args.len() => {
                i += 1;
                match parse_split_size(&args[i]) {
                    Some(n) => mode = SplitMode::Bytes(n),
                    None => {
                        return fail(
                            format!("split: invalid number of bytes: '{}'\n", args[i]),
                            1,
                        );
                    }
                }
            }
            _ if arg.starts_with("-b") && arg.len() > 2 => match parse_split_size(&arg[2..]) {
                Some(n) => mode = SplitMode::Bytes(n),
                None => {
                    return fail(
                        format!("split: invalid number of bytes: '{}'\n", &arg[2..]),
                        1,
                    );
                }
            },
            "-n" if i + 1 < args.len() => {
                i += 1;
                match args[i].parse::<usize>() {
                    Ok(n) if n >= 1 => mode = SplitMode::Chunks(n),
                    _ => {
                        return fail(
                            format!("split: invalid number of chunks: '{}'\n", args[i]),
                            1,
                        );
                    }
                }
            }
            _ if arg.starts_with("-n")
                && arg.len() > 2
                && arg[2..].bytes().all(|b| b.is_ascii_digit()) =>
            {
                mode = SplitMode::Chunks(arg[2..].parse().unwrap());
            }
            "-a" if i + 1 < args.len() => {
                i += 1;
                match args[i].parse::<usize>() {
                    Ok(n) if n >= 1 => suffix_length = n,
                    _ => return fail(format!("split: invalid suffix length: '{}'\n", args[i]), 1),
                }
            }
            _ if arg.starts_with("-a")
                && arg.len() > 2
                && arg[2..].bytes().all(|b| b.is_ascii_digit()) =>
            {
                suffix_length = arg[2..].parse().unwrap();
            }
            "-d" | "--numeric-suffixes" => numeric_suffix = true,
            _ if arg.starts_with("--additional-suffix=") => {
                additional_suffix = arg["--additional-suffix=".len()..].to_string()
            }
            "--additional-suffix" if i + 1 < args.len() => {
                i += 1;
                additional_suffix = args[i].clone();
            }
            "--" => {
                positional.extend(args[i + 1..].iter().cloned());
                break;
            }
            other if other.starts_with('-') && other != "-" => {
                return unknown_option("split", other);
            }
            other => positional.push(other.to_string()),
        }
        i += 1;
    }

    if positional.len() > 2 {
        return fail(format!("split: extra operand '{}'\n", positional[2]), 1);
    }
    let input_file = positional
        .first()
        .cloned()
        .unwrap_or_else(|| "-".to_string());
    let prefix = positional
        .get(1)
        .cloned()
        .unwrap_or_else(|| "x".to_string());

    let content: Vec<u8> = if input_file == "-" {
        stdin.as_bytes().to_vec()
    } else {
        let path = normalize_path(&interp.cwd, &input_file);
        match interp.fs.read_file(&path).as_deref() {
            Some(b) => b.to_vec(),
            None => {
                return fail(
                    format!("split: {input_file}: No such file or directory\n"),
                    1,
                );
            }
        }
    };
    if content.is_empty() {
        return ok(String::new());
    }

    let chunks: Vec<&[u8]> = match mode {
        SplitMode::Lines(n) => split_by_lines(&content, n),
        SplitMode::Bytes(n) => content.chunks(n.max(1)).collect(),
        SplitMode::Chunks(n) => split_into_chunks(&content, n),
    };

    for (idx, chunk) in chunks.iter().enumerate() {
        let suffix = generate_split_suffix(idx, numeric_suffix, suffix_length);
        let filename = format!("{prefix}{suffix}{additional_suffix}");
        let path = normalize_path(&interp.cwd, &filename);
        if interp.fs.write_file(&path, chunk).is_err() {
            return fail("split: failed to write output\n".to_string(), 1);
        }
    }
    ok(String::new())
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

    #[test]
    fn comm_three_columns() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/a.txt", b"apple\nbanana\ncherry\n")
            .unwrap();
        bash.fs_mut()
            .write_file("/b.txt", b"banana\ncherry\ndate\n")
            .unwrap();
        let r = run(&mut bash, "comm /a.txt /b.txt");
        assert_eq!(r.stdout, "apple\n\t\tbanana\n\t\tcherry\n\tdate\n");
    }

    #[test]
    fn comm_suppress_columns() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/a.txt", b"a\nb\n").unwrap();
        bash.fs_mut().write_file("/b.txt", b"b\nc\n").unwrap();
        let r = run(&mut bash, "comm -12 /a.txt /b.txt");
        assert_eq!(r.stdout, "b\n");
    }

    #[test]
    fn join_default_field() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/a.txt", b"1 apple\n2 banana\n")
            .unwrap();
        bash.fs_mut()
            .write_file("/b.txt", b"1 red\n2 yellow\n")
            .unwrap();
        let r = run(&mut bash, "join /a.txt /b.txt");
        assert_eq!(r.stdout, "1 apple red\n2 banana yellow\n");
    }

    #[test]
    fn join_unpairable_with_dash_a() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/a.txt", b"1 apple\n3 cherry\n")
            .unwrap();
        bash.fs_mut().write_file("/b.txt", b"1 red\n").unwrap();
        let r = run(&mut bash, "join -a 1 /a.txt /b.txt");
        assert_eq!(r.stdout, "1 apple red\n3 cherry\n");
    }

    #[test]
    fn nl_numbers_nonempty_lines() {
        let mut bash = fresh();
        let r = run(&mut bash, "printf 'one\\n\\ntwo\\n' | nl");
        // A non-numbered line (default style "t") still gets the width-padding
        // and separator, just with no line number in the padding -- matches
        // upstream's own `nl.test.ts` "skips empty lines with default style".
        assert_eq!(r.stdout, "     1\tone\n      \t\n     2\ttwo\n");
    }

    #[test]
    fn nl_dash_ba_numbers_all_lines() {
        let mut bash = fresh();
        let r = run(&mut bash, "printf 'one\\n\\ntwo\\n' | nl -ba");
        assert_eq!(r.stdout, "     1\tone\n     2\t\n     3\ttwo\n");
    }

    #[test]
    fn od_default_octal_dump() {
        let mut bash = fresh();
        let r = run(&mut bash, "printf 'AB' | od");
        assert!(r.stdout.starts_with("0000000"));
        assert!(r.stdout.contains("101")); // 'A' == 0o101
        assert!(r.stdout.trim_end().ends_with("0000002"));
    }

    #[test]
    fn rev_reverses_each_line() {
        let mut bash = fresh();
        let r = run(&mut bash, "echo hello | rev");
        assert_eq!(r.stdout, "olleh\n");
    }

    #[test]
    fn fold_wraps_at_width() {
        let mut bash = fresh();
        let r = run(&mut bash, "echo -n '1234567890' | fold -w 4");
        assert_eq!(r.stdout, "1234\n5678\n90");
    }

    #[test]
    fn fold_breaks_at_spaces() {
        // Matches upstream's own `fold.test.ts` "breaks at spaces with -s"
        // fixture, including the trailing space fold -s leaves on a wrapped
        // line (the break happens *after* the space, not before it).
        let mut bash = fresh();
        let r = run(&mut bash, "echo 'abc defgh' | fold -sw 6");
        assert_eq!(r.stdout, "abc \ndefgh\n");
        let r = run(&mut bash, "echo 'hello world foo bar' | fold -sw 10");
        assert_eq!(r.stdout, "hello \nworld foo \nbar\n");
    }

    #[test]
    fn expand_converts_tabs_to_spaces() {
        let mut bash = fresh();
        let r = run(&mut bash, "printf 'a\\tb\\n' | expand");
        assert_eq!(r.stdout, "a       b\n");
    }

    #[test]
    fn expand_custom_tab_width() {
        let mut bash = fresh();
        let r = run(&mut bash, "printf 'a\\tb\\n' | expand -t 4");
        assert_eq!(r.stdout, "a   b\n");
    }

    #[test]
    fn unexpand_converts_leading_spaces_to_tabs() {
        let mut bash = fresh();
        let r = run(&mut bash, "printf '        x\\n' | unexpand");
        assert_eq!(r.stdout, "\tx\n");
    }

    #[test]
    fn column_fill_mode() {
        let mut bash = fresh();
        let r = run(&mut bash, "printf 'a\\nb\\nc\\n' | column -c 10");
        assert_eq!(r.stdout, "a  b  c\n");
    }

    #[test]
    fn column_table_mode() {
        let mut bash = fresh();
        let r = run(&mut bash, "printf 'a 1\\nbb 22\\n' | column -t");
        assert_eq!(r.stdout, "a   1\nbb  22\n");
    }

    #[test]
    fn paste_merges_lines() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/a.txt", b"1\n2\n3\n").unwrap();
        bash.fs_mut().write_file("/b.txt", b"a\nb\nc\n").unwrap();
        let r = run(&mut bash, "paste /a.txt /b.txt");
        assert_eq!(r.stdout, "1\ta\n2\tb\n3\tc\n");
    }

    #[test]
    fn paste_serial_mode() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/a.txt", b"1\n2\n3\n").unwrap();
        let r = run(&mut bash, "paste -s /a.txt");
        assert_eq!(r.stdout, "1\t2\t3\n");
    }

    #[test]
    fn strings_extracts_printable_runs() {
        let mut bash = fresh();
        let r = run(&mut bash, r#"printf 'ab\x01cdef\x02gh' | strings -n 3"#);
        assert_eq!(r.stdout, "cdef\n");
    }

    #[test]
    fn split_by_lines() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/f.txt", b"1\n2\n3\n4\n").unwrap();
        let r = run(&mut bash, "split -l 2 /f.txt /prefix");
        assert_eq!(r.exit_code, 0);
        assert_eq!(
            bash.fs().read_file("/prefixaa").as_deref(),
            Some(&b"1\n2\n"[..])
        );
        assert_eq!(
            bash.fs().read_file("/prefixab").as_deref(),
            Some(&b"3\n4\n"[..])
        );
    }

    #[test]
    fn split_numeric_suffix() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/f.txt", b"1\n2\n3\n").unwrap();
        run(&mut bash, "split -l 1 -d /f.txt /p");
        assert_eq!(bash.fs().read_file("/p00").as_deref(), Some(&b"1\n"[..]));
        assert_eq!(bash.fs().read_file("/p01").as_deref(), Some(&b"2\n"[..]));
        assert_eq!(bash.fs().read_file("/p02").as_deref(), Some(&b"3\n"[..]));
    }
}
