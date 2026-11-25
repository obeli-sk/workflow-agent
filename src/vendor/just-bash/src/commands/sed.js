// sed [-nEsuz] [-i[SUFFIX]] [-e SCRIPT]... [-f FILE]... [SCRIPT] [FILE...]
// A GNU sed subset. Addresses: N, $, /re/ and \cREc (I/M flags), first~step,
// 0,/re/, addr,+N, addr,~N, leading !. Commands: { } s y a i c d D p P n N
// g G h H x b t T : = l q Q r R w z F and # comments. GNU escapes (\n \t
// \xHH \oNNN \dNNN \cX) and \U \L \u \l \E work in s replacements and a/i/c text.
// Not ported: e, W, v, the s///e flag, --follow-symlinks.

import { fail } from "./core.js";
import { translateBre, translateEre } from "../regex-bre.js";

class SedError extends Error {}

const MAX_CYCLE_STEPS = 1_000_000;

function compileRegex(pattern, extended, flags) {
    if (pattern === "") return null; // reuse the last regex, resolved at runtime
    const core = extended ? translateEre(pattern) : translateBre(pattern);
    try {
        return new RegExp(core, `gs${flags}`);
    } catch {
        throw new SedError(`invalid regex: ${pattern}`);
    }
}

// The escape after a backslash at chars[i], or null when it is not one.
function decodeEscape(chars, i) {
    const c = chars[i];
    const simple = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", a: "\x07" };
    if (simple[c] !== undefined) return [simple[c], i + 1];
    const radix = { x: [16, 2, /[0-9A-Fa-f]/], o: [8, 3, /[0-7]/], d: [10, 3, /[0-9]/] }[c];
    if (radix) {
        const [base, max, digit] = radix;
        let j = i + 1;
        let digits = "";
        while (j < chars.length && digits.length < max && digit.test(chars[j])) digits += chars[j++];
        if (digits === "") return null;
        return [String.fromCharCode(parseInt(digits, base)), j];
    }
    if (c === "c" && i + 1 < chars.length) {
        return [String.fromCharCode(chars[i + 1].toUpperCase().charCodeAt(0) ^ 0x40), i + 2];
    }
    return null;
}

class ScriptParser {
    constructor(script, extended) {
        this.chars = [...script];
        this.i = 0;
        this.extended = extended;
        this.prog = [];
        this.labels = new Map();
        this.writeFiles = new Set();
    }

    error(message) {
        return new SedError(`-e expression #1, char ${this.i}: ${message}`);
    }

    peek() {
        return this.chars[this.i];
    }

    skipBlanks() {
        while (this.peek() === " " || this.peek() === "\t") this.i++;
    }

    restOfLine() {
        const start = this.i;
        while (this.i < this.chars.length && this.peek() !== "\n") this.i++;
        return this.chars.slice(start, this.i).join("");
    }

    // Reads up to an unescaped `delim`; `\delim` becomes `delim`, other escapes stay.
    readDelimited(delim, what) {
        let out = "";
        while (this.i < this.chars.length && this.peek() !== delim) {
            const c = this.peek();
            if (c === "\\" && this.i + 1 < this.chars.length) {
                const next = this.chars[this.i + 1];
                if (next === delim) out += delim;
                else if (next === "\n") out += "\\n";
                else out += c + next;
                this.i += 2;
            } else {
                if (c === "\n" && what !== "replacement") throw this.error(`unterminated ${what}`);
                out += c;
                this.i++;
            }
        }
        if (this.peek() !== delim) throw this.error(`unterminated ${what}`);
        this.i++;
        return out;
    }

    readNumber() {
        const start = this.i;
        while (/[0-9]/.test(this.peek() ?? "")) this.i++;
        return parseInt(this.chars.slice(start, this.i).join(""), 10);
    }

    parseRegexAddress(delim) {
        const pattern = this.readDelimited(delim, "address regex");
        let flags = "";
        while (this.peek() === "I" || this.peek() === "M") {
            flags += this.peek() === "I" ? "i" : "m";
            this.i++;
        }
        return { kind: "regex", re: compileRegex(pattern, this.extended, flags) };
    }

    parseAddress() {
        const c = this.peek();
        if (c === "$") { this.i++; return { kind: "last" }; }
        if (/[0-9]/.test(c ?? "")) {
            const n = this.readNumber();
            if (this.peek() === "~") {
                this.i++;
                return { kind: "step", first: n, step: this.readNumber() || 0 };
            }
            return { kind: "line", n };
        }
        if (c === "/") { this.i++; return this.parseRegexAddress("/"); }
        if (c === "\\" && this.i + 1 < this.chars.length) {
            const delim = this.chars[this.i + 1];
            this.i += 2;
            return this.parseRegexAddress(delim);
        }
        return null;
    }

    parseEndAddress() {
        this.skipBlanks();
        const c = this.peek();
        if (c === "+" || c === "~") {
            this.i++;
            if (!/[0-9]/.test(this.peek() ?? "")) throw this.error("expected number after " + c);
            return { kind: c === "+" ? "plus" : "multiple", n: this.readNumber() };
        }
        const addr = this.parseAddress();
        if (!addr || addr.kind === "step") throw this.error("unexpected `,'");
        return addr;
    }

    // a/i/c text: `a text` drops leading blanks, `a\text` and `a\<newline>text`
    // keep them; a trailing backslash continues the text onto the next line.
    parseText(cmd) {
        this.skipBlanks();
        let sawBackslash = false;
        if (this.peek() === "\\") {
            sawBackslash = true;
            this.i++;
            if (this.peek() === "\n") this.i++;
        }
        if (this.i >= this.chars.length) {
            if (sawBackslash) return null;
            throw this.error(`expected \\ after \`a', \`c' or \`i'`);
        }
        let text = "";
        while (this.i < this.chars.length && this.peek() !== "\n") {
            const c = this.peek();
            if (c !== "\\") { text += c; this.i++; continue; }
            const next = this.chars[this.i + 1];
            if (next === undefined) { this.i++; break; }
            if (next === "\n") { text += "\n"; this.i += 2; continue; }
            const decoded = decodeEscape(this.chars, this.i + 1);
            if (decoded) { text += decoded[0]; this.i = decoded[1]; continue; }
            text += next;
            this.i += 2;
        }
        if (text === "" && !sawBackslash) throw this.error(`expected \\ after \`a', \`c' or \`i'`);
        return { kind: cmd, text: `${text}\n` };
    }

    parseSubstitute() {
        const delim = this.peek();
        if (delim === undefined || delim === "\n" || delim === "\\") throw this.error("unterminated `s' command");
        this.i++;
        const pattern = this.readDelimited(delim, "`s' command");
        const replacement = this.readDelimited(delim, "replacement");
        let global = false, print = 0, occurrence = null, flags = "", wfile = null;
        for (;;) {
            const c = this.peek();
            if (c === "g") global = true;
            else if (c === "p") print += 1;
            else if (c === "i" || c === "I") flags += "i";
            else if (c === "m" || c === "M") flags += "m";
            else if (c === "e") throw this.error("the `e' flag is not supported");
            else if (/[0-9]/.test(c ?? "")) { occurrence = this.readNumber(); continue; }
            else if (c === "w") {
                this.i++;
                this.skipBlanks();
                wfile = this.restOfLine();
                this.writeFiles.add(wfile);
                break;
            } else break;
            this.i++;
        }
        if (occurrence === 0) throw this.error("number option to `s' command may not be zero");
        return {
            kind: "s",
            regex: compileRegex(pattern, this.extended, flags),
            replacement: [...replacement],
            global,
            print,
            occurrence,
            wfile,
        };
    }

    parseTransliterate() {
        const delim = this.peek();
        this.i++;
        const decode = (raw) => {
            const chars = [...raw];
            const out = [];
            for (let j = 0; j < chars.length; j++) {
                if (chars[j] === "\\" && chars[j + 1] === "n") { out.push("\n"); j++; }
                else if (chars[j] === "\\" && chars[j + 1] === "\\") { out.push("\\"); j++; }
                else out.push(chars[j]);
            }
            return out;
        };
        const from = decode(this.readDelimited(delim, "`y' command"));
        const to = decode(this.readDelimited(delim, "`y' command"));
        if (from.length !== to.length) throw this.error("strings for `y' command are different lengths");
        return { kind: "y", map: new Map(from.map((c, j) => [c, to[j]])) };
    }

    readLabel() {
        this.skipBlanks();
        const start = this.i;
        while (this.i < this.chars.length && !";\n}".includes(this.peek())) this.i++;
        return this.chars.slice(start, this.i).join("").trim();
    }

    parse() {
        const open = [];
        if (this.chars[0] === "#" && this.chars[1] === "n" && (this.chars[2] === "\n" || this.chars.length === 2)) {
            this.quiet = true;
        }
        for (;;) {
            while (this.i < this.chars.length && /[\s;]/.test(this.peek())) this.i++;
            if (this.i >= this.chars.length) break;
            if (this.peek() === "#") { this.restOfLine(); continue; }

            const a1 = this.parseAddress();
            let a2 = null;
            this.skipBlanks();
            if (a1 && this.peek() === ",") { this.i++; a2 = this.parseEndAddress(); }
            if (a1?.kind === "line" && a1.n === 0 && a2?.kind !== "regex") throw this.error("invalid usage of line address 0");
            this.skipBlanks();
            let negate = false;
            while (this.peek() === "!") { negate = true; this.i++; this.skipBlanks(); }

            const c = this.peek();
            if (c === undefined) throw this.error("missing command");
            this.i++;
            let cmd;
            if (c === "{") {
                cmd = { kind: "{", end: -1 };
                open.push(this.prog.length);
            } else if (c === "}") {
                if (a1) throw this.error("} doesn't want any addresses");
                if (open.length === 0) throw this.error("unexpected `}'");
                this.prog[open.pop()].cmd.end = this.prog.length;
                cmd = { kind: "}" };
            } else if (c === ":") {
                if (a1) throw this.error(": doesn't want any addresses");
                const label = this.readLabel();
                if (label === "") throw this.error("\":\" lacks a label");
                this.labels.set(label, this.prog.length);
                continue;
            } else if ("btT".includes(c)) {
                cmd = { kind: c, label: this.readLabel() };
            } else if ("=dDgGhHnNpPxzF".includes(c)) {
                cmd = { kind: c };
            } else if (c === "l" || c === "q" || c === "Q") {
                this.skipBlanks();
                const n = /[0-9]/.test(this.peek() ?? "") ? this.readNumber() : null;
                cmd = { kind: c, n };
            } else if (c === "a" || c === "i" || c === "c") {
                cmd = this.parseText(c) ?? { kind: "noop" };
            } else if ("rRw".includes(c)) {
                this.skipBlanks();
                cmd = { kind: c, file: this.restOfLine() };
                if (c === "w") this.writeFiles.add(cmd.file);
            } else if (c === "s") {
                cmd = this.parseSubstitute();
            } else if (c === "y") {
                cmd = this.parseTransliterate();
            } else if (c === "e") {
                throw this.error("the `e' command is not supported");
            } else {
                this.i--;
                throw this.error(`unknown command: \`${c}'`);
            }
            this.prog.push({ a1, a2, negate, cmd, range: { active: false, end: 0 } });

            this.skipBlanks();
            const after = this.peek();
            if (c !== "{" && after !== undefined && !";\n}#".includes(after)) {
                throw this.error(`extra characters after command`);
            }
        }
        if (open.length > 0) throw this.error("unmatched `{'");
        for (const { cmd } of this.prog) {
            if ("btT".includes(cmd.kind) && cmd.label !== "" && !this.labels.has(cmd.label)) {
                throw new SedError(`can't find label for jump to \`${cmd.label}'`);
            }
        }
        return this;
    }
}

function caseConvert(text, mode) {
    if (mode === "U") return text.toUpperCase();
    if (mode === "L") return text.toLowerCase();
    return text;
}

function buildReplacement(chars, match) {
    let out = "";
    let mode = null; // persistent \U / \L
    let once = null; // one-shot \u / \l
    const emit = (text) => {
        if (text === "") return;
        let t = caseConvert(text, mode);
        if (once) {
            t = (once === "u" ? t[0].toUpperCase() : t[0].toLowerCase()) + t.slice(1);
            once = null;
        }
        out += t;
    };
    let i = 0;
    while (i < chars.length) {
        const c = chars[i];
        if (c === "&") { emit(match[0]); i++; continue; }
        if (c !== "\\" || i + 1 >= chars.length) { emit(c); i++; continue; }
        const next = chars[i + 1];
        if (/[0-9]/.test(next)) { emit(match[Number(next)] ?? ""); i += 2; continue; }
        if (next === "U" || next === "L") { mode = next; once = null; i += 2; continue; }
        if (next === "E") { mode = null; once = null; i += 2; continue; }
        if (next === "u" || next === "l") { once = next; i += 2; continue; }
        const decoded = decodeEscape(chars, i + 1);
        if (decoded) { emit(decoded[0]); i = decoded[1]; continue; }
        emit(next);
        i += 2;
    }
    return out;
}

function substitute(cmd, regex, input) {
    let out = "";
    let lastEnd = 0;
    let count = 0;
    let changed = false;
    regex.lastIndex = 0;
    let prevMatchEnd = -1; // end of the previous non-empty match
    let m;
    while ((m = regex.exec(input)) !== null) {
        const end = m.index + m[0].length;
        if (m[0] === "") regex.lastIndex += 1;
        // An empty match right after a non-empty one does not count.
        const counts = !(m[0] === "" && m.index === prevMatchEnd);
        if (counts) count += 1;
        if (m[0] !== "") prevMatchEnd = end;
        const wanted = cmd.occurrence ?? 1;
        if (counts && count >= wanted && (cmd.global || count === wanted)) {
            out += input.slice(lastEnd, m.index) + buildReplacement(cmd.replacement, m);
            lastEnd = end;
            changed = true;
            if (!cmd.global) break;
        }
        if (regex.lastIndex > input.length) break;
    }
    return [out + input.slice(lastEnd), changed];
}

// `l`: escapes non-printables, wraps at `width` (0 = never) with a trailing `\`, ends with `$`.
function unambiguous(text, width) {
    const names = { "\\": "\\\\", "\x07": "\\a", "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\v": "\\v" };
    let out = "";
    let col = 0;
    for (const ch of text) {
        const code = ch.charCodeAt(0);
        let piece = names[ch];
        if (piece === undefined) {
            piece = code < 0x20 || code === 0x7f ? `\\${code.toString(8).padStart(3, "0")}` : ch;
        }
        if (width > 1 && col + piece.length > width - 1) {
            out += "\\\n";
            col = 0;
        }
        out += piece;
        col += piece.length;
    }
    return `${out}$\n`;
}

class Output {
    constructor(sep) {
        this.sep = sep;
        this.text = "";
        this.missingNewline = false;
    }
    write(text) {
        if (text === "") return;
        if (this.missingNewline) { this.text += this.sep; this.missingNewline = false; }
        this.text += text;
    }
    // Pattern space of a final line that had no newline is printed without one.
    writeLine(text, newline) {
        this.write(text);
        if (newline) this.write(this.sep);
        else this.missingNewline = true;
    }
}

// Splits `content` into records, remembering whether the last one was terminated.
function splitRecords(content, sep) {
    if (content === "") return [];
    const parts = content.split(sep);
    const terminated = parts[parts.length - 1] === "";
    if (terminated) parts.pop();
    return parts.map((text, i) => ({ text, newline: terminated || i < parts.length - 1 }));
}

class Runner {
    constructor(parsed, opts, interp, writeOutputs) {
        this.prog = parsed.prog;
        this.labels = parsed.labels;
        this.quiet = opts.quiet;
        this.sep = opts.nullData ? "\0" : "\n";
        this.interp = interp;
        this.writeOutputs = writeOutputs;
        this.hold = "";
        this.lastRegex = null;
        this.exitCode = 0;
        this.quit = false;
        this.readFileLines = new Map();
    }

    regexFor(re) {
        if (re) { this.lastRegex = re; return re; }
        if (!this.lastRegex) throw new SedError("no previous regular expression");
        return this.lastRegex;
    }

    matchOne(addr) {
        switch (addr.kind) {
            case "line": return this.lineNo === addr.n;
            case "last": return this.isLast();
            case "step":
                return addr.step <= 0 ? this.lineNo === addr.first
                    : this.lineNo >= addr.first && (this.lineNo - addr.first) % addr.step === 0;
            case "regex": {
                const re = this.regexFor(addr.re);
                re.lastIndex = 0;
                return re.test(this.ps);
            }
        }
        return false;
    }

    matches(entry) {
        const { a1, a2, range } = entry;
        let raw;
        if (!a1) raw = true;
        else if (!a2) raw = this.matchOne(a1);
        else if (range.active) {
            if (a2.kind === "regex" || a2.kind === "last") {
                if (this.matchOne(a2)) range.active = false;
                raw = true;
            } else {
                raw = this.lineNo <= range.end;
                if (this.lineNo >= range.end) range.active = false;
            }
        } else if (a1.kind === "line" && a1.n === 0 ? this.lineNo === 1 && !range.used : this.matchOne(a1)) {
            range.used = true;
            raw = true;
            if (a1.kind === "line" && a1.n === 0) {
                range.active = !this.matchOne(a2);
            } else if (a2.kind === "line") {
                range.active = a2.n > this.lineNo;
                range.end = a2.n;
            } else if (a2.kind === "plus") {
                range.end = this.lineNo + a2.n;
                range.active = a2.n > 0;
            } else if (a2.kind === "multiple") {
                range.end = a2.n <= 0 ? this.lineNo : Math.ceil(this.lineNo / a2.n) * a2.n;
                range.active = range.end > this.lineNo;
            } else if (a2.kind === "last") {
                range.active = !this.isLast();
            } else {
                range.active = true;
            }
        } else {
            raw = false;
        }
        return entry.negate ? !raw : raw;
    }

    isLast() {
        return this.idx >= this.records.length && this.isLastStream;
    }

    readNext() {
        const rec = this.records[this.idx++];
        this.lineNo += 1;
        this.newline = rec.newline;
        return rec.text;
    }

    printPatternSpace(text = this.ps) {
        this.out.writeLine(text, this.newline);
    }

    endOfCycleOutput() {
        if (!this.quiet) this.printPatternSpace();
        this.flushAppends();
    }

    flushAppends() {
        for (const text of this.appends) this.out.write(text);
        this.appends = [];
    }

    readFileText(file) {
        if (file === "/dev/stdin") return this.stdin ?? "";
        const path = this.interp.resolvePath(file);
        return this.interp.vfs.isFile(path) ? this.interp.vfs.readFile(path) : null;
    }

    writeTo(file, text) {
        if (file === "/dev/stdout") this.out.write(text);
        else if (file === "/dev/stderr") this.stderr += text;
        else this.writeOutputs.set(file, (this.writeOutputs.get(file) ?? "") + text);
    }

    // Runs the script over one stream. `out` collects what the stream prints.
    run(records, out, { isLastStream = true, lineNo = 0, filename = "-" } = {}) {
        Object.assign(this, { records, out, isLastStream, lineNo, filename, idx: 0, appends: [], stderr: this.stderr ?? "" });
        while (!this.quit && this.idx < this.records.length) {
            this.ps = this.readNext();
            this.substituted = false;
            this.cycle();
        }
        return this.lineNo;
    }

    cycle() {
        let pc = 0;
        let steps = 0;
        let restartWithoutRead = false;
        do {
            restartWithoutRead = false;
            pc = 0;
            while (pc < this.prog.length) {
                if (++steps > MAX_CYCLE_STEPS) throw new SedError("script loops without consuming input");
                const entry = this.prog[pc];
                const cmd = entry.cmd;
                if (cmd.kind === "}" || cmd.kind === "noop") { pc++; continue; }
                if (!this.matches(entry)) {
                    pc = cmd.kind === "{" ? cmd.end + 1 : pc + 1;
                    continue;
                }
                const result = this.exec(entry, cmd);
                if (result === "end") break; // end of cycle with autoprint
                if (result === "delete") { this.flushAppends(); return; }
                if (result === "restart") {
                    this.flushAppends();
                    restartWithoutRead = true;
                    break;
                }
                if (result === "quit-silent") { this.quit = true; return; }
                if (typeof result === "number") { pc = result; continue; }
                pc++;
            }
        } while (restartWithoutRead && !this.quit);
        this.endOfCycleOutput();
    }

    jump(label) {
        return label === "" ? "end" : this.labels.get(label);
    }

    exec(entry, cmd) {
        switch (cmd.kind) {
            case "{": return undefined;
            case "=": this.out.write(`${this.lineNo}\n`); return undefined;
            case "a": this.appends.push(cmd.text); return undefined;
            case "i": this.out.write(cmd.text); return undefined;
            case "c":
                // A range prints its text once, when the range closes.
                if (entry.negate || !entry.a2 || !entry.range.active) this.out.write(cmd.text);
                return "delete";
            case "d": return "delete";
            case "D": {
                const nl = this.ps.indexOf("\n");
                if (nl === -1) return "delete";
                this.ps = this.ps.slice(nl + 1);
                return "restart";
            }
            case "p": this.printPatternSpace(); return undefined;
            case "P": {
                const nl = this.ps.indexOf("\n");
                this.out.writeLine(nl === -1 ? this.ps : this.ps.slice(0, nl), true);
                return undefined;
            }
            case "l": this.out.write(unambiguous(this.ps, cmd.n ?? 70)); return undefined;
            case "n":
                if (this.idx >= this.records.length) {
                    if (this.quiet) return "quit-silent";
                    this.quit = true;
                    return "end";
                }
                if (!this.quiet) this.printPatternSpace();
                this.flushAppends();
                this.ps = this.readNext();
                return undefined;
            case "N":
                if (this.idx >= this.records.length) {
                    this.quit = true;
                    return "end";
                }
                this.flushAppends();
                this.ps += `\n${this.readNext()}`;
                return undefined;
            case "g": this.ps = this.hold; return undefined;
            case "G": this.ps += `\n${this.hold}`; return undefined;
            case "h": this.hold = this.ps; return undefined;
            case "H": this.hold += `\n${this.ps}`; return undefined;
            case "x": [this.ps, this.hold] = [this.hold, this.ps]; return undefined;
            case "z": this.ps = ""; return undefined;
            case "F": this.out.write(`${this.filename}\n`); return undefined;
            case "b": return this.jump(cmd.label);
            case "t":
            case "T": {
                const taken = cmd.kind === "t" ? this.substituted : !this.substituted;
                this.substituted = false;
                return taken ? this.jump(cmd.label) : undefined;
            }
            case "q":
                this.exitCode = cmd.n ?? 0;
                this.quit = true;
                return "end";
            case "Q":
                this.exitCode = cmd.n ?? 0;
                return "quit-silent";
            case "r": {
                const text = this.readFileText(cmd.file);
                if (text) this.appends.push(text.endsWith("\n") ? text : `${text}\n`);
                return undefined;
            }
            case "R": {
                if (!this.readFileLines.has(cmd.file)) {
                    this.readFileLines.set(cmd.file, splitRecords(this.readFileText(cmd.file) ?? "", "\n"));
                }
                const line = this.readFileLines.get(cmd.file).shift();
                if (line) this.appends.push(`${line.text}\n`);
                return undefined;
            }
            case "w": this.writeTo(cmd.file, `${this.ps}\n`); return undefined;
            case "s": {
                const regex = this.regexFor(cmd.regex);
                const [text, changed] = substitute(cmd, regex, this.ps);
                if (changed) {
                    this.ps = text;
                    this.substituted = true;
                    for (let k = 0; k < cmd.print; k++) this.printPatternSpace();
                    if (cmd.wfile) this.writeTo(cmd.wfile, `${this.ps}\n`);
                }
                return undefined;
            }
            case "y":
                this.ps = [...this.ps].map((ch) => cmd.map.get(ch) ?? ch).join("");
                return undefined;
        }
        throw new SedError(`unhandled command ${cmd.kind}`);
    }
}

function parseArgs(args) {
    const opts = { quiet: false, extended: false, inPlace: null, separate: false, nullData: false };
    const scripts = []; // [kind, value]: "e" inline text, "f" script file
    const operands = [];
    let i = 1;
    const takeValue = (rest, flag) => {
        if (rest !== "") return rest;
        if (i + 1 >= args.length) throw new SedError(`option requires an argument -- '${flag}'`);
        return args[++i];
    };
    for (; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--") { operands.push(...args.slice(i + 1)); break; }
        if (arg.startsWith("--")) {
            const [name, value] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
            if (name === "--quiet" || name === "--silent") opts.quiet = true;
            else if (name === "--regexp-extended") opts.extended = true;
            else if (name === "--in-place") { opts.inPlace = value ?? ""; opts.separate = true; }
            else if (name === "--separate") opts.separate = true;
            else if (name === "--null-data" || name === "--zero-terminated") opts.nullData = true;
            else if (name === "--expression") scripts.push(["e", value ?? args[++i]]);
            else if (name === "--file") scripts.push(["f", value ?? args[++i]]);
            else if (["--posix", "--debug", "--unbuffered", "--sandbox", "--line-length"].includes(name)) { /* accepted, no effect */ }
            else throw new SedError(`unknown option -- '${arg}'`);
            continue;
        }
        if (!arg.startsWith("-") || arg === "-") { operands.push(arg); continue; }
        // Clustered short flags; e, f, i, l take the rest of the word.
        for (let j = 1; j < arg.length; j++) {
            const flag = arg[j];
            const rest = arg.slice(j + 1);
            if (flag === "n") opts.quiet = true;
            else if (flag === "E" || flag === "r") opts.extended = true;
            else if (flag === "s") opts.separate = true;
            else if (flag === "z") opts.nullData = true;
            else if (flag === "u") { /* unbuffered: no effect */ }
            else if (flag === "i") { opts.inPlace = rest; opts.separate = true; break; }
            else if (flag === "e") { scripts.push(["e", takeValue(rest, "e")]); break; }
            else if (flag === "f") { scripts.push(["f", takeValue(rest, "f")]); break; }
            else if (flag === "l") { takeValue(rest, "l"); break; }
            else throw new SedError(`invalid option -- '${flag}'`);
        }
    }
    if (scripts.length === 0) {
        if (operands.length === 0) throw new SedError("no script specified");
        scripts.push(["e", operands.shift()]);
    }
    return { opts, scripts, files: operands };
}

const USAGE = "Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...\n";

export function sedCommand(interp, args, stdin) {
    let parsed, opts, files;
    try {
        const parsedArgs = parseArgs(args);
        opts = parsedArgs.opts;
        files = parsedArgs.files;
        const texts = parsedArgs.scripts.map(([kind, value]) => {
            if (kind === "e") return value;
            if (value === "-") return stdin;
            const path = interp.resolvePath(value);
            if (!interp.vfs.isFile(path)) throw new SedError(`couldn't open file ${value}: No such file or directory`);
            return interp.vfs.readFile(path).replace(/\n$/, "");
        });
        parsed = new ScriptParser(texts.join("\n"), opts.extended).parse();
        if (parsed.quiet) opts.quiet = true;
    } catch (e) {
        if (e instanceof SedError) return fail(`sed: ${e.message}\n${e.message.startsWith("no script") ? USAGE : ""}`, 1);
        throw e;
    }

    const writeOutputs = new Map([...parsed.writeFiles].map((f) => [f, ""]));
    const runner = new Runner(parsed, opts, interp, writeOutputs);
    runner.stdin = stdin;
    let stderr = "";
    let exitCode = 0;
    const stdout = new Output(runner.sep);
    try {
        const inputs = [];
        for (const file of files.length ? files : ["-"]) {
            if (file === "-") { inputs.push({ file, content: stdin }); continue; }
            const path = interp.resolvePath(file);
            if (interp.vfs.isDir(path)) {
                stderr += `sed: couldn't edit ${file}: not a regular file\n`;
                exitCode = 2;
            } else if (!interp.vfs.isFile(path)) {
                stderr += `sed: can't read ${file}: No such file or directory\n`;
                exitCode = 2;
            } else {
                inputs.push({ file, path, content: interp.vfs.readFile(path) });
            }
        }
        if (opts.inPlace !== null) {
            for (const input of inputs) {
                if (runner.quit) break;
                if (!input.path) {
                    stderr += "sed: couldn't edit -: not a regular file\n";
                    exitCode = 4;
                    continue;
                }
                const out = new Output(runner.sep);
                runner.run(splitRecords(input.content, runner.sep), out, { filename: input.file });
                if (opts.inPlace !== "") {
                    const slash = input.path.lastIndexOf("/");
                    const dir = input.path.slice(0, slash + 1);
                    const base = input.path.slice(slash + 1);
                    const backup = opts.inPlace.includes("*") ? opts.inPlace.replaceAll("*", base) : base + opts.inPlace;
                    interp.vfs.writeFile(backup.includes("/") ? interp.resolvePath(backup) : dir + backup, input.content);
                }
                interp.vfs.writeFile(input.path, out.text);
            }
        } else if (opts.separate) {
            for (const input of inputs) {
                if (runner.quit) break;
                runner.run(splitRecords(input.content, runner.sep), stdout, { filename: input.file });
            }
        } else {
            // Without -s/-i all files form one stream: line numbers continue and `$` is the very last line.
            const records = inputs.flatMap((input, k) => {
                const recs = splitRecords(input.content, runner.sep);
                if (k < inputs.length - 1 && recs.length) recs[recs.length - 1].newline = true;
                return recs;
            });
            runner.run(records, stdout, { filename: inputs.length === 1 ? inputs[0].file : "-" });
        }
    } catch (e) {
        if (e instanceof SedError) return fail(`${stdout.text}sed: ${e.message}\n`, 4);
        throw e;
    }
    for (const [file, text] of writeOutputs) {
        if (file !== "/dev/stdout" && file !== "/dev/stderr") interp.vfs.writeFile(interp.resolvePath(file), text);
    }
    if (runner.exitCode !== 0) exitCode = runner.exitCode;
    return { stdout: stdout.text, stderr: stderr + (runner.stderr ?? ""), exitCode };
}
