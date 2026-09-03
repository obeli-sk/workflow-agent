//! PORT (simplified): vendor/just-bash/src/commands/{cp,mv,rmdir,chmod,
//! readlink,ln,file,du,tree}/*.ts
//!
//! Filesystem-adjacent commands grouped together. `cp`/`mv`/`rmdir`/`du`/
//! `tree` operate directly over `Vfs`'s file/directory primitives the same
//! way `ls`/`find` already do. `chmod`/`readlink`/`ln` are
//! argument-validating stand-ins rather than full ports because this
//! port's `Vfs` (`fs.rs`) has no permission bits and no symlinks -- see
//! each function's doc comment for the exact simplification.

use super::{fail, mime_for_path, normalize_path, ok, unknown_option};
use crate::fs::FileReadError;
use crate::interpreter::{CommandOutput, Interpreter};

/// Join an absolute, normalized `Vfs` path with a child name.
fn join_path(base: &str, name: &str) -> String {
    if base == "/" {
        format!("/{name}")
    } else {
        format!("{base}/{name}")
    }
}

/// Join a *display* path (may be `.`, relative, or absolute, exactly as the
/// user typed the operand) with a child name, without normalizing it.
fn join_display(display: &str, name: &str) -> String {
    if display == "." {
        name.to_string()
    } else {
        format!("{}/{name}", display.trim_end_matches('/'))
    }
}

fn copy_tree(fs: &mut crate::fs::Vfs, src: &str, dest: &str) {
    if fs.is_dir(src) {
        let _ = fs.mkdir(dest, true);
        if let Some(entries) = fs.readdir(src) {
            for entry in entries {
                copy_tree(fs, &join_path(src, &entry), &join_path(dest, &entry));
            }
        }
    } else {
        // A lazily-mounted, unmodified file copies by reference (its content
        // digest), so `cp`/`mv` never pull a component blob out of the CAS.
        fs.copy_file(src, dest);
    }
}

// ---------------------------------------------------------------------
// cp
// ---------------------------------------------------------------------

pub fn cp(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    let mut recursive = false;
    let mut no_clobber = false;
    let mut verbose = false;
    let mut operands: Vec<String> = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-r" | "-R" | "--recursive" => recursive = true,
            "-n" | "--no-clobber" => no_clobber = true,
            "-v" | "--verbose" => verbose = true,
            "-p" | "--preserve" => {} // no-op: Vfs has no timestamps/metadata to preserve
            other if other.starts_with("--") => return unknown_option("cp", other),
            other if other.starts_with('-') && other.len() > 1 && other != "-" => {
                for c in other[1..].chars() {
                    match c {
                        'r' | 'R' => recursive = true,
                        'n' => no_clobber = true,
                        'v' => verbose = true,
                        'p' => {}
                        _ => return unknown_option("cp", &format!("-{c}")),
                    }
                }
            }
            other => operands.push(other.to_string()),
        }
    }
    if operands.len() < 2 {
        return fail("cp: missing destination file operand\n".to_string(), 1);
    }
    let dest = operands.pop().unwrap();
    let sources = operands;
    let dest_path = normalize_path(&interp.cwd, &dest);
    let dest_is_dir = interp.fs.is_dir(&dest_path);

    if sources.len() > 1 && !dest_is_dir {
        return fail(format!("cp: target '{dest}' is not a directory\n"), 1);
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = 0;
    for src in &sources {
        let src_path = normalize_path(&interp.cwd, src);
        if !interp.fs.exists(&src_path) {
            stderr.push_str(&format!(
                "cp: cannot stat '{src}': No such file or directory\n"
            ));
            exit_code = 1;
            continue;
        }
        let target_path = if dest_is_dir {
            join_path(&dest_path, src.rsplit('/').next().unwrap_or(src))
        } else {
            dest_path.clone()
        };
        let src_is_dir = interp.fs.is_dir(&src_path);
        if src_is_dir && !recursive {
            stderr.push_str(&format!(
                "cp: -r not specified; omitting directory '{src}'\n"
            ));
            exit_code = 1;
            continue;
        }
        if src_is_dir
            && (target_path == src_path || target_path.starts_with(&format!("{src_path}/")))
        {
            stderr.push_str(&format!(
                "cp: cannot copy '{src}' into itself, '{target_path}'\n"
            ));
            exit_code = 1;
            continue;
        }
        if no_clobber && interp.fs.exists(&target_path) {
            continue;
        }
        if !src_is_dir && src_path == target_path {
            stderr.push_str(&format!(
                "cp: '{src}' and '{target_path}' are the same file\n"
            ));
            exit_code = 1;
            continue;
        }
        copy_tree(&mut interp.fs, &src_path, &target_path);
        if verbose {
            stdout.push_str(&format!("'{src}' -> '{target_path}'\n"));
        }
    }
    CommandOutput {
        stdout,
        stderr,
        exit_code,
    }
}

// ---------------------------------------------------------------------
// mv
// ---------------------------------------------------------------------

pub fn mv(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    let mut no_clobber = false;
    let mut verbose = false;
    let mut operands: Vec<String> = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-f" | "--force" => {}
            "-n" | "--no-clobber" => no_clobber = true,
            "-v" | "--verbose" => verbose = true,
            other if other.starts_with("--") => return unknown_option("mv", other),
            other if other.starts_with('-') && other.len() > 1 && other != "-" => {
                for c in other[1..].chars() {
                    match c {
                        'f' => {}
                        'n' => no_clobber = true,
                        'v' => verbose = true,
                        _ => return unknown_option("mv", &format!("-{c}")),
                    }
                }
            }
            other => operands.push(other.to_string()),
        }
    }
    if operands.len() < 2 {
        return fail("mv: missing destination file operand\n".to_string(), 1);
    }
    let dest = operands.pop().unwrap();
    let sources = operands;
    let dest_path = normalize_path(&interp.cwd, &dest);
    let dest_is_dir = interp.fs.is_dir(&dest_path);

    if sources.len() > 1 && !dest_is_dir {
        return fail(format!("mv: target '{dest}' is not a directory\n"), 1);
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = 0;
    for src in &sources {
        let src_path = normalize_path(&interp.cwd, src);
        if !interp.fs.exists(&src_path) {
            stderr.push_str(&format!(
                "mv: cannot stat '{src}': No such file or directory\n"
            ));
            exit_code = 1;
            continue;
        }
        let basename = src.rsplit('/').next().unwrap_or(src);
        let target_path = if dest_is_dir {
            join_path(&dest_path, basename)
        } else {
            dest_path.clone()
        };
        let src_is_dir = interp.fs.is_dir(&src_path);
        if src_is_dir
            && (target_path == src_path || target_path.starts_with(&format!("{src_path}/")))
        {
            stderr.push_str(&format!(
                "mv: cannot move '{src}' into itself, '{target_path}'\n"
            ));
            exit_code = 1;
            continue;
        }
        if no_clobber && interp.fs.exists(&target_path) {
            continue;
        }
        if src_path == target_path {
            continue; // POSIX rename onto itself succeeds without changing anything.
        }
        copy_tree(&mut interp.fs, &src_path, &target_path);
        let _ = interp.fs.remove(&src_path, true);
        if verbose {
            let target_name = if dest_is_dir {
                format!("{dest}/{basename}")
            } else {
                dest.clone()
            };
            stdout.push_str(&format!("renamed '{src}' -> '{target_name}'\n"));
        }
    }
    CommandOutput {
        stdout,
        stderr,
        exit_code,
    }
}

// ---------------------------------------------------------------------
// rmdir
// ---------------------------------------------------------------------

pub fn rmdir(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    let mut parents = false;
    let mut verbose = false;
    let mut dirs: Vec<String> = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-p" | "--parents" => parents = true,
            "-v" | "--verbose" => verbose = true,
            "--help" => {
                return ok(
                    "rmdir: remove empty directories\nUsage: rmdir [-pv] DIRECTORY...\n"
                        .to_string(),
                );
            }
            other if other.starts_with('-') && other.len() > 1 => {
                for c in other.trim_start_matches('-').chars() {
                    match c {
                        'p' => parents = true,
                        'v' => verbose = true,
                        _ => return unknown_option("rmdir", &format!("-{c}")),
                    }
                }
            }
            other => dirs.push(other.to_string()),
        }
    }
    if dirs.is_empty() {
        return fail("rmdir: missing operand\n".to_string(), 1);
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = 0;
    for dir in &dirs {
        let full = normalize_path(&interp.cwd, dir);
        match remove_single_dir(interp, &full, dir, verbose) {
            Ok(msg) => stdout.push_str(&msg),
            Err(msg) => {
                stderr.push_str(&msg);
                exit_code = 1;
                continue;
            }
        }
        if parents {
            let mut current = full;
            let mut current_display = dir.clone();
            loop {
                let trimmed = current.trim_end_matches('/');
                if trimmed.is_empty() {
                    break;
                }
                let Some(idx) = trimmed.rfind('/') else { break };
                let parent = if idx == 0 {
                    "/".to_string()
                } else {
                    trimmed[..idx].to_string()
                };
                if parent == current || parent == "/" {
                    break;
                }
                let Some(didx) = current_display.trim_end_matches('/').rfind('/') else {
                    break;
                };
                let parent_display = current_display.trim_end_matches('/')[..didx].to_string();
                if parent_display.is_empty() {
                    break;
                }
                match remove_single_dir(interp, &parent, &parent_display, verbose) {
                    Ok(msg) => {
                        stdout.push_str(&msg);
                        current = parent;
                        current_display = parent_display;
                    }
                    Err(_) => break,
                }
            }
        }
    }
    CommandOutput {
        stdout,
        stderr,
        exit_code,
    }
}

fn remove_single_dir(
    interp: &mut Interpreter,
    full: &str,
    display: &str,
    verbose: bool,
) -> Result<String, String> {
    if !interp.fs.exists(full) {
        return Err(format!(
            "rmdir: failed to remove '{display}': No such file or directory\n"
        ));
    }
    if !interp.fs.is_dir(full) {
        return Err(format!(
            "rmdir: failed to remove '{display}': Not a directory\n"
        ));
    }
    if interp.fs.readdir(full).is_some_and(|e| !e.is_empty()) {
        return Err(format!(
            "rmdir: failed to remove '{display}': Directory not empty\n"
        ));
    }
    // The directory is already confirmed empty above; Vfs::remove requires
    // `recursive` to remove *any* directory (even an empty one, unlike
    // POSIX rmdir), so pass `true` here -- there is nothing to recurse into.
    interp
        .fs
        .remove(full, true)
        .map_err(|_| format!("rmdir: failed to remove '{display}'\n"))?;
    Ok(if verbose {
        format!("rmdir: removing directory, '{display}'\n")
    } else {
        String::new()
    })
}

// ---------------------------------------------------------------------
// chmod
// ---------------------------------------------------------------------
//
// `Vfs` (`fs.rs`) has no permission bits, so this is an argument-validating
// no-op: mode syntax and target existence are checked and a verbose message
// is printed as if the mode had been applied, but nothing is actually
// stored (there is no mode to store).

fn is_valid_mode(mode: &str) -> bool {
    if !mode.is_empty() && mode.bytes().all(|b| b.is_ascii_digit() && b < b'8') {
        return true;
    }
    !mode.is_empty()
        && mode.split(',').all(|part| {
            let bytes = part.as_bytes();
            let mut i = 0;
            while i < bytes.len() && matches!(bytes[i], b'u' | b'g' | b'o' | b'a') {
                i += 1;
            }
            if i >= bytes.len() || !matches!(bytes[i], b'+' | b'-' | b'=') {
                return false;
            }
            i += 1;
            bytes[i..]
                .iter()
                .all(|b| matches!(b, b'r' | b'w' | b'x' | b'X' | b's' | b't'))
        })
}

/// Whether applying `mode` leaves a file's owner-execute bit set. The VFS
/// models only the execute bit (`Vfs::executable`); read/write bits stay a
/// no-op. `None` means the mode does not touch execute (leave it as-is).
fn mode_sets_execute(mode: &str) -> Option<bool> {
    // Octal: the owner digit (third-from-right) carries the execute bit (1).
    if mode.bytes().all(|b| b.is_ascii_digit()) {
        let owner = mode
            .chars()
            .rev()
            .nth(2)
            .and_then(|c| c.to_digit(8))
            .unwrap_or(0);
        return Some(owner & 1 != 0);
    }
    // Symbolic: apply each comma part in order; the last one touching `x` wins.
    let mut result = None;
    for part in mode.split(',') {
        let split = part.find(['+', '-', '=']).unwrap_or(0);
        let (classes, rest) = part.split_at(split);
        let op = rest.chars().next().unwrap_or('+');
        let perms = &rest[op.len_utf8()..];
        // An unqualified op, or one naming `u`/`a`, affects the owner ("us").
        let affects_us = classes.is_empty() || classes.contains('u') || classes.contains('a');
        let has_x = perms.contains('x') || perms.contains('X');
        match op {
            '+' if affects_us && has_x => result = Some(true),
            '-' if affects_us && has_x => result = Some(false),
            '=' if affects_us => result = Some(has_x),
            _ => {}
        }
    }
    result
}

pub fn chmod(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    if args.iter().any(|a| a == "--help") {
        return ok("chmod: change file mode bits (no-op: this virtual filesystem has no permission bits)\nUsage: chmod [OPTIONS] MODE FILE...\n".to_string());
    }
    if args.len() < 2 {
        return fail("chmod: missing operand\n".to_string(), 1);
    }
    let mut verbose = false;
    let mut idx = 0;
    while idx < args.len() && args[idx].starts_with('-') && !is_valid_mode(&args[idx]) {
        match args[idx].as_str() {
            "-R" | "--recursive" => {}
            "-v" | "--verbose" => verbose = true,
            "--" => {
                idx += 1;
                break;
            }
            other if other.len() > 1 && other[1..].chars().all(|c| c == 'R' || c == 'v') => {
                verbose |= other.contains('v');
            }
            other => return unknown_option("chmod", other),
        }
        idx += 1;
    }
    if args.len() - idx < 2 {
        return fail("chmod: missing operand\n".to_string(), 1);
    }
    let mode_arg = &args[idx];
    let files = &args[idx + 1..];
    if !is_valid_mode(mode_arg) {
        return fail(format!("chmod: invalid mode: '{mode_arg}'\n"), 1);
    }
    let numeric_display = if mode_arg.bytes().all(|b| b.is_ascii_digit()) {
        format!("{:0>4}", mode_arg)
    } else {
        "0644".to_string()
    };

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut any_error = false;
    let exec_change = mode_sets_execute(mode_arg);
    for file in files {
        let path = normalize_path(&interp.cwd, file);
        if !interp.fs.exists(&path) {
            stderr.push_str(&format!(
                "chmod: cannot access '{file}': No such file or directory\n"
            ));
            any_error = true;
            continue;
        }
        if let Some(on) = exec_change {
            interp.fs.set_executable(&path, on);
        }
        if verbose {
            stdout.push_str(&format!("mode of '{file}' changed to {numeric_display}\n"));
        }
    }
    CommandOutput {
        stdout,
        stderr,
        exit_code: if any_error { 1 } else { 0 },
    }
}

// ---------------------------------------------------------------------
// readlink
// ---------------------------------------------------------------------
//
// `Vfs` has no symlinks, so no operand is ever a symbolic link. Without
// `-f`, real `readlink` fails on a non-symlink with no message (just exit
// 1) -- reproduced verbatim below. With `-f`, real `readlink` canonicalizes
// the path regardless of whether it's a symlink, which for a filesystem
// with no symlinks to follow is just the normalized absolute path.

pub fn readlink(interp: &Interpreter, args: &[String]) -> CommandOutput {
    let mut canonicalize = false;
    let mut idx = 0;
    while idx < args.len() && args[idx].starts_with('-') {
        match args[idx].as_str() {
            "-f" | "--canonicalize" => canonicalize = true,
            "--" => {
                idx += 1;
                break;
            }
            other => return unknown_option("readlink", other),
        }
        idx += 1;
    }
    let files = &args[idx..];
    if files.is_empty() {
        return fail("readlink: missing operand\n".to_string(), 1);
    }

    let mut stdout = String::new();
    let mut any_error = false;
    for file in files {
        let path = normalize_path(&interp.cwd, file);
        if canonicalize {
            stdout.push_str(&path);
            stdout.push('\n');
        } else {
            any_error = true;
        }
    }
    CommandOutput {
        stdout,
        stderr: String::new(),
        exit_code: if any_error { 1 } else { 0 },
    }
}

// ---------------------------------------------------------------------
// ln
// ---------------------------------------------------------------------
//
// `Vfs` has no symlinks or inode aliasing. `-s` is argument-validated then
// rejected (no real symlink can be created); a plain hard link is
// approximated by copying the target's content under the new name (unlike
// a real hard link, later writes to one name will not appear under the
// other -- there is no shared inode in this Vfs).

pub fn ln(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    let mut symbolic = false;
    let mut force = false;
    let mut verbose = false;
    let mut idx = 0;
    while idx < args.len() && args[idx].starts_with('-') {
        match args[idx].as_str() {
            "-s" | "--symbolic" => symbolic = true,
            "-f" | "--force" => force = true,
            "-v" | "--verbose" => verbose = true,
            "-n" | "--no-dereference" => {}
            "--" => {
                idx += 1;
                break;
            }
            other if other.len() > 1 && other[1..].chars().all(|c| "sfvn".contains(c)) => {
                symbolic |= other.contains('s');
                force |= other.contains('f');
                verbose |= other.contains('v');
            }
            other => return unknown_option("ln", other),
        }
        idx += 1;
    }
    let remaining = &args[idx..];
    if remaining.len() < 2 {
        return fail("ln: missing file operand\n".to_string(), 1);
    }
    if remaining.len() > 2 {
        return fail(format!("ln: extra operand '{}'\n", remaining[2]), 1);
    }
    let target = &remaining[0];
    let link_name = &remaining[1];
    let link_path = normalize_path(&interp.cwd, link_name);

    if interp.fs.exists(&link_path) {
        if force {
            let _ = interp.fs.remove(&link_path, false);
        } else {
            let kind = if symbolic { "symbolic " } else { "" };
            return fail(
                format!("ln: failed to create {kind}link '{link_name}': File exists\n"),
                1,
            );
        }
    }

    if symbolic {
        return fail(
            "ln: symbolic links are not supported by this virtual filesystem\n".to_string(),
            1,
        );
    }

    let target_path = normalize_path(&interp.cwd, target);
    if interp.fs.is_dir(&target_path) {
        return fail(
            format!("ln: '{target}': hard link not allowed for directory\n"),
            1,
        );
    }
    let Some(data) = interp.fs.read_file(&target_path) else {
        return fail(
            format!("ln: failed to access '{target}': No such file or directory\n"),
            1,
        );
    };
    let _ = interp.fs.write_file(&link_path, &data);

    let stdout = if verbose {
        format!("'{link_name}' -> '{target}'\n")
    } else {
        String::new()
    };
    ok(stdout)
}

// ---------------------------------------------------------------------
// file
// ---------------------------------------------------------------------
//
// Simplified type detection (partial subset, same call as jq/awk): upstream
// uses the `file-type` npm package's full magic-byte signature database.
// This port recognizes a handful of common binary signatures plus the
// shebang/XML/extension/ASCII-vs-UTF-8 text heuristics.

pub fn file(interp: &Interpreter, args: &[String]) -> CommandOutput {
    let mut brief = false;
    let mut mime_mode = false;
    let mut files: Vec<&String> = Vec::new();
    for arg in args {
        if let Some(long) = arg.strip_prefix("--") {
            match long {
                "brief" => brief = true,
                "mime" | "mime-type" => mime_mode = true,
                "dereference" => {}
                _ => return unknown_option("file", arg),
            }
        } else if arg.starts_with('-') && arg != "-" {
            for c in arg[1..].chars() {
                match c {
                    'b' => brief = true,
                    'i' => mime_mode = true,
                    'L' => {}
                    _ => return unknown_option("file", &format!("-{c}")),
                }
            }
        } else {
            files.push(arg);
        }
    }
    if files.is_empty() {
        return fail("Usage: file [-bLi] FILE...\n".to_string(), 1);
    }

    let mut stdout = String::new();
    let mut exit_code = 0;
    for file in &files {
        let path = normalize_path(&interp.cwd, file);
        if !interp.fs.exists(&path) {
            stdout.push_str(&if brief {
                "cannot open\n".to_string()
            } else {
                format!("{file}: cannot open (No such file or directory)\n")
            });
            exit_code = 1;
            continue;
        }
        let (desc, mime) = if interp.fs.is_dir(&path) {
            ("directory".to_string(), "inode/directory".to_string())
        } else {
            match interp.fs.read_file_checked(&path) {
                Ok(bytes) => detect_file_type(file, &bytes),
                Err(FileReadError::TooLarge { .. }) => {
                    let mime = mime_for_path(file).to_string();
                    (mime.clone(), mime)
                }
                Err(FileReadError::NotFound(_) | FileReadError::Unavailable(_)) => (
                    "cannot open".to_string(),
                    "application/octet-stream".to_string(),
                ),
            }
        };
        let result = if mime_mode { &mime } else { &desc };
        stdout.push_str(&if brief {
            format!("{result}\n")
        } else {
            format!("{file}: {result}\n")
        });
    }
    CommandOutput {
        stdout,
        stderr: String::new(),
        exit_code,
    }
}

fn detect_file_type(filename: &str, bytes: &[u8]) -> (String, String) {
    if bytes.is_empty() {
        return ("empty".to_string(), "inode/x-empty".to_string());
    }
    const MAGICS: &[(&[u8], &str, &str)] = &[
        (b"\x89PNG\r\n\x1a\n", "PNG image data", "image/png"),
        (b"\xFF\xD8\xFF", "JPEG image data", "image/jpeg"),
        (b"GIF87a", "GIF image data", "image/gif"),
        (b"GIF89a", "GIF image data", "image/gif"),
        (b"%PDF", "PDF document", "application/pdf"),
        (b"PK\x03\x04", "Zip archive data", "application/zip"),
        (b"\x1f\x8b", "gzip compressed data", "application/gzip"),
        (b"\x7fELF", "ELF executable", "application/x-elf"),
    ];
    for (magic, desc, mime) in MAGICS {
        if bytes.starts_with(magic) {
            return ((*desc).to_string(), (*mime).to_string());
        }
    }
    let text = String::from_utf8_lossy(bytes);
    detect_text_type(&text, filename)
}

fn detect_text_type(content: &str, filename: &str) -> (String, String) {
    if let Some(rest) = content.strip_prefix("#!") {
        let first_line = rest.lines().next().unwrap_or("");
        let (desc, mime) = if first_line.contains("python") {
            ("Python script, ASCII text executable", "text/x-python")
        } else if first_line.contains("node")
            || first_line.contains("bun")
            || first_line.contains("deno")
        {
            (
                "JavaScript script, ASCII text executable",
                "text/javascript",
            )
        } else if first_line.contains("bash") {
            (
                "Bourne-Again shell script, ASCII text executable",
                "text/x-shellscript",
            )
        } else if first_line.contains("sh") {
            (
                "POSIX shell script, ASCII text executable",
                "text/x-shellscript",
            )
        } else {
            ("script, ASCII text executable", "text/plain")
        };
        return (desc.to_string(), mime.to_string());
    }

    let trimmed = content.trim_start();
    if trimmed.starts_with("<?xml") {
        return ("XML document".to_string(), "application/xml".to_string());
    }
    if trimmed.starts_with("<!DOCTYPE html") || trimmed.to_lowercase().starts_with("<html") {
        return ("HTML document".to_string(), "text/html".to_string());
    }

    let basename = filename.rsplit('/').next().unwrap_or(filename);
    if let Some((_, ext)) = basename.rsplit_once('.')
        && let Some((desc, mime)) = extension_type(&ext.to_lowercase())
    {
        return (desc.to_string(), mime.to_string());
    }

    if content.chars().any(|c| c as u32 > 127) {
        (
            "UTF-8 Unicode text".to_string(),
            "text/plain; charset=utf-8".to_string(),
        )
    } else {
        ("ASCII text".to_string(), "text/plain".to_string())
    }
}

fn extension_type(ext: &str) -> Option<(&'static str, &'static str)> {
    Some(match ext {
        "js" | "mjs" | "cjs" => ("JavaScript source", "text/javascript"),
        "ts" => ("TypeScript source", "text/typescript"),
        "py" => ("Python script", "text/x-python"),
        "rb" => ("Ruby script", "text/x-ruby"),
        "go" => ("Go source", "text/x-go"),
        "rs" => ("Rust source", "text/x-rust"),
        "c" | "h" => ("C source", "text/x-c"),
        "sh" | "bash" => ("Bourne-Again shell script", "text/x-shellscript"),
        "json" => ("JSON data", "application/json"),
        "yaml" | "yml" => ("YAML data", "text/yaml"),
        "xml" => ("XML document", "application/xml"),
        "html" | "htm" => ("HTML document", "text/html"),
        "css" => ("CSS stylesheet", "text/css"),
        "md" | "markdown" => ("Markdown document", "text/markdown"),
        "txt" => ("ASCII text", "text/plain"),
        "wasm" => ("WebAssembly binary module", "application/wasm"),
        _ => return None,
    })
}

// ---------------------------------------------------------------------
// du
// ---------------------------------------------------------------------

struct DuOpts {
    all_files: bool,
    human: bool,
    summarize: bool,
    max_depth: Option<usize>,
}

fn format_size(bytes: u64, human: bool) -> String {
    if !human {
        let blocks = bytes.div_ceil(1024);
        return format!("{}", if blocks == 0 { 1 } else { blocks });
    }
    if bytes < 1024 {
        format!("{bytes}")
    } else if bytes < 1024 * 1024 {
        format!("{:.1}K", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1}M", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.1}G", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

fn du_walk(
    interp: &Interpreter,
    full: &str,
    display: &str,
    depth: usize,
    opts: &DuOpts,
    out: &mut String,
) -> u64 {
    if interp.fs.is_dir(full) {
        let mut total = 0u64;
        if let Some(entries) = interp.fs.readdir(full) {
            for entry in entries {
                total += du_walk(
                    interp,
                    &join_path(full, &entry),
                    &join_display(display, &entry),
                    depth + 1,
                    opts,
                    out,
                );
            }
        }
        if !opts.summarize && opts.max_depth.is_none_or(|m| depth <= m) {
            out.push_str(&format!(
                "{}\t{}\n",
                format_size(total, opts.human),
                display
            ));
        }
        total
    } else {
        let size = interp.fs.file_size(full).unwrap_or(0);
        if !opts.summarize && (opts.all_files || depth == 0) {
            out.push_str(&format!("{}\t{}\n", format_size(size, opts.human), display));
        }
        size
    }
}

pub fn du(interp: &Interpreter, args: &[String]) -> CommandOutput {
    let mut all_files = false;
    let mut human = false;
    let mut summarize = false;
    let mut grand_total = false;
    let mut max_depth: Option<usize> = None;
    let mut targets: Vec<String> = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-a" => all_files = true,
            "-h" => human = true,
            "-s" => summarize = true,
            "-c" => grand_total = true,
            "--help" => {
                return ok(
                    "du: estimate file space usage\nUsage: du [OPTION]... [FILE]...\n".to_string(),
                );
            }
            other if other.starts_with("--max-depth=") => {
                max_depth = other["--max-depth=".len()..].parse().ok();
            }
            other if other.starts_with('-') && other.len() > 1 => {
                for c in other[1..].chars() {
                    match c {
                        'a' => all_files = true,
                        'h' => human = true,
                        's' => summarize = true,
                        'c' => grand_total = true,
                        _ => return unknown_option("du", &format!("-{c}")),
                    }
                }
            }
            other => targets.push(other.to_string()),
        }
    }
    if targets.is_empty() {
        targets.push(".".to_string());
    }

    let opts = DuOpts {
        all_files,
        human,
        summarize,
        max_depth,
    };
    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut grand = 0u64;
    for target in &targets {
        let full = normalize_path(&interp.cwd, target);
        if !interp.fs.exists(&full) {
            stderr.push_str(&format!(
                "du: cannot access '{target}': No such file or directory\n"
            ));
            continue;
        }
        let mut per_target = String::new();
        let total = du_walk(interp, &full, target, 0, &opts, &mut per_target);
        grand += total;
        if summarize {
            stdout.push_str(&format!("{}\t{}\n", format_size(total, human), target));
        } else {
            stdout.push_str(&per_target);
        }
    }
    if grand_total && !targets.is_empty() {
        stdout.push_str(&format!("{}\ttotal\n", format_size(grand, human)));
    }
    let exit_code = if stderr.is_empty() { 0 } else { 1 };
    CommandOutput {
        stdout,
        stderr,
        exit_code,
    }
}

// ---------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn build_tree(
    interp: &Interpreter,
    full: &str,
    prefix: &str,
    depth: usize,
    max_depth: Option<usize>,
    show_hidden: bool,
    dirs_only: bool,
    full_path: bool,
    out: &mut String,
) -> (u32, u32) {
    if max_depth.is_some_and(|m| depth >= m) {
        return (0, 0);
    }
    let mut entries: Vec<(String, bool)> = interp
        .fs
        .readdir(full)
        .unwrap_or_default()
        .into_iter()
        .map(|name| {
            let is_dir = interp.fs.is_dir(&join_path(full, &name));
            (name, is_dir)
        })
        .filter(|(name, is_dir)| (show_hidden || !name.starts_with('.')) && (!dirs_only || *is_dir))
        .collect();
    entries.sort_by(|a, b| crate::commands::locale_compare(&a.0, &b.0));

    let mut dir_count = 0;
    let mut file_count = 0;
    let len = entries.len();
    for (i, (name, is_dir)) in entries.iter().enumerate() {
        let entry_full = join_path(full, name);
        let is_last = i == len - 1;
        let connector = if is_last { "`-- " } else { "|-- " };
        let child_prefix = format!("{prefix}{}", if is_last { "    " } else { "|   " });
        let shown = if full_path {
            entry_full.as_str()
        } else {
            name.as_str()
        };
        out.push_str(&format!("{prefix}{connector}{shown}\n"));
        if *is_dir {
            dir_count += 1;
            let (d, f) = build_tree(
                interp,
                &entry_full,
                &child_prefix,
                depth + 1,
                max_depth,
                show_hidden,
                dirs_only,
                full_path,
                out,
            );
            dir_count += d;
            file_count += f;
        } else {
            file_count += 1;
        }
    }
    (dir_count, file_count)
}

pub fn tree(interp: &Interpreter, args: &[String]) -> CommandOutput {
    let mut show_hidden = false;
    let mut dirs_only = false;
    let mut full_path = false;
    let mut max_depth: Option<usize> = None;
    let mut targets: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-a" => show_hidden = true,
            "-d" => dirs_only = true,
            "-f" => full_path = true,
            "-L" if i + 1 < args.len() => {
                i += 1;
                max_depth = args[i].parse().ok();
            }
            "--help" => {
                return ok("tree: list contents of directories in a tree-like format\n".to_string());
            }
            other if other.starts_with('-') && other.len() > 1 => {
                for c in other[1..].chars() {
                    match c {
                        'a' => show_hidden = true,
                        'd' => dirs_only = true,
                        'f' => full_path = true,
                        _ => return unknown_option("tree", &format!("-{c}")),
                    }
                }
            }
            other => targets.push(other.to_string()),
        }
        i += 1;
    }
    if targets.is_empty() {
        targets.push(".".to_string());
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut dir_count = 0u32;
    let mut file_count = 0u32;
    for target in &targets {
        let full = normalize_path(&interp.cwd, target);
        if !interp.fs.exists(&full) {
            stderr.push_str(&format!("tree: {target}: No such file or directory\n"));
            continue;
        }
        stdout.push_str(&format!("{target}\n"));
        if !interp.fs.is_dir(&full) {
            file_count += 1;
            continue;
        }
        let (d, f) = build_tree(
            interp,
            &full,
            "",
            0,
            max_depth,
            show_hidden,
            dirs_only,
            full_path,
            &mut stdout,
        );
        dir_count += d;
        file_count += f;
    }
    stdout.push('\n');
    stdout.push_str(&format!(
        "{dir_count} director{}",
        if dir_count == 1 { "y" } else { "ies" }
    ));
    if !dirs_only {
        stdout.push_str(&format!(
            ", {file_count} file{}",
            if file_count == 1 { "" } else { "s" }
        ));
    }
    stdout.push('\n');
    let exit_code = if stderr.is_empty() { 0 } else { 1 };
    CommandOutput {
        stdout,
        stderr,
        exit_code,
    }
}

#[cfg(test)]
mod tests {
    use crate::bash::Bash;
    use crate::fs::BlobLoader;
    use crate::types::{BashOptions, ExecOptions, ExecResult};
    use std::cell::RefCell;
    use std::rc::Rc;

    fn fresh() -> Bash {
        Bash::new(BashOptions::default())
    }

    fn run(bash: &mut Bash, script: &str) -> ExecResult {
        bash.exec(script, ExecOptions::default())
    }

    /// A loader that records the digests it is asked to fetch, so a test can
    /// prove a `cp`/`mv` of a lazily-mounted file fetches nothing.
    struct RecordingLoader(RefCell<Vec<String>>);
    impl BlobLoader for RecordingLoader {
        fn load(&self, digest: &str) -> Result<Vec<u8>, String> {
            self.0.borrow_mut().push(digest.to_string());
            Ok(b"wasm-bytes".to_vec())
        }
    }

    #[test]
    fn cp_of_a_lazy_file_copies_the_reference_without_fetching() {
        let loader = Rc::new(RecordingLoader(RefCell::new(Vec::new())));
        let mut bash = fresh();
        bash.fs_mut().set_blob_loader(loader.clone());
        bash.fs_mut()
            .register_lazy("/dep/current/a.wasm", "sha256:w", 10);

        let r = run(&mut bash, "cp /dep/current/a.wasm /dep/work.wasm");
        assert_eq!(r.exit_code, 0, "stderr: {}", r.stderr);
        // The copy is still lazy (nothing fetched); reading it materializes once.
        assert!(bash.fs().is_pending("/dep/work.wasm"));
        assert!(loader.0.borrow().is_empty(), "cp must not fetch the blob");
        assert_eq!(
            bash.fs().read_file("/dep/work.wasm").as_deref(),
            Some(&b"wasm-bytes"[..])
        );
        assert_eq!(&*loader.0.borrow(), &["sha256:w".to_string()]);
    }

    #[test]
    fn cp_copies_file() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/a.txt", b"hello").unwrap();
        let r = run(&mut bash, "cp /a.txt /b.txt");
        assert_eq!(r.exit_code, 0);
        assert_eq!(
            bash.fs().read_file("/b.txt").as_deref(),
            Some(&b"hello"[..])
        );
        assert_eq!(
            bash.fs().read_file("/a.txt").as_deref(),
            Some(&b"hello"[..])
        );
    }

    #[test]
    fn cp_dir_requires_recursive() {
        let mut bash = fresh();
        bash.fs_mut().mkdir("/dir", true).unwrap();
        let r = run(&mut bash, "cp /dir /dest");
        assert!(r.stderr.contains("-r not specified"));
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn cp_recursive_copies_tree() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/dir/a.txt", b"a").unwrap();
        bash.fs_mut().write_file("/dir/sub/b.txt", b"b").unwrap();
        let r = run(&mut bash, "cp -r /dir /dest");
        assert_eq!(r.exit_code, 0);
        assert_eq!(
            bash.fs().read_file("/dest/a.txt").as_deref(),
            Some(&b"a"[..])
        );
        assert_eq!(
            bash.fs().read_file("/dest/sub/b.txt").as_deref(),
            Some(&b"b"[..])
        );
    }

    #[test]
    fn cp_recursive_of_lazy_files_copies_references_without_fetching() {
        let loader = Rc::new(RecordingLoader(RefCell::new(Vec::new())));
        let mut bash = fresh();
        bash.fs_mut().set_blob_loader(loader.clone());
        bash.fs_mut().register_lazy("/dep/current/a.wasm", "sha256:a", 10);
        bash.fs_mut().register_lazy("/dep/current/sub/b.wasm", "sha256:b", 20);

        let r = run(&mut bash, "cp -r /dep/current /dep/work");
        assert_eq!(r.exit_code, 0, "stderr: {}", r.stderr);
        assert!(bash.fs().is_pending("/dep/work/a.wasm"), "a.wasm should be pending");
        assert!(bash.fs().is_pending("/dep/work/sub/b.wasm"), "sub/b.wasm should be pending");
        assert!(loader.0.borrow().is_empty(), "recursive cp must not fetch blobs, fetched: {:?}", loader.0.borrow());
    }

    #[test]
    fn cp_multiple_sources_need_dir_dest() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/a.txt", b"a").unwrap();
        bash.fs_mut().write_file("/b.txt", b"b").unwrap();
        let r = run(&mut bash, "cp /a.txt /b.txt /notadir.txt");
        assert!(r.stderr.contains("is not a directory"));
    }

    #[test]
    fn mv_renames_file() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/a.txt", b"hello").unwrap();
        let r = run(&mut bash, "mv /a.txt /b.txt");
        assert_eq!(r.exit_code, 0);
        assert!(!bash.fs().exists("/a.txt"));
        assert_eq!(
            bash.fs().read_file("/b.txt").as_deref(),
            Some(&b"hello"[..])
        );
    }

    #[test]
    fn mv_into_directory() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/a.txt", b"hi").unwrap();
        bash.fs_mut().mkdir("/dir", true).unwrap();
        run(&mut bash, "mv /a.txt /dir");
        assert_eq!(
            bash.fs().read_file("/dir/a.txt").as_deref(),
            Some(&b"hi"[..])
        );
    }

    #[test]
    fn rmdir_removes_empty_dir() {
        let mut bash = fresh();
        bash.fs_mut().mkdir("/empty", true).unwrap();
        let r = run(&mut bash, "rmdir /empty");
        assert_eq!(r.exit_code, 0);
        assert!(!bash.fs().exists("/empty"));
    }

    #[test]
    fn rmdir_fails_on_nonempty() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/dir/f.txt", b"x").unwrap();
        let r = run(&mut bash, "rmdir /dir");
        assert!(r.stderr.contains("Directory not empty"));
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn rmdir_dash_p_removes_ancestors() {
        let mut bash = fresh();
        bash.fs_mut().mkdir("/a/b/c", true).unwrap();
        let r = run(&mut bash, "rmdir -p /a/b/c");
        assert_eq!(r.exit_code, 0);
        assert!(!bash.fs().exists("/a"));
    }

    #[test]
    fn chmod_validates_mode_and_target() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/f.txt", b"x").unwrap();
        let r = run(&mut bash, "chmod 755 /f.txt");
        assert_eq!(r.exit_code, 0);
        let r = run(&mut bash, "chmod 755 /missing.txt");
        assert!(r.stderr.contains("No such file or directory"));
        let r = run(&mut bash, "chmod not-a-mode /f.txt");
        assert!(r.stderr.contains("invalid mode"));
    }

    #[test]
    fn chmod_symbolic_mode_verbose() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/f.txt", b"x").unwrap();
        let r = run(&mut bash, "chmod -v u+x /f.txt");
        assert!(r.stdout.contains("mode of '/f.txt' changed to"));
    }

    #[test]
    fn readlink_dash_f_canonicalizes() {
        let mut bash = fresh();
        let r = run(&mut bash, "mkdir -p /a/b; cd /a/b; readlink -f ../c");
        assert_eq!(r.stdout, "/a/c\n");
    }

    #[test]
    fn readlink_without_f_fails_on_non_symlink() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/f.txt", b"x").unwrap();
        let r = run(&mut bash, "readlink /f.txt");
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn ln_hard_link_copies_content() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/a.txt", b"hello").unwrap();
        let r = run(&mut bash, "ln /a.txt /b.txt");
        assert_eq!(r.exit_code, 0);
        assert_eq!(
            bash.fs().read_file("/b.txt").as_deref(),
            Some(&b"hello"[..])
        );
    }

    #[test]
    fn ln_missing_target_errors() {
        let mut bash = fresh();
        let r = run(&mut bash, "ln /missing.txt /b.txt");
        assert!(r.stderr.contains("No such file or directory"));
    }

    #[test]
    fn ln_symbolic_is_rejected() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/a.txt", b"hello").unwrap();
        let r = run(&mut bash, "ln -s /a.txt /b.txt");
        assert_eq!(r.exit_code, 1);
        assert!(r.stderr.contains("not supported"));
    }

    #[test]
    fn file_detects_directory_and_empty() {
        let mut bash = fresh();
        bash.fs_mut().mkdir("/dir", true).unwrap();
        bash.fs_mut().write_file("/empty.txt", b"").unwrap();
        let r = run(&mut bash, "file /dir /empty.txt");
        assert!(r.stdout.contains("/dir: directory"));
        assert!(r.stdout.contains("/empty.txt: empty"));
    }

    #[test]
    fn file_detects_text_and_extension() {
        let mut bash = fresh();
        bash.fs_mut()
            .write_file("/script.sh", b"#!/bin/bash\necho hi\n")
            .unwrap();
        bash.fs_mut().write_file("/data.json", b"{}").unwrap();
        let r = run(&mut bash, "file /script.sh /data.json");
        assert!(r.stdout.contains("shell script"));
        assert!(r.stdout.contains("JSON data"));
    }

    #[test]
    fn file_missing_errors() {
        let mut bash = fresh();
        let r = run(&mut bash, "file /missing.txt");
        assert_eq!(r.exit_code, 1);
        assert!(r.stdout.contains("cannot open"));
    }

    #[test]
    fn du_reports_sizes() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/dir/a.txt", b"12345").unwrap();
        bash.fs_mut()
            .write_file("/dir/b.txt", b"1234567890")
            .unwrap();
        let r = run(&mut bash, "du -s /dir");
        assert_eq!(r.stdout, "1\t/dir\n");
    }

    #[test]
    fn du_all_files_shows_each_entry() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/dir/a.txt", b"x").unwrap();
        let r = run(&mut bash, "du -a /dir");
        assert!(r.stdout.contains("/dir/a.txt"));
        assert!(r.stdout.contains("/dir\n") || r.stdout.ends_with("/dir\n"));
    }

    #[test]
    fn du_missing_path_errors() {
        let mut bash = fresh();
        let r = run(&mut bash, "du /missing");
        assert!(r.stderr.contains("No such file or directory"));
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn tree_lists_directory_structure() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/proj/a.txt", b"a").unwrap();
        bash.fs_mut().write_file("/proj/sub/b.txt", b"b").unwrap();
        let r = run(&mut bash, "tree /proj");
        assert!(r.stdout.contains("|-- a.txt") || r.stdout.contains("`-- a.txt"));
        assert!(r.stdout.contains("sub"));
        assert!(r.stdout.contains("director"));
    }

    #[test]
    fn tree_dirs_only() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/proj/a.txt", b"a").unwrap();
        bash.fs_mut().mkdir("/proj/sub", true).unwrap();
        let r = run(&mut bash, "tree -d /proj");
        assert!(!r.stdout.contains("a.txt"));
        assert!(r.stdout.contains("sub"));
    }

    #[test]
    fn tree_missing_path_errors() {
        let mut bash = fresh();
        let r = run(&mut bash, "tree /missing");
        assert!(r.stderr.contains("No such file or directory"));
        assert_eq!(r.exit_code, 1);
    }
}
