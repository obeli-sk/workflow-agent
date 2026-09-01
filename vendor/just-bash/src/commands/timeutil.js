// PORT: vendor/just-bash-rs/src/commands/timeutil.rs
// date [-u] [-d STRING] [-I] [-R] [+FORMAT], expr, sleep, timeout, time.
//
// Five small commands grouped here because they share either the clock
// (`date`) or the "run a nested command" shape (`time`/`timeout`, which
// dispatch straight to `interp.invoke` like `xargs` does rather than
// re-entering the parser).
//
// This interpreter is a synchronous, single-threaded, deterministic durable
// workflow shell. `date` reaches the host through the `interp.now()` seam
// (the durable Obelisk clock under the workflow, `Bash`'s `nowMs` option
// otherwise). `timeout` does not enforce a wall-clock deadline (every
// builtin here runs synchronously to completion, so there is nothing for a
// deadline to preempt) and `time` always reports zero elapsed time — a
// deterministic value is the correct choice for a durable, replayable
// workflow shell anyway.
//
// A fuller `sleepCommand` is included here too (multi-arg summing + the
// same invalid-interval error text as upstream) since it is part of
// timeutil.rs's own scope, even though `commands/core.js` already has a
// minimal single-arg `sleep`. See the migration doc / this port's commit
// message for which one the command registry should end up using.

import { ok, fail } from "./core.js";
import { translateBre } from "../regex-bre.js";

// ---------------------------------------------------------------------
// Calendar math (Howard Hinnant's civil_from_days / days_from_civil), used
// by `date`. No timezone database is available in this port, so all
// calculations are UTC-only.
// ---------------------------------------------------------------------

function isLeapYear(y) {
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function divEuclid(a, b) {
    return Math.floor(a / b);
}
function remEuclid(a, b) {
    return ((a % b) + b) % b;
}

// Days since the epoch (1970-01-01) -> [year, month 1-12, day 1-31].
function civilFromDays(z) {
    z += 719468;
    const era = Math.trunc((z >= 0 ? z : z - 146096) / 146097);
    const doe = z - era * 146097; // [0, 146096]
    const yoe = Math.trunc((doe - Math.trunc(doe / 1460) + Math.trunc(doe / 36524) - Math.trunc(doe / 146096)) / 365); // [0, 399]
    const y = yoe + era * 400;
    const doy = doe - (365 * yoe + Math.trunc(yoe / 4) - Math.trunc(yoe / 100)); // [0, 365]
    const mp = Math.trunc((5 * doy + 2) / 153); // [0, 11]
    const d = doy - Math.trunc((153 * mp + 2) / 5) + 1; // [1, 31]
    const m = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
    return [m <= 2 ? y + 1 : y, m, d];
}

// [year, month, day] -> days since the epoch. Inverse of civilFromDays.
function daysFromCivil(y, m, d) {
    y = m <= 2 ? y - 1 : y;
    const era = Math.trunc((y >= 0 ? y : y - 399) / 400);
    const yoe = y - era * 400; // [0, 399]
    const mp = m > 2 ? m - 3 : m + 9; // [0, 11]
    const doy = Math.trunc((153 * mp + 2) / 5) + d - 1; // [0, 365]
    const doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy; // [0, 146096]
    return era * 146097 + doe - 719468;
}

// 0 = Sunday .. 6 = Saturday. 1970-01-01 (day 0) was a Thursday.
function weekdayFromDays(days) {
    return ((days % 7) + 7 + 4) % 7;
}

function hour12(h) {
    return h % 12 === 0 ? 12 : h % 12;
}

const YDAY_CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

function dayOfYear(y, m, d) {
    let doy = YDAY_CUM[m - 1] + d;
    if (m > 2 && isLeapYear(y)) doy += 1;
    return doy;
}

function epochToParts(secs) {
    const days = divEuclid(secs, 86400);
    const sod = remEuclid(secs, 86400);
    const [year, month, day] = civilFromDays(days);
    return {
        year,
        month,
        day,
        hour: Math.floor(sod / 3600),
        minute: Math.floor((sod % 3600) / 60),
        second: sod % 60,
        weekday: weekdayFromDays(days),
        yday: dayOfYear(year, month, day),
    };
}

function partsToEpoch(y, m, d, hh, mm, ss) {
    return daysFromCivil(y, m, d) * 86400 + hh * 3600 + mm * 60 + ss;
}

const DOW_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MON_FULL = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

// Sunday- or Monday-first week number (%U/%W): days before the first
// occurrence of the week-start day are week 00.
function weekNumber(p, startDay) {
    const jan1Days = daysFromCivil(p.year, 1, 1);
    const jan1Dow = weekdayFromDays(jan1Days);
    const firstWeekStart = 1 + (7 + startDay - jan1Dow) % 7;
    if (p.yday < firstWeekStart) return 0;
    return Math.floor((p.yday - firstWeekStart) / 7) + 1;
}

function pad2(n) {
    return String(n).padStart(2, "0");
}
function pad2Space(n) {
    return String(n).padStart(2, " ");
}

// The %[n]N field: milliseconds scaled to nanoseconds (lower digits are
// zeros), truncated to `width` digits or zero-extended past 9.
function pushFraction(millis, width) {
    let digits = String(millis * 1_000_000).padStart(9, "0");
    if (width > 9) digits += "0".repeat(width - 9);
    else digits = digits.slice(0, width);
    return digits;
}

// Format a subset of strftime directives against a UTC instant. The clock
// seam only carries milliseconds, so the sub-second directives (%N, %<n>N)
// zero-pad below milliseconds. Not ported: %V/%G/%g (ISO week-date, needs
// leap-week rules), locale alternates (%Ec etc).
function formatStrftime(fmt, secs, millis) {
    const p = epochToParts(secs);
    let out = "";
    let i = 0;
    while (i < fmt.length) {
        const c = fmt[i++];
        if (c !== "%") { out += c; continue; }
        const d = fmt[i];
        if (d === undefined) { out += "%"; break; }
        i++;
        if (d === "N") { out += pushFraction(millis, 9); continue; }
        if (d >= "0" && d <= "9") {
            let width = d;
            let follower = fmt[i];
            while (follower !== undefined && follower >= "0" && follower <= "9") {
                width += follower;
                i++;
                follower = fmt[i];
            }
            if (follower === "N") {
                i++;
                out += pushFraction(millis, parseInt(width, 10) || 9);
            } else {
                out += `%${width}`;
                if (follower !== undefined) { out += follower; i++; }
            }
            continue;
        }
        switch (d) {
            case "Y": out += String(p.year); break;
            case "y": out += pad2(remEuclid(p.year, 100)); break;
            case "C": out += pad2(divEuclid(p.year, 100)); break;
            case "m": out += pad2(p.month); break;
            case "d": out += pad2(p.day); break;
            case "e": out += pad2Space(p.day); break;
            case "H": out += pad2(p.hour); break;
            case "k": out += pad2Space(p.hour); break;
            case "I": out += pad2(hour12(p.hour)); break;
            case "l": out += pad2Space(hour12(p.hour)); break;
            case "M": out += pad2(p.minute); break;
            case "S": out += pad2(p.second); break;
            case "s": out += String(secs); break;
            case "p": out += p.hour < 12 ? "AM" : "PM"; break;
            case "P": out += p.hour < 12 ? "am" : "pm"; break;
            case "a": out += DOW_ABBR[p.weekday]; break;
            case "A": out += DOW_FULL[p.weekday]; break;
            case "b": case "h": out += MON_ABBR[p.month - 1]; break;
            case "B": out += MON_FULL[p.month - 1]; break;
            case "j": out += String(p.yday).padStart(3, "0"); break;
            case "u": out += String(p.weekday === 0 ? 7 : p.weekday); break;
            case "w": out += String(p.weekday); break;
            case "U": out += pad2(weekNumber(p, 0)); break;
            case "W": out += pad2(weekNumber(p, 1)); break;
            case "F": out += `${p.year}-${pad2(p.month)}-${pad2(p.day)}`; break;
            case "D": case "x": out += `${pad2(p.month)}/${pad2(p.day)}/${pad2(remEuclid(p.year, 100))}`; break;
            case "T": case "X": out += `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`; break;
            case "R": out += `${pad2(p.hour)}:${pad2(p.minute)}`; break;
            case "r": out += `${pad2(hour12(p.hour))}:${pad2(p.minute)}:${pad2(p.second)} ${p.hour < 12 ? "AM" : "PM"}`; break;
            case "c": out += `${DOW_ABBR[p.weekday]} ${MON_ABBR[p.month - 1]} ${pad2Space(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)} ${p.year}`; break;
            case "n": out += "\n"; break;
            case "t": out += "\t"; break;
            case "z": out += "+0000"; break;
            case "Z": out += "UTC"; break;
            case "%": out += "%"; break;
            default: out += `%${d}`; break;
        }
    }
    return out;
}

function parseIntStrict(s) {
    if (s === undefined || s === "" || !/^-?\d+$/.test(s)) return null;
    return parseInt(s, 10);
}

// Parse a `date -d`/`--date=` argument. Supports `@N` (Unix epoch seconds),
// `now`/`today`, `yesterday`/`tomorrow` (relative to `nowSecs`), and a bare
// ISO-ish `YYYY-MM-DD[ HH:MM[:SS]]` (interpreted as UTC, since this port has
// no timezone database). Not ported: free-form natural-language dates
// ("next friday"), explicit UTC offsets/`Z` suffixes, and RFC 2822 dates —
// genuinely out of scope for a hand-rolled parser.
function parseDateSpec(spec, nowSecs) {
    if (spec.startsWith("@")) return parseIntStrict(spec.slice(1));
    const lower = spec.trim().toLowerCase();
    if (lower === "now" || lower === "today") return nowSecs;
    if (lower === "yesterday") return nowSecs - 86400;
    if (lower === "tomorrow") return nowSecs + 86400;

    const s = spec.trim();
    let splitIdx = -1;
    for (let k = 0; k < s.length; k++) {
        if (s[k] === "T" || s[k] === " ") { splitIdx = k; break; }
    }
    const datePart = splitIdx === -1 ? s : s.slice(0, splitIdx);
    const timePart = splitIdx === -1 ? null : s.slice(splitIdx + 1);

    const dateFields = datePart.split("-");
    if (dateFields.length !== 3) return null;
    const year = parseIntStrict(dateFields[0]);
    const month = parseIntStrict(dateFields[1]);
    const day = parseIntStrict(dateFields[2]);
    if (year === null || month === null || day === null) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;

    let hour = 0, minute = 0, second = 0;
    if (timePart !== null) {
        const parts = timePart.split(":");
        if (parts.length < 1 || parts.length > 3) return null;
        hour = parseIntStrict(parts[0]);
        minute = parts[1] !== undefined ? parseIntStrict(parts[1]) : 0;
        second = parts[2] !== undefined ? parseIntStrict(parts[2]) : 0;
        if (hour === null || minute === null || second === null) return null;
    }
    return partsToEpoch(year, month, day, hour, minute, second);
}

// `date [-u] [-d STRING] [-I] [-R] [+FORMAT]`. Always displays UTC (no
// timezone database in this port, so `$TZ` is not consulted; `-u` is
// accordingly a no-op). See `parseDateSpec`/`formatStrftime` for the
// supported subsets.
export function dateCommand(interp, args) {
    let dateStr = null;
    let fmt = null;
    let iso = false;
    let rfc = false;
    let i = 1;
    while (i < args.length) {
        const a = args[i];
        if (a === "-u" || a === "--utc") { /* no timezone db; no-op */ }
        else if (a === "-I" || a === "--iso-8601") iso = true;
        else if (a === "-R" || a === "--rfc-email") rfc = true;
        else if (a === "-d" || a === "--date") {
            i++;
            if (args[i] === undefined) return fail("date: option requires an argument -- 'd'\n", 1);
            dateStr = args[i];
        } else if (a.startsWith("--date=")) dateStr = a.slice("--date=".length);
        else if (a.startsWith("+")) fmt = a.slice(1);
        else return fail(`date: invalid option '${a}'\n`, 1);
        i++;
    }

    const nowMs = interp.now();
    // A `-d` spec pins whole seconds only, so its sub-second field is zero.
    let secs, millis;
    if (dateStr !== null) {
        const parsed = parseDateSpec(dateStr, divEuclid(nowMs, 1000));
        if (parsed === null) return fail(`date: invalid date '${dateStr}'\n`, 1);
        secs = parsed;
        millis = 0;
    } else {
        secs = divEuclid(nowMs, 1000);
        millis = remEuclid(nowMs, 1000);
    }

    let out;
    if (fmt !== null) out = formatStrftime(fmt, secs, millis);
    else if (iso) out = formatStrftime("%Y-%m-%dT%H:%M:%S+00:00", secs, millis);
    else if (rfc) out = formatStrftime("%a, %d %b %Y %H:%M:%S +0000", secs, millis);
    else out = formatStrftime("%a %b %e %H:%M:%S UTC %Y", secs, millis);
    return ok(`${out}\n`);
}

// ---------------------------------------------------------------------
// expr
// ---------------------------------------------------------------------

class ExprError extends Error {}

function toIntStrict(s) {
    if (!/^-?\d+$/.test(s)) return null;
    const n = parseInt(s, 10);
    return Number.isSafeInteger(n) ? n : null;
}
function requireInt(s) {
    const n = toIntStrict(s);
    if (n === null) throw new ExprError("non-integer argument");
    return n;
}
function compareOp(op, l, r) {
    switch (op) {
        case "=": return l === r;
        case "!=": return l !== r;
        case "<": return l < r;
        case ">": return l > r;
        case "<=": return l <= r;
        case ">=": return l >= r;
        default: return false;
    }
}

// `str : pattern` / `match str pattern`: anchor the (BRE) pattern at the
// start of `str`; a capturing group returns its match, otherwise the length
// of the whole match; no match returns "0".
function matchBre(text, pattern) {
    const translated = translateBre(pattern);
    let re;
    try {
        re = new RegExp(`^(?:${translated})`);
    } catch {
        throw new ExprError(`invalid regex '${pattern}'`);
    }
    const m = re.exec(text);
    if (!m) return "0";
    if (m[1] !== undefined) return m[1];
    return String([...m[0]].length);
}

// `expr` evaluates its argv as a small POSIX expression: `|`/`&` logical
// or/and, `= != < > <= >=` comparisons (numeric if both sides parse as
// integers, string otherwise), `+ -`, `* / %`, a `:` regex-match operator
// (POSIX BRE anchored at the start, translated via the same `translateBre`
// grep/sed share), `match`/`substr`/`index`/`length`, and parens. Regular
// (safe-integer) JS number arithmetic, not POSIX's arbitrary precision — a
// scope simplification matching the Rust port's own i64 simplification.
class ExprParser {
    constructor(args) {
        this.args = args;
        this.i = 0;
    }
    peek() {
        return this.i < this.args.length ? this.args[this.i] : undefined;
    }
    parseOr() {
        let left = this.parseAnd();
        while (this.peek() === "|") {
            this.i++;
            const right = this.parseAnd();
            if (left === "0" || left === "") left = right;
        }
        return left;
    }
    parseAnd() {
        let left = this.parseComparison();
        while (this.peek() === "&") {
            this.i++;
            const right = this.parseComparison();
            if (left === "0" || left === "" || right === "0" || right === "") left = "0";
        }
        return left;
    }
    parseComparison() {
        let left = this.parseAddsub();
        while (["=", "!=", "<", ">", "<=", ">="].includes(this.peek())) {
            const op = this.peek();
            this.i++;
            const right = this.parseAddsub();
            const ln = toIntStrict(left);
            const rn = toIntStrict(right);
            const result = ln !== null && rn !== null ? compareOp(op, ln, rn) : compareOp(op, left, right);
            left = result ? "1" : "0";
        }
        return left;
    }
    parseAddsub() {
        let left = this.parseMuldiv();
        while (this.peek() === "+" || this.peek() === "-") {
            const op = this.peek();
            this.i++;
            const right = this.parseMuldiv();
            const l = requireInt(left);
            const r = requireInt(right);
            left = String(op === "+" ? l + r : l - r);
        }
        return left;
    }
    parseMuldiv() {
        let left = this.parseMatch();
        while (this.peek() === "*" || this.peek() === "/" || this.peek() === "%") {
            const op = this.peek();
            this.i++;
            const right = this.parseMatch();
            const l = requireInt(left);
            const r = requireInt(right);
            if ((op === "/" || op === "%") && r === 0) throw new ExprError("division by zero");
            left = String(op === "*" ? l * r : op === "/" ? Math.trunc(l / r) : l % r);
        }
        return left;
    }
    parseMatch() {
        let left = this.parsePrimary();
        while (this.peek() === ":") {
            this.i++;
            const pattern = this.parsePrimary();
            left = matchBre(left, pattern);
        }
        return left;
    }
    parsePrimary() {
        const token = this.peek();
        if (token === undefined) throw new ExprError("syntax error");
        switch (token) {
            case "match": {
                this.i++;
                const s = this.parsePrimary();
                const pattern = this.parsePrimary();
                return matchBre(s, pattern);
            }
            case "substr": {
                this.i++;
                const s = this.parsePrimary();
                const pos = requireInt(this.parsePrimary());
                const len = requireInt(this.parsePrimary());
                const chars = [...s];
                const start = Math.max(pos - 1, 0);
                const end = start + Math.max(len, 0);
                if (pos < 1 || len < 0 || start >= chars.length) return "";
                return chars.slice(start, Math.min(end, chars.length)).join("");
            }
            case "index": {
                this.i++;
                const s = this.parsePrimary();
                const charsArg = this.parsePrimary();
                const set = new Set([...charsArg]);
                const idx = [...s].findIndex((c) => set.has(c));
                return idx === -1 ? "0" : String(idx + 1);
            }
            case "length": {
                this.i++;
                const s = this.parsePrimary();
                return String([...s].length);
            }
            case "(": {
                this.i++;
                const result = this.parseOr();
                if (this.peek() !== ")") throw new ExprError("syntax error");
                this.i++;
                return result;
            }
            default:
                this.i++;
                return token;
        }
    }
}

export function exprCommand(interp, args) {
    const rest = args.slice(1);
    if (rest.length === 0) return fail("expr: missing operand\n", 2);
    const p = new ExprParser(rest);
    let result;
    try {
        result = p.parseOr();
    } catch (e) {
        if (e instanceof ExprError) return fail(`expr: ${e.message}\n`, 2);
        throw e;
    }
    if (p.i !== p.args.length) return fail("expr: syntax error\n", 2);
    const exitCode = result === "0" || result === "" ? 1 : 0;
    return { stdout: `${result}\n`, stderr: "", exitCode };
}

// ---------------------------------------------------------------------
// sleep / timeout / time
// ---------------------------------------------------------------------

// Parse a duration like `5`, `1.5s`, `2m`, `3h`, `1d` into milliseconds.
function parseDurationMs(s) {
    let number = s;
    let suffix = "s";
    const last = s.length > 0 ? s[s.length - 1] : "";
    if (last === "s" || last === "m" || last === "h" || last === "d") {
        number = s.slice(0, -1);
        suffix = last;
    }
    if (number === "" || ![...number].every((c) => (c >= "0" && c <= "9") || c === ".")) return null;
    const value = Number(number);
    if (Number.isNaN(value)) return null;
    switch (suffix) {
        case "s": return value * 1000;
        case "m": return value * 60_000;
        case "h": return value * 3_600_000;
        case "d": return value * 86_400_000;
        default: return null;
    }
}

// `sleep NUMBER[SUFFIX]...`. Validates its arguments (same error messages as
// upstream), sums them, and sleeps via the host `sleepFn` seam (`Bash`'s
// `sleepMs` option). Under the workflow that seam is the durable Obelisk
// `sleep`, so the delay suspends the workflow rather than busy-waiting.
//
// Not ported: timeutil.rs's script-watch integration (a timeout/operator
// interrupt joining the sleep and ending it early) — this JS interpreter's
// watch guard (`interp.checkWatch()`) fires generically at statement
// boundaries instead of being threaded through individual builtins, so
// there is no per-command seam to hook here; see `interpreter.js`.
export function sleepCommand(interp, args) {
    const rest = args.slice(1);
    if (rest.length === 0) return fail("sleep: missing operand\n", 1);
    let totalMs = 0;
    for (const arg of rest) {
        const ms = parseDurationMs(arg);
        if (ms === null) return fail(`sleep: invalid time interval '${arg}'\n`, 1);
        totalMs += ms;
    }
    interp.sleepFn(Math.max(Math.round(totalMs), 0));
    return ok("");
}

// `timeout DURATION COMMAND [ARGS...]`. Runs `COMMAND` via `interp.invoke`
// (like `xargs`, not a full shell re-entry). Since every builtin here runs
// synchronously to completion with no real blocking I/O, there is nothing
// for a wall-clock deadline to preempt; `DURATION` is validated (same
// invalid-interval error as upstream) but does not otherwise affect
// execution, and options controlling *how* to kill the child
// (`-k`/`-s`/`--preserve-status`/`--foreground`) are accepted and ignored.
export function timeoutCommand(interp, args, stdin) {
    let i = 1;
    while (i < args.length) {
        const a = args[i];
        if (a === "--preserve-status" || a === "--foreground") { /* no-op */ }
        else if (a === "-k" || a === "--kill-after" || a === "-s" || a === "--signal") i++;
        else if (a.startsWith("--kill-after=") || a.startsWith("--signal=")) { /* no-op */ }
        else if (a.startsWith("--")) return fail(`timeout: unrecognized option '${a}'\n`, 1);
        else if (a.startsWith("-") && a.length > 1) { /* single-dash flag: accepted, ignored */ }
        else break;
        i++;
    }
    const rest = args.slice(i);
    const durationStr = rest[0];
    if (durationStr === undefined) return fail("timeout: missing operand\n", 1);
    if (parseDurationMs(durationStr) === null) return fail(`timeout: invalid time interval '${durationStr}'\n`, 1);
    const command = rest.slice(1);
    if (command.length === 0) return fail("timeout: missing operand\n", 1);
    return interp.invoke(command, stdin);
}

// `time [-p] COMMAND [ARGS...]`. Runs `COMMAND` via `interp.invoke` and
// appends a timing report to stderr. There is no real wall clock in this
// port (see module docs), so elapsed/user/sys time are always reported as
// zero. `-f FORMAT` supports the same directives upstream does
// (`%e %E %M %S %U %P %C`); `-o FILE`/`-a` write the report to a file
// instead of stderr.
export function timeCommand(interp, args, stdin) {
    let format = "%e %M";
    let outputFile = null;
    let appendMode = false;
    let posixFormat = false;
    let i = 1;
    while (i < args.length) {
        const a = args[i];
        if (a === "-f" || a === "--format") {
            i++;
            if (args[i] === undefined) return fail("time: missing argument to '-f'\n", 1);
            format = args[i];
        } else if (a === "-o" || a === "--output") {
            i++;
            if (args[i] === undefined) return fail("time: missing argument to '-o'\n", 1);
            outputFile = args[i];
        } else if (a === "-a" || a === "--append") {
            appendMode = true;
        } else if (a === "-v" || a === "--verbose") {
            format = "Command being timed: %C\nElapsed (wall clock) time: %e seconds\nMaximum resident set size (kbytes): %M";
        } else if (a === "-p" || a === "--portability") {
            posixFormat = true;
        } else if (a.startsWith("-")) {
            /* other flags: accepted, ignored */
        } else {
            break;
        }
        i++;
    }
    const command = args.slice(i);
    if (command.length === 0) return ok("");

    const displayCommand = command.join(" ");
    const result = interp.invoke(command, stdin);

    let timing;
    if (posixFormat) {
        timing = "real 0.00\nuser 0.00\nsys 0.00\n";
    } else {
        let out = format
            .replaceAll("%e", "0.00")
            .replaceAll("%E", "0:00.00")
            .replaceAll("%M", "0")
            .replaceAll("%S", "0.00")
            .replaceAll("%U", "0.00")
            .replaceAll("%P", "0%")
            .replaceAll("%C", displayCommand);
        if (!out.endsWith("\n")) out += "\n";
        timing = out;
    }

    let stdout = result.stdout;
    let stderr = result.stderr;
    const exitCode = result.exitCode;
    if (outputFile !== null) {
        const path = interp.resolvePath(outputFile);
        try {
            if (appendMode) interp.vfs.appendFile(path, timing);
            else interp.vfs.writeFile(path, timing);
        } catch {
            stderr += `time: cannot write to '${outputFile}'\n`;
        }
    } else {
        stderr += timing;
    }
    return { stdout, stderr, exitCode };
}
