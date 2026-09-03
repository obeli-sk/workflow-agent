//! PORT: vendor/just-bash/src/commands/base64/base64.ts,
//! vendor/just-bash/src/commands/md5sum/{checksum,md5sum}.ts
//!
//! `base64 [-d] [-w COLS] [FILE]`, `md5sum [-c] [FILE]...`, and
//! `sha256sum [FILE]...`.

use super::{fail, normalize_path, ok, read_concat};
use crate::fs::{FileReadError, is_cas_namespaced_digest};
use crate::interpreter::{CommandOutput, Interpreter};

// ---------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied();
        let b2 = chunk.get(2).copied();
        let n = (b0 as u32) << 16 | (b1.unwrap_or(0) as u32) << 8 | (b2.unwrap_or(0) as u32);
        out.push(B64_ALPHABET[(n >> 18 & 0x3f) as usize] as char);
        out.push(B64_ALPHABET[(n >> 12 & 0x3f) as usize] as char);
        out.push(if b1.is_some() {
            B64_ALPHABET[(n >> 6 & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if b2.is_some() {
            B64_ALPHABET[(n & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

fn base64_decode(input: &str) -> Result<Vec<u8>, ()> {
    let cleaned: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let mut values = Vec::with_capacity(cleaned.len());
    for &b in &cleaned {
        if b == b'=' {
            break;
        }
        let v = B64_ALPHABET.iter().position(|&c| c == b).ok_or(())?;
        values.push(v as u32);
    }
    let mut out = Vec::new();
    for chunk in values.chunks(4) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |acc, (i, &v)| acc | (v << (18 - 6 * i)));
        out.push((n >> 16 & 0xff) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8 & 0xff) as u8);
        }
        if chunk.len() > 3 {
            out.push((n & 0xff) as u8);
        }
    }
    Ok(out)
}

pub fn base64(interp: &Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let mut decode = false;
    let mut wrap = 76i64;
    let mut files: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "-d" | "--decode" => decode = true,
            "-w" | "--wrap" if i + 1 < args.len() => {
                i += 1;
                match args[i].parse::<i64>() {
                    Ok(v) => wrap = v,
                    Err(_) => return fail("base64: invalid wrap size\n".to_string(), 1),
                }
            }
            other if other.starts_with("--wrap=") => {
                match other["--wrap=".len()..].parse::<i64>() {
                    Ok(v) => wrap = v,
                    Err(_) => return fail("base64: invalid wrap size\n".to_string(), 1),
                }
            }
            other => files.push(other.to_string()),
        }
        i += 1;
    }
    if wrap < 0 {
        return fail("base64: invalid wrap size\n".to_string(), 1);
    }

    // base64 is byte-clean; concatenate operands as raw bytes (read_concat
    // decodes UTF-8-lossy, which round-trips ASCII/valid-UTF-8 input fine
    // for this port's text-only Vfs).
    let content = match read_concat(interp, &files, "base64", &stdin) {
        Ok(c) => c,
        Err(e) => return e,
    };

    if decode {
        let cleaned: String = content.chars().filter(|c| !c.is_whitespace()).collect();
        return match base64_decode(&cleaned) {
            Ok(bytes) => ok(String::from_utf8_lossy(&bytes).into_owned()),
            Err(()) => fail("base64: invalid input\n".to_string(), 1),
        };
    }

    let mut encoded = base64_encode(content.as_bytes());
    if wrap > 0 {
        let wrap = wrap as usize;
        let mut lines = Vec::new();
        let chars: Vec<char> = encoded.chars().collect();
        for chunk in chars.chunks(wrap) {
            lines.push(chunk.iter().collect::<String>());
        }
        encoded = if lines.is_empty() {
            String::new()
        } else {
            format!("{}\n", lines.join("\n"))
        };
    }
    ok(encoded)
}

// ---------------------------------------------------------------------
// md5sum
// ---------------------------------------------------------------------

const MD5_K: [u32; 64] = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];
const MD5_S: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

fn md5_hex(data: &[u8]) -> String {
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut padded = data.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_le_bytes());

    let (mut a0, mut b0, mut c0, mut d0) =
        (0x67452301u32, 0xefcdab89u32, 0x98badcfeu32, 0x10325476u32);

    for block in padded.chunks(64) {
        let mut m = [0u32; 16];
        for (j, word) in m.iter_mut().enumerate() {
            *word = u32::from_le_bytes(block[j * 4..j * 4 + 4].try_into().unwrap());
        }
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for j in 0..64 {
            let (f, g) = if j < 16 {
                ((b & c) | (!b & d), j)
            } else if j < 32 {
                ((d & b) | (!d & c), (5 * j + 1) % 16)
            } else if j < 48 {
                (b ^ c ^ d, (3 * j + 5) % 16)
            } else {
                (c ^ (b | !d), (7 * j) % 16)
            };
            let f = f.wrapping_add(a).wrapping_add(MD5_K[j]).wrapping_add(m[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(f.rotate_left(MD5_S[j]));
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }

    let mut out = String::with_capacity(32);
    for word in [a0, b0, c0, d0] {
        for byte in word.to_le_bytes() {
            out.push_str(&format!("{byte:02x}"));
        }
    }
    out
}

pub fn md5sum(interp: &Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let mut check = false;
    let mut files: Vec<String> = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-c" | "--check" => check = true,
            "-b" | "-t" | "--binary" | "--text" => {}
            other if other.starts_with('-') && other != "-" => {
                return super::unknown_option("md5sum", other);
            }
            other => files.push(other.to_string()),
        }
    }
    if files.is_empty() {
        files.push("-".to_string());
    }

    let read_binary = |interp: &Interpreter, file: &str| -> Option<Vec<u8>> {
        if file == "-" {
            return Some(stdin.as_bytes().to_vec());
        }
        let path = normalize_path(&interp.cwd, file);
        interp.fs.read_file(&path).map(|b| b.to_vec())
    };

    if check {
        let mut failed = 0;
        let mut output = String::new();
        for file in &files {
            let content = if file == "-" {
                Some(stdin.clone())
            } else {
                interp
                    .fs
                    .read_file(&normalize_path(&interp.cwd, file))
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
            };
            let Some(content) = content else {
                return fail(format!("md5sum: {file}: No such file or directory\n"), 1);
            };
            for line in content.lines() {
                let Some((hash, target)) = parse_checksum_line(line) else {
                    continue;
                };
                match read_binary(interp, target) {
                    None => {
                        output.push_str(&format!("{target}: FAILED open or read\n"));
                        failed += 1;
                    }
                    Some(bytes) => {
                        let ok_match = md5_hex(&bytes).eq_ignore_ascii_case(hash);
                        output.push_str(&format!(
                            "{target}: {}\n",
                            if ok_match { "OK" } else { "FAILED" }
                        ));
                        if !ok_match {
                            failed += 1;
                        }
                    }
                }
            }
        }
        if failed > 0 {
            output.push_str(&format!(
                "md5sum: WARNING: {failed} computed checksum{} did NOT match\n",
                if failed > 1 { "s" } else { "" }
            ));
        }
        return CommandOutput {
            stdout: output,
            stderr: String::new(),
            exit_code: if failed > 0 { 1 } else { 0 },
        };
    }

    let mut output = String::new();
    let mut exit_code = 0;
    for file in &files {
        match read_binary(interp, file) {
            None => {
                output.push_str(&format!("md5sum: {file}: No such file or directory\n"));
                exit_code = 1;
            }
            Some(bytes) => output.push_str(&format!("{}  {file}\n", md5_hex(&bytes))),
        }
    }
    CommandOutput {
        stdout: output,
        stderr: String::new(),
        exit_code,
    }
}

/// Parse a `<hash>  <filename>` checksum-file line (one/two space or a
/// leading `*` for binary mode).
fn parse_checksum_line(line: &str) -> Option<(&str, &str)> {
    let line = line.trim_end();
    let sp = line.find(char::is_whitespace)?;
    let hash = &line[..sp];
    if hash.is_empty() || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let rest = line[sp..].trim_start_matches([' ', '\t', '*']);
    if rest.is_empty() {
        return None;
    }
    Some((hash, rest))
}

// ---------------------------------------------------------------------
// sha256sum
// ---------------------------------------------------------------------

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub(crate) fn sha256_hex(data: &[u8]) -> String {
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut padded = data.to_vec();
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    let mut state = [
        0x6a09e667u32,
        0xbb67ae85,
        0x3c6ef372,
        0xa54ff53a,
        0x510e527f,
        0x9b05688c,
        0x1f83d9ab,
        0x5be0cd19,
    ];
    for block in padded.chunks_exact(64) {
        let mut words = [0u32; 64];
        for (i, word) in words[..16].iter_mut().enumerate() {
            *word = u32::from_be_bytes(block[i * 4..i * 4 + 4].try_into().unwrap());
        }
        for i in 16..64 {
            let s0 =
                words[i - 15].rotate_right(7) ^ words[i - 15].rotate_right(18) ^ words[i - 15] >> 3;
            let s1 =
                words[i - 2].rotate_right(17) ^ words[i - 2].rotate_right(19) ^ words[i - 2] >> 10;
            words[i] = words[i - 16]
                .wrapping_add(s0)
                .wrapping_add(words[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0..64 {
            let sum1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ (!e & g);
            let temp1 = h
                .wrapping_add(sum1)
                .wrapping_add(choice)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(words[i]);
            let sum0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = sum0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        for (slot, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(value);
        }
    }

    state.iter().map(|word| format!("{word:08x}")).collect()
}

pub fn sha256sum(interp: &Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let mut files = Vec::new();
    for arg in args {
        match arg.as_str() {
            "-b" | "-t" | "--binary" | "--text" => {}
            other if other.starts_with('-') && other != "-" => {
                return super::unknown_option("sha256sum", other);
            }
            other => files.push(other.to_string()),
        }
    }
    if files.is_empty() {
        files.push("-".to_string());
    }

    let mut stdout = String::new();
    let mut stderr = String::new();
    let mut exit_code = 0;
    for file in files {
        let digest = if file == "-" {
            Some(sha256_hex(stdin.as_bytes()))
        } else {
            let path = normalize_path(&interp.cwd, &file);
            content_sha256_hex(interp, &path, &file, &mut stderr)
        };
        match digest {
            Some(digest) => stdout.push_str(&format!("{digest}  {file}\n")),
            None => exit_code = 1,
        }
    }
    CommandOutput {
        stdout,
        stderr,
        exit_code,
    }
}

/// The bare-hex sha256 of the file currently at `path`, computed at most once
/// per unchanged state (see `Vfs::cache_content_digest`): a `pending` file
/// whose own digest is already CAS-namespaced (`sha256:...`, e.g. a
/// deployment mount) is trusted with no I/O at all; otherwise (a foreign
/// digest, such as a git/web mount's own hash, or eager content) the content
/// digest cache is consulted before falling back to reading the bytes -
/// fetching a lazy file at most once via the existing lazy read cache - and
/// hashing them, after which the result is cached for next time.
fn content_sha256_hex(
    interp: &Interpreter,
    path: &str,
    file: &str,
    stderr: &mut String,
) -> Option<String> {
    if let Some(reference) = interp.fs.lazy_file_ref(path)
        && is_cas_namespaced_digest(&reference.digest)
    {
        return reference.digest.strip_prefix("sha256:").map(str::to_owned);
    }
    if let Some(cached) = interp.fs.cached_content_digest(path) {
        return cached.strip_prefix("sha256:").map(str::to_owned);
    }
    match interp.fs.read_file_checked(path) {
        Ok(bytes) => {
            let hex = sha256_hex(&bytes);
            interp
                .fs
                .cache_content_digest(path, &format!("sha256:{hex}"));
            Some(hex)
        }
        Err(FileReadError::NotFound(_)) => {
            stderr.push_str(&format!("sha256sum: {file}: No such file or directory\n"));
            None
        }
        Err(FileReadError::TooLarge { .. }) => {
            stderr.push_str(&format!("sha256sum: {file}: File too large to hash\n"));
            None
        }
        Err(FileReadError::Unavailable(_)) => {
            stderr.push_str(&format!("sha256sum: {file}: File body is unavailable\n"));
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use crate::bash::Bash;
    use crate::fs::BlobLoader;
    use crate::types::{BashOptions, ExecOptions, ExecResult};

    fn fresh() -> Bash {
        Bash::new(BashOptions::default())
    }

    fn run(bash: &mut Bash, script: &str) -> ExecResult {
        bash.exec(script, ExecOptions::default())
    }

    #[test]
    fn base64_roundtrip() {
        let mut bash = fresh();
        let r = run(&mut bash, "echo -n hello | base64");
        assert_eq!(r.stdout, "aGVsbG8=\n");
        let r = run(&mut bash, "echo -n aGVsbG8= | base64 -d");
        assert_eq!(r.stdout, "hello");
    }

    #[test]
    fn base64_wrap_zero_disables_wrapping() {
        let mut bash = fresh();
        let r = run(
            &mut bash,
            "echo -n 'a very long string that would normally wrap' | base64 -w 0",
        );
        assert!(!r.stdout.contains('\n') || r.stdout.matches('\n').count() == 0);
    }

    #[test]
    fn md5sum_known_vectors() {
        let mut bash = fresh();
        // Well-known MD5("") and MD5("abc").
        let r = run(&mut bash, "printf '' | md5sum");
        assert!(r.stdout.starts_with("d41d8cd98f00b204e9800998ecf8427e"));
        let r = run(&mut bash, "printf abc | md5sum");
        assert!(r.stdout.starts_with("900150983cd24fb0d6963f7d28e17f72"));
    }

    #[test]
    fn md5sum_file_operand() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/f.txt", b"abc").unwrap();
        let r = run(&mut bash, "md5sum /f.txt");
        assert_eq!(r.stdout, "900150983cd24fb0d6963f7d28e17f72  /f.txt\n");
    }

    #[test]
    fn md5sum_missing_file_errors() {
        let mut bash = fresh();
        let r = run(&mut bash, "md5sum /missing.txt");
        assert!(r.stdout.contains("No such file or directory"));
        assert_eq!(r.exit_code, 1);
    }

    #[test]
    fn md5sum_check_mode() {
        let mut bash = fresh();
        bash.fs_mut().write_file("/f.txt", b"abc").unwrap();
        bash.fs_mut()
            .write_file("/sums.txt", b"900150983cd24fb0d6963f7d28e17f72  /f.txt\n")
            .unwrap();
        let r = run(&mut bash, "md5sum -c /sums.txt");
        assert_eq!(r.stdout, "/f.txt: OK\n");
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    fn sha256sum_known_vectors_and_local_file() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, "printf abc | sha256sum").stdout,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n"
        );
        bash.fs_mut().write_file("/f.txt", b"abc").unwrap();
        assert_eq!(
            run(&mut bash, "sha256sum /f.txt").stdout,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  /f.txt\n"
        );
    }

    #[test]
    fn sha256sum_uses_lazy_digest_without_fetching() {
        struct RejectingLoader(Rc<RefCell<bool>>);
        impl BlobLoader for RejectingLoader {
            fn load(&self, _digest: &str) -> Result<Vec<u8>, String> {
                *self.0.borrow_mut() = true;
                Err("must not fetch".to_string())
            }
        }

        let fetched = Rc::new(RefCell::new(false));
        let mut bash = fresh();
        bash.fs_mut()
            .set_blob_loader(Rc::new(RejectingLoader(fetched.clone())));
        bash.fs_mut().register_lazy(
            "/huge.wasm",
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            u64::MAX,
        );

        assert_eq!(
            run(&mut bash, "sha256sum /huge.wasm").stdout,
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  /huge.wasm\n"
        );
        assert!(!*fetched.borrow());

        bash.fs_mut().write_file("/huge.wasm", b"changed").unwrap();
        assert_eq!(
            run(&mut bash, "sha256sum /huge.wasm").stdout,
            "d67e2e944994496c8d8ec76eed0cf9f09679448d584b532bebf941852a37f5ed  /huge.wasm\n"
        );
        assert!(!*fetched.borrow());
    }

    #[test]
    fn sha256sum_of_a_foreign_digest_pending_file_hashes_once_and_caches() {
        // A git/web mount's own digest (e.g. GitHub's 40-hex blob SHA-1) is
        // not our CAS's sha256, so sha256sum must not trust it as-is like the
        // lazy-digest case above - it must fetch and hash the real bytes.
        // But that fetch+hash should still happen at most once: the second
        // call must neither refetch nor rehash.
        struct CountingLoader(Rc<RefCell<u32>>);
        impl BlobLoader for CountingLoader {
            fn load(&self, _digest: &str) -> Result<Vec<u8>, String> {
                *self.0.borrow_mut() += 1;
                Ok(b"abc".to_vec())
            }
        }
        let fetches = Rc::new(RefCell::new(0));
        let mut bash = fresh();
        bash.fs_mut()
            .set_blob_loader(Rc::new(CountingLoader(fetches.clone())));
        bash.fs_mut()
            .register_lazy("/AGENTS.md", "a9993e364706816aba3e25717850c26c9cd0d89d", 3);

        let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(
            run(&mut bash, "sha256sum /AGENTS.md").stdout,
            format!("{expected}  /AGENTS.md\n")
        );
        assert_eq!(*fetches.borrow(), 1);
        assert_eq!(
            bash.fs().cached_content_digest("/AGENTS.md"),
            Some(format!("sha256:{expected}"))
        );

        assert_eq!(
            run(&mut bash, "sha256sum /AGENTS.md").stdout,
            format!("{expected}  /AGENTS.md\n")
        );
        assert_eq!(*fetches.borrow(), 1, "content must not be fetched twice");
    }
}
