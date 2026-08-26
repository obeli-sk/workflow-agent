//! PORT: vendor/just-bash/src/commands/{date,expr,time,timeout,sleep}/*.ts
//! (+ `duration.ts`, `printf/strftime.ts`)
//!
//! Five small commands grouped here because they share either the clock
//! (`date`) or the "run a nested command" shape (`time`/`timeout`, which
//! dispatch straight to `commands::dispatch` like `xargs` does rather than
//! re-entering the parser).
//!
//! This interpreter is a synchronous, single-threaded, deterministic durable
//! workflow shell. `date` and `sleep` reach the host through the
//! `BashOptions::now_ms` / `sleep_ms` seams: under the workflow those are the
//! durable Obelisk clock (a `sleep(now)` activity) and durable `sleep(in(...))`
//! (so a `sleep` suspends the workflow rather than busy-waiting), and the bare
//! interpreter defaults them to a fixed epoch-0 clock and a no-op sleep.
//! `timeout` still does not enforce a wall-clock deadline and `time` always
//! reports zero elapsed time. See each function's doc comment for the caveat.

use super::grep::translate_bre;
use super::{fail, ok};
use crate::interpreter::{CommandOutput, Interpreter};

// ---------------------------------------------------------------------
// Calendar math (Howard Hinnant's civil_from_days / days_from_civil), used
// by `date`. No timezone database is available in this port, so all
// calculations are UTC-only.
// ---------------------------------------------------------------------

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// Days since the epoch (1970-01-01) -> (year, month 1-12, day 1-31).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// (year, month, day) -> days since the epoch. Inverse of `civil_from_days`.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146097 + doe as i64 - 719468
}

/// 0 = Sunday .. 6 = Saturday. 1970-01-01 (day 0) was a Thursday.
fn weekday_from_days(days: i64) -> u32 {
    (((days % 7) + 7 + 4) % 7) as u32
}

fn hour12(h: u32) -> u32 {
    if h.is_multiple_of(12) { 12 } else { h % 12 }
}

fn day_of_year(y: i64, m: u32, d: u32) -> u32 {
    const CUM: [u32; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    let mut doy = CUM[(m - 1) as usize] + d;
    if m > 2 && is_leap_year(y) {
        doy += 1;
    }
    doy
}

struct DateParts {
    year: i64,
    month: u32,
    day: u32,
    hour: u32,
    minute: u32,
    second: u32,
    weekday: u32,
    yday: u32,
}

fn epoch_to_parts(secs: i64) -> DateParts {
    let days = secs.div_euclid(86400);
    let sod = secs.rem_euclid(86400);
    let (year, month, day) = civil_from_days(days);
    DateParts {
        year,
        month,
        day,
        hour: (sod / 3600) as u32,
        minute: ((sod % 3600) / 60) as u32,
        second: (sod % 60) as u32,
        weekday: weekday_from_days(days),
        yday: day_of_year(year, month, day),
    }
}

fn parts_to_epoch(y: i64, m: u32, d: u32, hh: u32, mm: u32, ss: u32) -> i64 {
    days_from_civil(y, m, d) * 86400 + hh as i64 * 3600 + mm as i64 * 60 + ss as i64
}

const DOW_ABBR: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_FULL: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];
const MON_ABBR: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const MON_FULL: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// Sunday- or Monday-first week number (`%U`/`%W`): days before the first
/// occurrence of the week-start day are week 00.
fn week_number(p: &DateParts, start_day: u32) -> u32 {
    let jan1_days = days_from_civil(p.year, 1, 1);
    let jan1_dow = weekday_from_days(jan1_days);
    let first_week_start = 1 + (7 + start_day - jan1_dow) % 7;
    if p.yday < first_week_start {
        0
    } else {
        (p.yday - first_week_start) / 7 + 1
    }
}

/// Format a subset of strftime directives against a UTC instant. The clock
/// seam only carries milliseconds, so the sub-second directives (`%N`,
/// `%<n>N`) zero-pad below milliseconds. Not ported: `%V`/`%G`/`%g`
/// (ISO week-date, needs leap-week rules), locale alternates (`%Ec` etc).
fn format_strftime(fmt: &str, secs: i64, millis: u32) -> String {
    let p = epoch_to_parts(secs);
    let pad2 = |n: u32| format!("{n:02}");
    let mut out = String::new();
    let mut chars = fmt.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('N') => push_fraction(&mut out, millis, 9),
            Some(d) if d.is_ascii_digit() => {
                let mut width = String::from(d);
                let mut follower = chars.next();
                while matches!(follower, Some(c) if c.is_ascii_digit()) {
                    width.push(follower.take().unwrap());
                    follower = chars.next();
                }
                if follower == Some('N') {
                    push_fraction(&mut out, millis, width.parse::<usize>().unwrap_or(9));
                } else {
                    out.push('%');
                    out.push_str(&width);
                    if let Some(c) = follower {
                        out.push(c);
                    }
                }
            }
            Some('Y') => out.push_str(&p.year.to_string()),
            Some('y') => out.push_str(&pad2((p.year.rem_euclid(100)) as u32)),
            Some('C') => out.push_str(&pad2((p.year.div_euclid(100)) as u32)),
            Some('m') => out.push_str(&pad2(p.month)),
            Some('d') => out.push_str(&pad2(p.day)),
            Some('e') => out.push_str(&format!("{:2}", p.day)),
            Some('H') => out.push_str(&pad2(p.hour)),
            Some('k') => out.push_str(&format!("{:2}", p.hour)),
            Some('I') => out.push_str(&pad2(hour12(p.hour))),
            Some('l') => out.push_str(&format!("{:2}", hour12(p.hour))),
            Some('M') => out.push_str(&pad2(p.minute)),
            Some('S') => out.push_str(&pad2(p.second)),
            Some('s') => out.push_str(&secs.to_string()),
            Some('p') => out.push_str(if p.hour < 12 { "AM" } else { "PM" }),
            Some('P') => out.push_str(if p.hour < 12 { "am" } else { "pm" }),
            Some('a') => out.push_str(DOW_ABBR[p.weekday as usize]),
            Some('A') => out.push_str(DOW_FULL[p.weekday as usize]),
            Some('b') | Some('h') => out.push_str(MON_ABBR[(p.month - 1) as usize]),
            Some('B') => out.push_str(MON_FULL[(p.month - 1) as usize]),
            Some('j') => out.push_str(&format!("{:03}", p.yday)),
            Some('u') => out.push_str(&(if p.weekday == 0 { 7 } else { p.weekday }).to_string()),
            Some('w') => out.push_str(&p.weekday.to_string()),
            Some('U') => out.push_str(&pad2(week_number(&p, 0))),
            Some('W') => out.push_str(&pad2(week_number(&p, 1))),
            Some('F') => out.push_str(&format!("{}-{}-{}", p.year, pad2(p.month), pad2(p.day))),
            Some('D') | Some('x') => out.push_str(&format!(
                "{}/{}/{}",
                pad2(p.month),
                pad2(p.day),
                pad2((p.year.rem_euclid(100)) as u32)
            )),
            Some('T') | Some('X') => out.push_str(&format!(
                "{}:{}:{}",
                pad2(p.hour),
                pad2(p.minute),
                pad2(p.second)
            )),
            Some('R') => out.push_str(&format!("{}:{}", pad2(p.hour), pad2(p.minute))),
            Some('r') => out.push_str(&format!(
                "{}:{}:{} {}",
                pad2(hour12(p.hour)),
                pad2(p.minute),
                pad2(p.second),
                if p.hour < 12 { "AM" } else { "PM" }
            )),
            Some('c') => out.push_str(&format!(
                "{} {} {:2} {}:{}:{} {}",
                DOW_ABBR[p.weekday as usize],
                MON_ABBR[(p.month - 1) as usize],
                p.day,
                pad2(p.hour),
                pad2(p.minute),
                pad2(p.second),
                p.year
            )),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('z') => out.push_str("+0000"),
            Some('Z') => out.push_str("UTC"),
            Some('%') => out.push('%'),
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out
}

/// The `%[n]N` field: milliseconds scaled to nanoseconds (lower digits are
/// zeros), truncated to `width` digits or zero-extended past 9.
fn push_fraction(out: &mut String, millis: u32, width: usize) {
    let mut digits = format!("{:09}", u64::from(millis) * 1_000_000);
    if width > 9 {
        digits.push_str(&"0".repeat(width - 9));
    } else {
        digits.truncate(width);
    }
    out.push_str(&digits);
}

/// Parse a `date -d`/`--date=` argument. Supports `@N` (Unix epoch seconds),
/// `now`/`today`, `yesterday`/`tomorrow` (relative to `now_secs`), and a bare
/// ISO-ish `YYYY-MM-DD[ HH:MM[:SS]]` (interpreted as UTC, since this port has
/// no timezone database). Not ported: free-form natural-language dates
/// ("next friday"), explicit UTC offsets/`Z` suffixes, and RFC 2822 dates —
/// genuinely out of scope for a hand-rolled parser.
fn parse_date_spec(spec: &str, now_secs: i64) -> Option<i64> {
    if let Some(rest) = spec.strip_prefix('@') {
        return rest.parse::<i64>().ok();
    }
    match spec.trim().to_lowercase().as_str() {
        "now" | "today" => return Some(now_secs),
        "yesterday" => return Some(now_secs - 86400),
        "tomorrow" => return Some(now_secs + 86400),
        _ => {}
    }
    let s = spec.trim();
    let (date_part, time_part) = match s.split_once(['T', ' ']) {
        Some((d, t)) => (d, Some(t)),
        None => (s, None),
    };
    let mut date_fields = date_part.split('-');
    let year: i64 = date_fields.next()?.parse().ok()?;
    let month: u32 = date_fields.next()?.parse().ok()?;
    let day: u32 = date_fields.next()?.parse().ok()?;
    if date_fields.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (hour, minute, second) = match time_part {
        Some(t) => {
            let mut parts = t.split(':');
            let hh: u32 = parts.next()?.parse().ok()?;
            let mm: u32 = parts.next().unwrap_or("0").parse().ok()?;
            let ss: u32 = parts.next().unwrap_or("0").parse().ok()?;
            if parts.next().is_some() {
                return None;
            }
            (hh, mm, ss)
        }
        None => (0, 0, 0),
    };
    Some(parts_to_epoch(year, month, day, hour, minute, second))
}

/// `date [-u] [-d STRING] [-I] [-R] [+FORMAT]`. Always displays UTC (no
/// timezone database in this port, so `$TZ` is not consulted; `-u` is
/// accordingly a no-op). See `parse_date_spec`/`format_strftime` for the
/// supported subsets.
pub fn date(interp: &Interpreter, args: &[String]) -> CommandOutput {
    let mut date_str: Option<String> = None;
    let mut fmt: Option<String> = None;
    let mut iso = false;
    let mut rfc = false;
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        match a.as_str() {
            "-u" | "--utc" => {}
            "-I" | "--iso-8601" => iso = true,
            "-R" | "--rfc-email" => rfc = true,
            "-d" | "--date" => {
                i += 1;
                match args.get(i) {
                    Some(v) => date_str = Some(v.clone()),
                    None => {
                        return fail("date: option requires an argument -- 'd'\n".to_string(), 1);
                    }
                }
            }
            _ if a.starts_with("--date=") => date_str = Some(a["--date=".len()..].to_string()),
            _ if a.starts_with('+') => fmt = Some(a[1..].to_string()),
            _ => return fail(format!("date: invalid option '{a}'\n"), 1),
        }
        i += 1;
    }

    let now_ms = (interp.now_ms)();
    // A `-d` spec pins whole seconds only, so its sub-second field is zero.
    let (secs, millis) = match date_str {
        Some(s) => match parse_date_spec(&s, now_ms.div_euclid(1000)) {
            Some(secs) => (secs, 0),
            None => return fail(format!("date: invalid date '{s}'\n"), 1),
        },
        None => (now_ms.div_euclid(1000), now_ms.rem_euclid(1000) as u32),
    };

    let out = if let Some(fmt) = fmt {
        format_strftime(&fmt, secs, millis)
    } else if iso {
        format_strftime("%Y-%m-%dT%H:%M:%S+00:00", secs, millis)
    } else if rfc {
        format_strftime("%a, %d %b %Y %H:%M:%S +0000", secs, millis)
    } else {
        format_strftime("%a %b %e %H:%M:%S UTC %Y", secs, millis)
    };
    ok(format!("{out}\n"))
}

// ---------------------------------------------------------------------
// expr
// ---------------------------------------------------------------------

/// `expr` evaluates its argv as a small POSIX expression: `|`/`&` logical
/// or/and, `= != < > <= >=` comparisons (numeric if both sides parse as
/// integers, string otherwise), `+ -`, `* / %`, a `:` regex-match operator
/// (POSIX BRE anchored at the start, translated via the same `translate_bre`
/// grep/sed share), `match`/`substr`/`index`/`length`, and parens. i64
/// arithmetic (not POSIX's arbitrary precision, a scope simplification).
pub fn expr(args: &[String]) -> CommandOutput {
    if args.is_empty() {
        return fail("expr: missing operand\n".to_string(), 2);
    }
    let mut p = ExprParser { args, i: 0 };
    match p.parse_or() {
        Ok(result) if p.i == p.args.len() => {
            let exit_code = if result == "0" || result.is_empty() {
                1
            } else {
                0
            };
            CommandOutput {
                stdout: format!("{result}\n"),
                stderr: String::new(),
                exit_code,
            }
        }
        Ok(_) => fail("expr: syntax error\n".to_string(), 2),
        Err(message) => fail(format!("expr: {message}\n"), 2),
    }
}

struct ExprParser<'a> {
    args: &'a [String],
    i: usize,
}

impl<'a> ExprParser<'a> {
    fn peek(&self) -> Option<&str> {
        self.args.get(self.i).map(String::as_str)
    }

    fn parse_or(&mut self) -> Result<String, String> {
        let mut left = self.parse_and()?;
        while self.peek() == Some("|") {
            self.i += 1;
            let right = self.parse_and()?;
            if left == "0" || left.is_empty() {
                left = right;
            }
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<String, String> {
        let mut left = self.parse_comparison()?;
        while self.peek() == Some("&") {
            self.i += 1;
            let right = self.parse_comparison()?;
            if left == "0" || left.is_empty() || right == "0" || right.is_empty() {
                left = "0".to_string();
            }
        }
        Ok(left)
    }

    fn parse_comparison(&mut self) -> Result<String, String> {
        let mut left = self.parse_addsub()?;
        while let Some(op @ ("=" | "!=" | "<" | ">" | "<=" | ">=")) = self.peek() {
            let op = op.to_string();
            self.i += 1;
            let right = self.parse_addsub()?;
            let result = match (left.parse::<i64>(), right.parse::<i64>()) {
                (Ok(l), Ok(r)) => match op.as_str() {
                    "=" => l == r,
                    "!=" => l != r,
                    "<" => l < r,
                    ">" => l > r,
                    "<=" => l <= r,
                    ">=" => l >= r,
                    _ => unreachable!(),
                },
                _ => match op.as_str() {
                    "=" => left == right,
                    "!=" => left != right,
                    "<" => left < right,
                    ">" => left > right,
                    "<=" => left <= right,
                    ">=" => left >= right,
                    _ => unreachable!(),
                },
            };
            left = if result { "1" } else { "0" }.to_string();
        }
        Ok(left)
    }

    fn parse_addsub(&mut self) -> Result<String, String> {
        let mut left = self.parse_muldiv()?;
        while let Some(op @ ("+" | "-")) = self.peek() {
            let op = op.to_string();
            self.i += 1;
            let right = self.parse_muldiv()?;
            let l: i64 = left
                .parse()
                .map_err(|_| "non-integer argument".to_string())?;
            let r: i64 = right
                .parse()
                .map_err(|_| "non-integer argument".to_string())?;
            left = (if op == "+" { l + r } else { l - r }).to_string();
        }
        Ok(left)
    }

    fn parse_muldiv(&mut self) -> Result<String, String> {
        let mut left = self.parse_match()?;
        while let Some(op @ ("*" | "/" | "%")) = self.peek() {
            let op = op.to_string();
            self.i += 1;
            let right = self.parse_match()?;
            let l: i64 = left
                .parse()
                .map_err(|_| "non-integer argument".to_string())?;
            let r: i64 = right
                .parse()
                .map_err(|_| "non-integer argument".to_string())?;
            if (op == "/" || op == "%") && r == 0 {
                return Err("division by zero".to_string());
            }
            left = match op.as_str() {
                "*" => l.wrapping_mul(r),
                "/" => l / r,
                _ => l % r,
            }
            .to_string();
        }
        Ok(left)
    }

    fn parse_match(&mut self) -> Result<String, String> {
        let mut left = self.parse_primary()?;
        while self.peek() == Some(":") {
            self.i += 1;
            let pattern = self.parse_primary()?;
            left = match_bre(&left, &pattern)?;
        }
        Ok(left)
    }

    fn parse_primary(&mut self) -> Result<String, String> {
        let token = self
            .peek()
            .ok_or_else(|| "syntax error".to_string())?
            .to_string();
        match token.as_str() {
            "match" => {
                self.i += 1;
                let s = self.parse_primary()?;
                let pattern = self.parse_primary()?;
                match_bre(&s, &pattern)
            }
            "substr" => {
                self.i += 1;
                let s = self.parse_primary()?;
                let pos: i64 = self
                    .parse_primary()?
                    .parse()
                    .map_err(|_| "non-integer argument".to_string())?;
                let len: i64 = self
                    .parse_primary()?
                    .parse()
                    .map_err(|_| "non-integer argument".to_string())?;
                let chars: Vec<char> = s.chars().collect();
                let start = (pos - 1).max(0) as usize;
                let end = ((pos - 1).max(0) + len.max(0)) as usize;
                if pos < 1 || len < 0 || start >= chars.len() {
                    return Ok(String::new());
                }
                Ok(chars[start..end.min(chars.len())].iter().collect())
            }
            "index" => {
                self.i += 1;
                let s = self.parse_primary()?;
                let chars_arg = self.parse_primary()?;
                let set: std::collections::HashSet<char> = chars_arg.chars().collect();
                match s.chars().position(|c| set.contains(&c)) {
                    Some(idx) => Ok((idx + 1).to_string()),
                    None => Ok("0".to_string()),
                }
            }
            "length" => {
                self.i += 1;
                let s = self.parse_primary()?;
                Ok(s.chars().count().to_string())
            }
            "(" => {
                self.i += 1;
                let result = self.parse_or()?;
                if self.peek() != Some(")") {
                    return Err("syntax error".to_string());
                }
                self.i += 1;
                Ok(result)
            }
            _ => {
                self.i += 1;
                Ok(token)
            }
        }
    }
}

/// `str : pattern` / `match str pattern`: anchor the (BRE) pattern at the
/// start of `str`; a capturing group returns its match, otherwise the
/// length of the whole match; no match returns `"0"`.
fn match_bre(text: &str, pattern: &str) -> Result<String, String> {
    let translated = translate_bre(pattern);
    let anchored = format!("^(?:{translated})");
    let re = regex::Regex::new(&anchored).map_err(|_| format!("invalid regex '{pattern}'"))?;
    // A literal capturing group in the pattern (not our wrapping `(?:...)`)
    // is only present if the user wrote one; regex's capture group 1 is it.
    match re.captures(text) {
        Some(caps) => match caps.get(1) {
            Some(g) => Ok(g.as_str().to_string()),
            None => Ok(caps.get(0).unwrap().as_str().chars().count().to_string()),
        },
        None => Ok("0".to_string()),
    }
}

// ---------------------------------------------------------------------
// sleep / timeout / time
// ---------------------------------------------------------------------

/// Parse a duration like `5`, `1.5s`, `2m`, `3h`, `1d` into milliseconds.
fn parse_duration_ms(s: &str) -> Option<f64> {
    let (number, suffix) = match s.chars().last() {
        Some(c @ ('s' | 'm' | 'h' | 'd')) => (&s[..s.len() - 1], c),
        _ => (s, 's'),
    };
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    let value: f64 = number.parse().ok()?;
    Some(match suffix {
        's' => value * 1000.0,
        'm' => value * 60_000.0,
        'h' => value * 3_600_000.0,
        'd' => value * 86_400_000.0,
        _ => unreachable!(),
    })
}

/// `sleep NUMBER[SUFFIX]...`. Validates its arguments (same error messages as
/// upstream), then sleeps for their sum via the host `sleep_ms` seam
/// (`BashOptions::sleep_ms`). Under the workflow that seam is the durable
/// Obelisk `sleep`, so the delay suspends the workflow rather than busy-waiting;
/// the bare interpreter's default seam is a no-op, so `sleep` returns at once.
///
/// With a script watch installed, the delay joins the watch instead, so a
/// timeout or operator interrupt ends the sleep early (the script's remaining
/// statements are then skipped).
pub fn sleep_cmd(interp: &mut Interpreter, args: &[String]) -> CommandOutput {
    if args.is_empty() {
        return fail("sleep: missing operand\n".to_string(), 1);
    }
    let mut total_ms = 0.0;
    for arg in args {
        match parse_duration_ms(arg) {
            Some(ms) => total_ms += ms,
            None => return fail(format!("sleep: invalid time interval '{arg}'\n"), 1),
        }
    }
    if let Some(watch) = interp.watch.clone() {
        return match watch.borrow_mut().sleep(total_ms.round().max(0.0) as u64) {
            Ok(()) => ok(String::new()),
            Err(kind) => {
                if interp.interrupted.is_none() {
                    interp.interrupted = Some(kind);
                }
                fail(
                    format!("sleep: interrupted ({})\n", kind.label()),
                    kind.exit_code(),
                )
            }
        };
    }
    (interp.sleep_ms)(total_ms.round().max(0.0) as u64);
    ok(String::new())
}

/// `timeout DURATION COMMAND [ARGS...]`. Runs `COMMAND` via `dispatch` (like
/// `xargs`, not a full shell re-entry). Since every builtin here runs
/// synchronously to completion with no real blocking I/O, there is nothing
/// for a wall-clock deadline to preempt; `DURATION` is validated (same
/// invalid-interval error as upstream) but does not otherwise affect
/// execution, and options controlling *how* to kill the child
/// (`-k`/`-s`/`--preserve-status`/`--foreground`) are accepted and ignored.
pub fn timeout(interp: &mut Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        match a.as_str() {
            "--preserve-status" | "--foreground" => {}
            "-k" | "--kill-after" | "-s" | "--signal" => i += 1,
            _ if a.starts_with("--kill-after=") || a.starts_with("--signal=") => {}
            _ if a.starts_with("--") => {
                return fail(format!("timeout: unrecognized option '{a}'\n"), 1);
            }
            _ if a.starts_with('-') && a.len() > 1 => {}
            _ => break,
        }
        i += 1;
    }
    let rest = &args[i..];
    let Some(duration_str) = rest.first() else {
        return fail("timeout: missing operand\n".to_string(), 1);
    };
    if parse_duration_ms(duration_str).is_none() {
        return fail(
            format!("timeout: invalid time interval '{duration_str}'\n"),
            1,
        );
    }
    let command = &rest[1..];
    if command.is_empty() {
        return fail("timeout: missing operand\n".to_string(), 1);
    }
    super::dispatch(interp, command, stdin, None)
}

/// `time [-p] COMMAND [ARGS...]`. Runs `COMMAND` via `dispatch` and appends a
/// timing report to stderr. There is no real wall clock in this port (see
/// module docs), so elapsed/user/sys time are always reported as zero — a
/// deterministic value is the correct choice for a durable, replayable
/// workflow shell anyway. `-f FORMAT` supports the same directives upstream
/// does (`%e %E %M %S %U %P %C`); `-o FILE`/`-a` write the report to a file
/// instead of stderr.
pub fn time_cmd(interp: &mut Interpreter, args: &[String], stdin: String) -> CommandOutput {
    let mut format = "%e %M".to_string();
    let mut output_file: Option<String> = None;
    let mut append_mode = false;
    let mut posix_format = false;
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        match a.as_str() {
            "-f" | "--format" => {
                i += 1;
                match args.get(i) {
                    Some(v) => format = v.clone(),
                    None => return fail("time: missing argument to '-f'\n".to_string(), 1),
                }
            }
            "-o" | "--output" => {
                i += 1;
                match args.get(i) {
                    Some(v) => output_file = Some(v.clone()),
                    None => return fail("time: missing argument to '-o'\n".to_string(), 1),
                }
            }
            "-a" | "--append" => append_mode = true,
            "-v" | "--verbose" => {
                format = "Command being timed: %C\nElapsed (wall clock) time: %e seconds\nMaximum resident set size (kbytes): %M".to_string();
            }
            "-p" | "--portability" => posix_format = true,
            _ if a.starts_with('-') => {}
            _ => break,
        }
        i += 1;
    }
    let command = &args[i..];
    if command.is_empty() {
        return ok(String::new());
    }

    let display_command = command.join(" ");
    let mut result = super::dispatch(interp, command, stdin, None);

    let timing = if posix_format {
        "real 0.00\nuser 0.00\nsys 0.00\n".to_string()
    } else {
        let mut out = format
            .replace("%e", "0.00")
            .replace("%E", "0:00.00")
            .replace("%M", "0")
            .replace("%S", "0.00")
            .replace("%U", "0.00")
            .replace("%P", "0%")
            .replace("%C", &display_command);
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out
    };

    match output_file {
        Some(file) => {
            let path = super::normalize_path(&interp.cwd, &file);
            let write = if append_mode {
                interp.fs.append_file(&path, timing.as_bytes())
            } else {
                interp.fs.write_file(&path, timing.as_bytes())
            };
            if write.is_err() {
                result
                    .stderr
                    .push_str(&format!("time: cannot write to '{file}'\n"));
            }
        }
        None => result.stderr.push_str(&timing),
    }
    result
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

    mod date_tests {
        use super::*;

        #[test]
        fn default_clock_is_the_unix_epoch() {
            let mut bash = fresh();
            let out = run(&mut bash, "date +%Y-%m-%d");
            assert_eq!(out.stdout, "1970-01-01\n");
        }

        fn host_clock() -> i64 {
            1_700_000_000_000 // 2023-11-14T22:13:20Z
        }

        #[test]
        fn reads_the_host_clock_seam() {
            let mut bash = Bash::new(BashOptions {
                cwd: "/workspace".into(),
                now_ms: host_clock,
                ..Default::default()
            });
            assert_eq!(run(&mut bash, "date -u +%Y-%m-%d").stdout, "2023-11-14\n");
        }

        #[test]
        fn format_directives() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "date +%Y").stdout, "1970\n");
            assert_eq!(run(&mut bash, "date +%H:%M:%S").stdout, "00:00:00\n");
            assert_eq!(run(&mut bash, "date +%a").stdout, "Thu\n");
            assert_eq!(run(&mut bash, "date +%A").stdout, "Thursday\n");
            assert_eq!(run(&mut bash, "date +%j").stdout, "001\n");
            assert_eq!(run(&mut bash, "date '+%s'").stdout, "0\n");
        }

        #[test]
        fn dash_d_at_epoch() {
            let mut bash = fresh();
            let out = run(&mut bash, "date -d @1000000000 +%Y-%m-%d");
            assert_eq!(out.stdout, "2001-09-09\n");
        }

        #[test]
        fn dash_d_iso_date() {
            let mut bash = fresh();
            let out = run(&mut bash, "date -d 2024-03-05 +%Y-%m-%d");
            assert_eq!(out.stdout, "2024-03-05\n");
            let out = run(&mut bash, "date -d '2024-03-05 08:09:10' +%T");
            assert_eq!(out.stdout, "08:09:10\n");
        }

        #[test]
        fn iso_and_rfc_flags() {
            let mut bash = fresh();
            assert_eq!(
                run(&mut bash, "date -I").stdout,
                "1970-01-01T00:00:00+00:00\n"
            );
            assert_eq!(
                run(&mut bash, "date -R").stdout,
                "Thu, 01 Jan 1970 00:00:00 +0000\n"
            );
        }

        #[test]
        fn invalid_date_errors() {
            let mut bash = fresh();
            let out = run(&mut bash, "date -d nonsense");
            assert_eq!(out.exit_code, 1);
            assert!(out.stderr.contains("invalid date"));
        }

        /// 1_700_000_123_456 ms: fraction .456; %N zero-pads to nanoseconds.
        fn fractional_host_clock() -> i64 {
            1_700_000_123_456
        }

        #[test]
        fn sub_second_directives_zero_pad_below_milliseconds() {
            let mut bash = Bash::new(BashOptions {
                cwd: "/workspace".into(),
                now_ms: fractional_host_clock,
                ..Default::default()
            });
            assert_eq!(run(&mut bash, "date +%3N").stdout, "456\n");
            assert_eq!(run(&mut bash, "date +%N").stdout, "456000000\n");
            assert_eq!(run(&mut bash, "date +%1N").stdout, "4\n");
            assert_eq!(run(&mut bash, "date +%6N").stdout, "456000\n");
            assert_eq!(run(&mut bash, "date +%12N").stdout, "456000000000\n");
            assert_eq!(run(&mut bash, "date +%s%N").stdout, "1700000123456000000\n");
        }

        #[test]
        fn sub_second_field_is_zero_for_pinned_dates() {
            let mut bash = Bash::new(BashOptions {
                cwd: "/workspace".into(),
                now_ms: fractional_host_clock,
                ..Default::default()
            });
            assert_eq!(
                run(&mut bash, "date -d @1000000000 +%s%N").stdout,
                "1000000000000000000\n"
            );
        }

        #[test]
        fn digits_before_an_unknown_directive_pass_through() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "date +%3q").stdout, "%3q\n");
        }
    }

    mod expr_tests {
        use super::*;

        #[test]
        fn arithmetic() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "expr 1 + 2").stdout, "3\n");
            assert_eq!(run(&mut bash, "expr 10 - 3").stdout, "7\n");
            assert_eq!(run(&mut bash, "expr 4 \\* 5").stdout, "20\n");
            assert_eq!(run(&mut bash, "expr 17 / 5").stdout, "3\n");
            assert_eq!(run(&mut bash, "expr 17 % 5").stdout, "2\n");
        }

        #[test]
        fn precedence_and_parens() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "expr 2 + 3 \\* 4").stdout, "14\n");
            assert_eq!(run(&mut bash, "expr \\( 2 + 3 \\) \\* 4").stdout, "20\n");
        }

        #[test]
        fn comparisons() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "expr 3 = 3").stdout, "1\n");
            assert_eq!(run(&mut bash, "expr 3 != 3").stdout, "0\n");
            assert_eq!(run(&mut bash, "expr abc = abc").stdout, "1\n");
            assert_eq!(run(&mut bash, "expr 3 \\< 5").stdout, "1\n");
        }

        #[test]
        fn logical_or_and_and() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "expr 0 \\| 5").stdout, "5\n");
            assert_eq!(run(&mut bash, "expr 3 \\& 5").stdout, "3\n");
            assert_eq!(run(&mut bash, "expr 0 \\& 5").stdout, "0\n");
        }

        #[test]
        fn string_functions() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "expr length hello").stdout, "5\n");
            assert_eq!(run(&mut bash, "expr substr hello 2 3").stdout, "ell\n");
            assert_eq!(run(&mut bash, "expr index hello l").stdout, "3\n");
        }

        #[test]
        fn match_operator() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "expr hello : he").stdout, "2\n");
            assert_eq!(run(&mut bash, "expr hello : xyz").stdout, "0\n");
        }

        #[test]
        fn exit_code_reflects_falsiness() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "expr 1 - 1").exit_code, 1);
            assert_eq!(run(&mut bash, "expr 1 + 1").exit_code, 0);
        }

        #[test]
        fn division_by_zero_errors() {
            let mut bash = fresh();
            let out = run(&mut bash, "expr 1 / 0");
            assert_eq!(out.exit_code, 2);
            assert!(out.stderr.contains("division by zero"));
        }

        #[test]
        fn missing_operand_errors() {
            let mut bash = fresh();
            let out = run(&mut bash, "expr");
            assert_eq!(out.exit_code, 2);
            assert!(out.stderr.contains("missing operand"));
        }
    }

    mod sleep_tests {
        use super::*;

        #[test]
        fn valid_durations_return_immediately() {
            let mut bash = fresh();
            assert_eq!(run(&mut bash, "sleep 2").exit_code, 0);
            assert_eq!(run(&mut bash, "sleep 0.5").exit_code, 0);
            assert_eq!(run(&mut bash, "sleep 1s").exit_code, 0);
            assert_eq!(run(&mut bash, "sleep 1m").exit_code, 0);
            assert_eq!(run(&mut bash, "sleep 1 2 3").exit_code, 0);
        }

        #[test]
        fn missing_operand_errors() {
            let mut bash = fresh();
            let out = run(&mut bash, "sleep");
            assert_eq!(out.exit_code, 1);
            assert!(out.stderr.contains("missing operand"));
        }

        #[test]
        fn invalid_interval_errors() {
            let mut bash = fresh();
            let out = run(&mut bash, "sleep abc");
            assert_eq!(out.exit_code, 1);
            assert!(out.stderr.contains("invalid time interval"));
            let out = run(&mut bash, "sleep 1x");
            assert!(out.stderr.contains("invalid time interval"));
        }

        use std::sync::atomic::{AtomicU64, Ordering};
        static SLEPT_MS: AtomicU64 = AtomicU64::new(0);
        fn record_sleep(ms: u64) {
            SLEPT_MS.store(ms, Ordering::SeqCst);
        }

        #[test]
        fn sleeps_for_the_summed_duration_via_the_host_seam() {
            SLEPT_MS.store(0, Ordering::SeqCst);
            let mut bash = Bash::new(BashOptions {
                cwd: "/workspace".into(),
                sleep_ms: record_sleep,
                ..Default::default()
            });
            // 1 + 0.5s + 2 = 3.5s -> 3500ms passed to the durable sleep seam.
            assert_eq!(run(&mut bash, "sleep 1 0.5s 2").exit_code, 0);
            assert_eq!(SLEPT_MS.load(Ordering::SeqCst), 3500);
        }
    }

    mod timeout_tests {
        use super::*;

        #[test]
        fn runs_the_wrapped_command() {
            let mut bash = fresh();
            let out = run(&mut bash, "timeout 5 echo hi");
            assert_eq!(out.stdout, "hi\n");
            assert_eq!(out.exit_code, 0);
        }

        #[test]
        fn propagates_the_wrapped_command_exit_code() {
            let mut bash = fresh();
            let out = run(&mut bash, "timeout 5 false");
            assert_eq!(out.exit_code, 1);
        }

        #[test]
        fn missing_operand_errors() {
            let mut bash = fresh();
            let out = run(&mut bash, "timeout");
            assert_eq!(out.exit_code, 1);
            assert!(out.stderr.contains("missing operand"));
        }

        #[test]
        fn invalid_interval_errors() {
            let mut bash = fresh();
            let out = run(&mut bash, "timeout abc echo hi");
            assert_eq!(out.exit_code, 1);
            assert!(out.stderr.contains("invalid time interval"));
        }
    }

    mod time_tests {
        use super::*;

        #[test]
        fn runs_command_and_reports_timing_on_stderr() {
            let mut bash = fresh();
            let out = run(&mut bash, "time echo hi");
            assert_eq!(out.stdout, "hi\n");
            assert!(out.stderr.contains("0.00"));
        }

        #[test]
        fn posix_format() {
            let mut bash = fresh();
            let out = run(&mut bash, "time -p echo hi");
            assert!(out.stderr.contains("real 0.00"));
        }

        #[test]
        fn no_command_is_a_no_op() {
            let mut bash = fresh();
            let out = run(&mut bash, "time");
            assert_eq!(out.exit_code, 0);
            assert_eq!(out.stdout, "");
        }
    }
}
