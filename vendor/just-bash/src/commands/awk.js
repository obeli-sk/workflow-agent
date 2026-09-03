// PORT (partial): vendor/just-bash-rs/src/commands/awk.rs
//
// A practical subset of awk, matching the scope the Rust port itself already
// deliberately chose (see that file's own top-of-file doc comment): a
// from-scratch hand-rolled lexer + recursive-descent parser + tree-walking
// interpreter, not upstream awk fidelity and not a line-by-line port.
//
// Supported: BEGIN{...}/END{...}, pattern-action pairs, bare pattern
// (implicit {print}), bare {action} (implicit always-true pattern), /regex/
// patterns (matched against $0), general expression patterns (comparisons on
// fields/vars, NR/NF), range patterns (pat1,pat2 — on, including a numeric
// 0 end-pattern for "to EOF"); fields $0..$NF (read and assign, including
// extending past NF and truncating via NF=), FS (single-char literal or
// multi-char ERE) / -F; print/printf, assignment incl. compound (+= -= *= /=
// %= ^=), ++/-- (pre/post), arithmetic + - * / % ^ **, string concatenation
// (juxtaposition), comparisons (POSIX numeric-string rules), ~/!~, &&/||/!,
// ternary ?:, if/else, while, do/while, classic for(;;),
// break/continue/next/exit [code]; builtins length substr index split sub
// gsub gensub match toupper tolower sprintf sin cos atan2 exp log sqrt int
// rand srand; built-in vars NR NF FS OFS ORS RS FILENAME FNR RSTART RLENGTH;
// minimal single-dimension arrays (arr[key], only so split() and hand-rolled
// counters are useful); CLI flags -F/-v/--help.
//
// Explicitly out of scope (skipped, not started, matching the Rust port):
// user-defined functions (function name(...) {...}), getline, nextfile,
// `for (k in arr)` / `delete arr[k]` / `(a, b) in arr` / SUBSEP multi-dim
// keys / the `in` operator, regex RS/multi-char RS, output redirection
// (print > "file", | cmd), -f progfile, and execution/allocation limits.
//
// Regex flavor: awk regex is ERE, and JS RegExp is already ERE/PCRE-ish, so
// (unlike sed/grep's BRE mode) there is no translateBre step here — only
// expandPosixBracketClasses, since JS RegExp has no native [:class:] support
// (mirrors how awk.rs hands the pattern straight to the `regex` crate, which
// *does* support POSIX classes internally; we only need to bridge that gap).

import { ok, fail } from "./core.js";
import { expandPosixBracketClasses } from "../regex-bre.js";

export class AwkError extends Error {}

// ============================================================================
// Lexer
// ============================================================================

const KEYWORDS = new Set([
    "BEGIN", "END", "if", "else", "while", "do", "for", "break", "continue",
    "next", "exit", "print", "printf", "return", "in",
]);
function isKeyword(s) {
    return KEYWORDS.has(s);
}

const PUNCTS_2 = ["**", "==", "!=", "<=", ">=", "&&", "||", "!~", "++", "--", "+=", "-=", "*=", "/=", "%=", "^="];
const PUNCTS_1 = ["{", "}", "(", ")", "[", "]", ";", ",", "$", "=", "<", ">", "!", "~", "+", "-", "*", "/", "%", "^", "?", ":"];

function isDigit(c) {
    return c !== undefined && c >= "0" && c <= "9";
}

function decodeEscape(chars, pos) {
    const c = chars[pos];
    if (c === undefined) return ["\\", pos];
    switch (c) {
        case "n": return ["\n", pos + 1];
        case "t": return ["\t", pos + 1];
        case "r": return ["\r", pos + 1];
        case "\\": return ["\\", pos + 1];
        case '"': return ['"', pos + 1];
        case "/": return ["/", pos + 1];
        case "a": return ["\x07", pos + 1];
        case "b": return ["\x08", pos + 1];
        case "f": return ["\x0c", pos + 1];
        case "v": return ["\x0b", pos + 1];
        case "x": {
            let j = pos + 1;
            let hex = "";
            while (j < chars.length && hex.length < 2 && /[0-9A-Fa-f]/.test(chars[j])) {
                hex += chars[j];
                j += 1;
            }
            if (hex === "") return ["x", pos + 1];
            return [String.fromCharCode(parseInt(hex, 16)), j];
        }
        default:
            if (c >= "0" && c <= "7") {
                let j = pos;
                let oct = "";
                while (j < chars.length && oct.length < 3 && chars[j] >= "0" && chars[j] <= "7") {
                    oct += chars[j];
                    j += 1;
                }
                return [String.fromCharCode(parseInt(oct, 8)), j];
            }
            return [c, pos + 1];
    }
}

// Tokens: {k:"num",v}, {k:"str",v}, {k:"regex",v}, {k:"ident",v}, {k:"punct",v}, {k:"nl"}
function lex(src) {
    const chars = [...src];
    let i = 0;
    const toks = [];
    let parenDepth = 0;

    const regexAllowed = () => {
        const last = toks[toks.length - 1];
        if (!last) return true;
        if (last.k === "ident") return isKeyword(last.v);
        if (last.k === "num" || last.k === "str" || last.k === "regex") return false;
        if (last.k === "punct" && (last.v === ")" || last.v === "]")) return false;
        return true;
    };

    while (i < chars.length) {
        const c = chars[i];
        if (c === "\\" && chars[i + 1] === "\n") {
            i += 2;
            continue;
        }
        if (c === "#") {
            while (i < chars.length && chars[i] !== "\n") i += 1;
            continue;
        }
        if (c === "\n") {
            i += 1;
            const last = toks[toks.length - 1];
            const skip = parenDepth > 0
                || (!!last && last.k === "punct" && (last.v === "," || last.v === "{" || last.v === "&&" || last.v === "||"))
                || (!!last && last.k === "ident" && (last.v === "do" || last.v === "else"));
            if (!skip) toks.push({ k: "nl" });
            continue;
        }
        if (/\s/.test(c)) {
            i += 1;
            continue;
        }
        if (c === '"') {
            i += 1;
            let s = "";
            while (i < chars.length && chars[i] !== '"') {
                if (chars[i] === "\\" && i + 1 < chars.length) {
                    const [ch, next] = decodeEscape(chars, i + 1);
                    s += ch;
                    i = next;
                } else {
                    s += chars[i];
                    i += 1;
                }
            }
            i += 1; // closing quote
            toks.push({ k: "str", v: s });
            continue;
        }
        if (c === "/" && regexAllowed()) {
            i += 1;
            let pat = "";
            let inClass = false;
            while (i < chars.length && (chars[i] !== "/" || inClass)) {
                if (chars[i] === "\\" && i + 1 < chars.length) {
                    pat += chars[i] + chars[i + 1];
                    i += 2;
                    continue;
                }
                if (chars[i] === "[") inClass = true;
                else if (chars[i] === "]") inClass = false;
                pat += chars[i];
                i += 1;
            }
            i += 1; // closing slash
            toks.push({ k: "regex", v: pat });
            continue;
        }
        if (isDigit(c) || (c === "." && isDigit(chars[i + 1]))) {
            const start = i;
            while (i < chars.length && isDigit(chars[i])) i += 1;
            if (chars[i] === ".") {
                i += 1;
                while (i < chars.length && isDigit(chars[i])) i += 1;
            }
            if (chars[i] === "e" || chars[i] === "E") {
                const save = i;
                i += 1;
                if (chars[i] === "+" || chars[i] === "-") i += 1;
                if (isDigit(chars[i])) {
                    while (i < chars.length && isDigit(chars[i])) i += 1;
                } else {
                    i = save;
                }
            }
            const text = chars.slice(start, i).join("");
            const n = Number(text);
            if (Number.isNaN(n)) throw new AwkError(`invalid number '${text}'`);
            toks.push({ k: "num", v: n });
            continue;
        }
        if (/[A-Za-z_]/.test(c)) {
            const start = i;
            while (i < chars.length && /[A-Za-z0-9_]/.test(chars[i])) i += 1;
            toks.push({ k: "ident", v: chars.slice(start, i).join("") });
            continue;
        }
        if (chars.slice(i, i + 3).join("") === "**=") {
            toks.push({ k: "punct", v: "**=" });
            i += 3;
            continue;
        }
        const two = chars.slice(i, i + 2).join("");
        if (PUNCTS_2.includes(two)) {
            toks.push({ k: "punct", v: two });
            i += 2;
            continue;
        }
        if (PUNCTS_1.includes(c)) {
            if (c === "(" || c === "[") parenDepth += 1;
            else if (c === ")" || c === "]") parenDepth -= 1;
            toks.push({ k: "punct", v: c });
            i += 1;
            continue;
        }
        throw new AwkError(`unexpected character '${c}' in awk program`);
    }
    return toks;
}

// ============================================================================
// Parser (AST: plain objects tagged with `kind`)
// ============================================================================

function isLvalue(e) {
    return e.kind === "var" || e.kind === "field" || e.kind === "arrayIndex";
}

const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "^="]);
const REL_OPS = new Set(["==", "!=", "<=", ">=", "<", ">"]);

class Parser {
    constructor(toks) {
        this.toks = toks;
        this.pos = 0;
    }

    peek() {
        return this.toks[this.pos];
    }
    peekPunct(p) {
        const t = this.peek();
        return !!t && t.k === "punct" && t.v === p;
    }
    peekIdent(name) {
        const t = this.peek();
        return !!t && t.k === "ident" && t.v === name;
    }
    advance() {
        const t = this.toks[this.pos];
        this.pos += 1;
        return t;
    }
    eatPunct(p) {
        if (this.peekPunct(p)) {
            this.pos += 1;
            return true;
        }
        return false;
    }
    eatIdent(name) {
        if (this.peekIdent(name)) {
            this.pos += 1;
            return true;
        }
        return false;
    }
    expectPunct(p) {
        if (!this.eatPunct(p)) throw new AwkError(`expected '${p}'`);
    }
    skipTerms() {
        while (this.peek() && (this.peek().k === "nl" || this.peekPunct(";"))) this.pos += 1;
    }
    // Some statement forms (if/while/for headers) may be followed by a
    // newline before the body; skip it without consuming a real statement
    // terminator the enclosing block relies on.
    skipTermsOptBeforeStmt() {
        while (this.peek() && this.peek().k === "nl") this.pos += 1;
    }
    stmtEnds() {
        const t = this.peek();
        return !t || t.k === "nl" || (t.k === "punct" && (t.v === ";" || t.v === "}"));
    }

    // ---- program ----

    parseProgram() {
        const rules = [];
        this.skipTerms();
        while (this.peek()) {
            rules.push(this.parseRule());
            this.skipTerms();
        }
        return rules;
    }

    parseRule() {
        if (this.eatIdent("BEGIN")) return { pattern: { kind: "begin" }, action: this.parseBlock() };
        if (this.eatIdent("END")) return { pattern: { kind: "end" }, action: this.parseBlock() };
        let pattern;
        if (this.peekPunct("{")) {
            pattern = { kind: "always" };
        } else {
            const first = this.parseExpr();
            // A comma between two patterns turns them into a range: the rule
            // matches every record from one where `first` matches through
            // (inclusive) the next one where `second` matches, re-arming once
            // closed. `active` is mutated at runtime (see matchRangePattern),
            // so each occurrence of the pattern in the program needs its own
            // object even if the same rule is never re-parsed.
            pattern = this.eatPunct(",")
                ? { kind: "range", start: first, end: this.parseExpr(), active: false }
                : { kind: "expr", expr: first };
        }
        const action = this.peekPunct("{") ? this.parseBlock() : null;
        return { pattern, action };
    }

    parseBlock() {
        this.expectPunct("{");
        const stmts = [];
        this.skipTerms();
        while (!this.peekPunct("}")) {
            stmts.push(this.parseStmt());
            this.skipTerms();
        }
        this.expectPunct("}");
        return { kind: "block", stmts };
    }

    parseStmt() {
        if (this.peekPunct("{")) return this.parseBlock();
        if (this.peekPunct(";")) return { kind: "block", stmts: [] };
        if (this.eatIdent("if")) {
            this.expectPunct("(");
            const cond = this.parseExpr();
            this.expectPunct(")");
            this.skipTermsOptBeforeStmt();
            const thenB = this.parseStmt();
            const save = this.pos;
            this.skipTerms();
            if (this.eatIdent("else")) {
                this.skipTermsOptBeforeStmt();
                const elseB = this.parseStmt();
                return { kind: "if", cond, then: thenB, else: elseB };
            }
            this.pos = save;
            return { kind: "if", cond, then: thenB, else: null };
        }
        if (this.eatIdent("while")) {
            this.expectPunct("(");
            const cond = this.parseExpr();
            this.expectPunct(")");
            this.skipTermsOptBeforeStmt();
            const body = this.parseStmt();
            return { kind: "while", cond, body };
        }
        if (this.eatIdent("do")) {
            this.skipTermsOptBeforeStmt();
            const body = this.parseStmt();
            this.skipTerms();
            if (!this.eatIdent("while")) throw new AwkError("expected 'while' after 'do' body");
            this.expectPunct("(");
            const cond = this.parseExpr();
            this.expectPunct(")");
            return { kind: "doWhile", body, cond };
        }
        if (this.eatIdent("for")) {
            this.expectPunct("(");
            const init = this.peekPunct(";") ? null : { kind: "expr", expr: this.parseExpr() };
            this.expectPunct(";");
            const cond = this.peekPunct(";") ? null : this.parseExpr();
            this.expectPunct(";");
            const incr = this.peekPunct(")") ? null : { kind: "expr", expr: this.parseExpr() };
            this.expectPunct(")");
            this.skipTermsOptBeforeStmt();
            const body = this.parseStmt();
            return { kind: "for", init, cond, incr, body };
        }
        if (this.eatIdent("break")) return { kind: "break" };
        if (this.eatIdent("continue")) return { kind: "continue" };
        if (this.eatIdent("next")) return { kind: "next" };
        if (this.eatIdent("exit")) {
            const arg = this.stmtEnds() ? null : this.parseExpr();
            return { kind: "exit", arg };
        }
        if (this.eatIdent("print")) return { kind: "print", args: this.parsePrintArgs() };
        if (this.eatIdent("printf")) return { kind: "printf", args: this.parsePrintArgs() };
        return { kind: "expr", expr: this.parseExpr() };
    }

    parsePrintArgs() {
        const args = [];
        if (this.stmtEnds()) return args;
        for (;;) {
            args.push(this.parseTernary());
            if (this.eatPunct(",")) continue;
            break;
        }
        return args;
    }

    // ---- expressions ----

    parseExpr() {
        return this.parseAssign();
    }

    parseAssign() {
        const left = this.parseTernary();
        const t = this.peek();
        const op = t && t.k === "punct" && ASSIGN_OPS.has(t.v) ? t.v : null;
        if (op) {
            if (!isLvalue(left)) throw new AwkError("invalid assignment target");
            this.pos += 1;
            const right = this.parseAssign();
            return op === "="
                ? { kind: "assign", target: left, value: right }
                : { kind: "compoundAssign", op, target: left, value: right };
        }
        return left;
    }

    parseTernary() {
        const cond = this.parseOr();
        if (this.eatPunct("?")) {
            const thenE = this.parseTernary();
            this.expectPunct(":");
            const elseE = this.parseTernary();
            return { kind: "ternary", cond, then: thenE, else: elseE };
        }
        return cond;
    }

    parseOr() {
        let left = this.parseAnd();
        while (this.eatPunct("||")) {
            this.skipTermsOptBeforeStmt();
            left = { kind: "or", left, right: this.parseAnd() };
        }
        return left;
    }

    parseAnd() {
        let left = this.parseMatch();
        while (this.eatPunct("&&")) {
            this.skipTermsOptBeforeStmt();
            left = { kind: "and", left, right: this.parseMatch() };
        }
        return left;
    }

    parseMatch() {
        let left = this.parseRel();
        for (;;) {
            if (this.eatPunct("~")) left = { kind: "match", negate: false, left, right: this.parseRel() };
            else if (this.eatPunct("!~")) left = { kind: "match", negate: true, left, right: this.parseRel() };
            else break;
        }
        return left;
    }

    parseRel() {
        const left = this.parseConcat();
        const t = this.peek();
        if (t && t.k === "punct" && REL_OPS.has(t.v)) {
            this.pos += 1;
            return { kind: "compare", op: t.v, left, right: this.parseConcat() };
        }
        return left;
    }

    startsConcatTerm() {
        const t = this.peek();
        if (!t) return false;
        if (t.k === "num" || t.k === "str" || t.k === "regex") return true;
        if (t.k === "punct" && (t.v === "$" || t.v === "(" || t.v === "!" || t.v === "++" || t.v === "--")) return true;
        if (t.k === "ident" && !isKeyword(t.v)) return true;
        return false;
    }

    parseConcat() {
        let left = this.parseAdd();
        while (this.startsConcatTerm()) {
            left = { kind: "concat", left, right: this.parseAdd() };
        }
        return left;
    }

    parseAdd() {
        let left = this.parseMul();
        for (;;) {
            const t = this.peek();
            if (!(t && t.k === "punct" && (t.v === "+" || t.v === "-"))) break;
            this.pos += 1;
            left = { kind: "binary", op: t.v, left, right: this.parseMul() };
        }
        return left;
    }

    parseMul() {
        let left = this.parseUnary();
        for (;;) {
            const t = this.peek();
            if (!(t && t.k === "punct" && (t.v === "*" || t.v === "/" || t.v === "%"))) break;
            this.pos += 1;
            left = { kind: "binary", op: t.v, left, right: this.parseUnary() };
        }
        return left;
    }

    parseUnary() {
        if (this.eatPunct("!")) return { kind: "not", expr: this.parseUnary() };
        if (this.eatPunct("-")) return { kind: "neg", expr: this.parseUnary() };
        if (this.eatPunct("+")) return { kind: "pos", expr: this.parseUnary() };
        if (this.eatPunct("++")) return { kind: "preIncr", target: this.parseUnary() };
        if (this.eatPunct("--")) return { kind: "preDecr", target: this.parseUnary() };
        return this.parsePow();
    }

    parsePow() {
        const left = this.parsePostfix();
        if (this.eatPunct("^") || this.eatPunct("**")) {
            return { kind: "binary", op: "^", left, right: this.parseUnary() };
        }
        return left;
    }

    parsePostfix() {
        let base = this.parsePrimary();
        for (;;) {
            if (isLvalue(base) && this.eatPunct("++")) base = { kind: "postIncr", target: base };
            else if (isLvalue(base) && this.eatPunct("--")) base = { kind: "postDecr", target: base };
            else break;
        }
        return base;
    }

    parsePrimary() {
        const t = this.advance();
        if (!t) throw new AwkError("unexpected end of program in expression");
        if (t.k === "num") return { kind: "num", value: t.v };
        if (t.k === "str") return { kind: "str", value: t.v };
        if (t.k === "regex") return { kind: "regex", pat: t.v };
        if (t.k === "punct" && t.v === "$") return { kind: "field", idx: this.parseDollarOperand() };
        if (t.k === "punct" && t.v === "(") {
            const inner = this.parseExpr();
            this.expectPunct(")");
            return { kind: "group", expr: inner };
        }
        if (t.k === "ident") {
            const name = t.v;
            // getline and user-defined functions are out of scope (see the
            // skip list in the module docs). They are not lexed as
            // keywords, so without this guard `getline var < file` silently
            // mis-parses as a comparison and a `function name` definition
            // parses as a rule calling an undefined function. Reject both
            // loudly instead.
            if (name === "getline") throw new AwkError("getline is not supported");
            if (name === "function") throw new AwkError("user-defined functions are not supported");
            if (this.peekPunct("(")) {
                this.pos += 1;
                const args = [];
                if (!this.peekPunct(")")) {
                    for (;;) {
                        args.push(this.parseTernary());
                        if (this.eatPunct(",")) continue;
                        break;
                    }
                }
                this.expectPunct(")");
                return { kind: "call", name, args };
            }
            if (name === "length") return { kind: "call", name, args: [] };
            if (this.eatPunct("[")) {
                const idx = this.parseExpr();
                this.expectPunct("]");
                return { kind: "arrayIndex", name, idx };
            }
            return { kind: "var", name };
        }
        throw new AwkError(`unexpected token in expression`);
    }

    // The operand of `$` binds tightly: a bare number/ident, or a
    // parenthesized expression, not a full unary/binary expression.
    parseDollarOperand() {
        const t = this.peek();
        if (t && t.k === "punct" && t.v === "$") {
            this.pos += 1;
            return { kind: "field", idx: this.parseDollarOperand() };
        }
        if (t && t.k === "punct" && t.v === "(") {
            this.pos += 1;
            const inner = this.parseExpr();
            this.expectPunct(")");
            return inner;
        }
        if (t && t.k === "punct" && t.v === "-") {
            this.pos += 1;
            return { kind: "neg", expr: this.parseDollarOperand() };
        }
        if (t && t.k === "punct" && t.v === "++") {
            this.pos += 1;
            return { kind: "preIncr", target: this.parseDollarOperand() };
        }
        if (t && (t.k === "num" || t.k === "ident")) return this.parsePrimary();
        throw new AwkError("unexpected token after '$'");
    }
}

function parseProgram(src) {
    const toks = lex(src);
    return new Parser(toks).parseProgram();
}

// ============================================================================
// Runtime value: Num | Str | StrNum (POSIX numeric-string comparison rules)
// ============================================================================

function vNum(n) {
    return { t: "num", n };
}
function vStr(s) {
    return { t: "str", s };
}
function vStrNum(s) {
    return { t: "strnum", s };
}
const UNINIT = vStrNum("");

function looksNumeric(s) {
    const t = s.trim();
    if (t.length === 0) return false;
    let i = 0;
    if (t[i] === "+" || t[i] === "-") i += 1;
    const startDigits = i;
    while (i < t.length && isDigit(t[i])) i += 1;
    let hasDigits = i > startDigits;
    if (i < t.length && t[i] === ".") {
        i += 1;
        const start2 = i;
        while (i < t.length && isDigit(t[i])) i += 1;
        hasDigits = hasDigits || i > start2;
    }
    if (!hasDigits) return false;
    if (i < t.length && (t[i] === "e" || t[i] === "E")) {
        let j = i + 1;
        if (j < t.length && (t[j] === "+" || t[j] === "-")) j += 1;
        const start3 = j;
        while (j < t.length && isDigit(t[j])) j += 1;
        if (j > start3) i = j;
    }
    return i === t.length;
}

function parseLeadingNumber(s) {
    const t = s.replace(/^\s+/, "");
    let i = 0;
    if (i < t.length && (t[i] === "+" || t[i] === "-")) i += 1;
    const startDigits = i;
    while (i < t.length && isDigit(t[i])) i += 1;
    let hasDigits = i > startDigits;
    if (i < t.length && t[i] === ".") {
        i += 1;
        const start2 = i;
        while (i < t.length && isDigit(t[i])) i += 1;
        hasDigits = hasDigits || i > start2;
    }
    if (!hasDigits) return 0;
    let end = i;
    if (i < t.length && (t[i] === "e" || t[i] === "E")) {
        let j = i + 1;
        if (j < t.length && (t[j] === "+" || t[j] === "-")) j += 1;
        const start3 = j;
        while (j < t.length && isDigit(t[j])) j += 1;
        if (j > start3) end = j;
    }
    const num = parseFloat(t.slice(0, end));
    return Number.isNaN(num) ? 0 : num;
}

// Not exactly POSIX's default %.6g (OFMT) — a reasonable, simpler
// approximation, matching the Rust port's own stated compromise.
function formatAwkNumber(f) {
    if (Number.isNaN(f)) return "nan";
    if (!Number.isFinite(f)) return f > 0 ? "inf" : "-inf";
    if (f === Math.trunc(f) && Math.abs(f) < 1e16) return String(Math.trunc(f));
    return String(f);
}

function valueToNum(v) {
    return v.t === "num" ? v.n : parseLeadingNumber(v.s);
}
function valueToStr(v) {
    return v.t === "num" ? formatAwkNumber(v.n) : v.s;
}
function valueIsNumeric(v) {
    if (v.t === "num") return true;
    if (v.t === "strnum") return looksNumeric(v.s);
    return false;
}
function valueTruthy(v) {
    if (v.t === "num") return v.n !== 0;
    if (v.t === "strnum") return looksNumeric(v.s) ? parseLeadingNumber(v.s) !== 0 : v.s !== "";
    return v.s !== "";
}

function compareOp(op, a, b) {
    if (valueIsNumeric(a) && valueIsNumeric(b)) {
        const x = valueToNum(a);
        const y = valueToNum(b);
        switch (op) {
            case "==": return x === y;
            case "!=": return x !== y;
            case "<": return x < y;
            case "<=": return x <= y;
            case ">": return x > y;
            case ">=": return x >= y;
        }
    }
    const x = valueToStr(a);
    const y = valueToStr(b);
    switch (op) {
        case "==": return x === y;
        case "!=": return x !== y;
        case "<": return x < y;
        case "<=": return x <= y;
        case ">": return x > y;
        case ">=": return x >= y;
    }
    return false;
}

function applyNumericOp(op, l, r) {
    switch (op) {
        case "+": return l + r;
        case "-": return l - r;
        case "*": return l * r;
        case "/": return l / r;
        case "%": return l % r;
        case "^": return l ** r;
        default: throw new AwkError(`unknown operator ${op}`);
    }
}

// ============================================================================
// Interpreter state
// ============================================================================

const RNG_MASK = (1n << 64n) - 1n;

function resizeArray(arr, n) {
    if (arr.length > n) arr.length = n;
    else while (arr.length < n) arr.push("");
}

class Ctx {
    constructor() {
        this.vars = new Map();
        this.arrays = new Map();
        this.fields = [];
        this.record = "";
        this.fs = " ";
        this.ofs = " ";
        this.ors = "\n";
        this.nr = 0;
        this.fnr = 0;
        this.filename = "";
        this.rstart = 0;
        this.rlength = -1;
        this.rng = 0x2545_f491_4f6c_dd1dn;
        this.stdout = "";
        this.exitCode = null;
    }

    // xorshift64*: deterministic, good enough for awk's rand()/srand().
    nextRand() {
        let x = this.rng;
        x = (x ^ (x << 13n)) & RNG_MASK;
        x = (x ^ (x >> 7n)) & RNG_MASK;
        x = (x ^ (x << 17n)) & RNG_MASK;
        this.rng = x;
        return Number(x >> 11n) / Number(1n << 53n);
    }

    setRecord(record) {
        this.record = record;
        this.fields = splitRecord(this.record, this.fs);
    }

    rebuildRecord() {
        this.record = this.fields.join(this.ofs);
    }

    getField(n) {
        if (n === 0) return vStrNum(this.record);
        if (n >= 1 && n <= this.fields.length) return vStrNum(this.fields[n - 1]);
        return vStrNum("");
    }

    setField(n, value) {
        if (n < 0) throw new AwkError("field index must not be negative");
        if (n === 0) {
            this.setRecord(valueToStr(value));
            return;
        }
        if (n > this.fields.length) resizeArray(this.fields, n);
        this.fields[n - 1] = valueToStr(value);
        this.rebuildRecord();
    }

    setNF(n) {
        resizeArray(this.fields, Math.max(n, 0));
        this.rebuildRecord();
    }

    getVar(name) {
        switch (name) {
            case "NR": return vNum(this.nr);
            case "NF": return vNum(this.fields.length);
            case "FNR": return vNum(this.fnr);
            case "FS": return vStr(this.fs);
            case "OFS": return vStr(this.ofs);
            case "ORS": return vStr(this.ors);
            case "FILENAME": return vStr(this.filename);
            case "RSTART": return vNum(this.rstart);
            case "RLENGTH": return vNum(this.rlength);
            default: return this.vars.get(name) ?? UNINIT;
        }
    }

    setVar(name, value) {
        switch (name) {
            case "NF": this.setNF(Math.trunc(valueToNum(value))); break;
            case "FS": this.fs = valueToStr(value); break;
            case "OFS": this.ofs = valueToStr(value); break;
            case "ORS": this.ors = valueToStr(value); break;
            case "FILENAME": this.filename = valueToStr(value); break;
            case "RSTART": this.rstart = Math.trunc(valueToNum(value)); break;
            case "RLENGTH": this.rlength = Math.trunc(valueToNum(value)); break;
            case "NR": this.nr = Math.trunc(valueToNum(value)); break;
            case "FNR": this.fnr = Math.trunc(valueToNum(value)); break;
            default: this.vars.set(name, value);
        }
    }
}

// Splits a record into fields per `fs`: default (single space) means "split
// on runs of whitespace, trim ends"; a single non-space char is a literal
// separator; anything longer is an ERE (regex field-separator support).
function splitRecord(record, fs) {
    if (record === "") return [];
    if (fs === " ") {
        const trimmed = record.trim();
        return trimmed === "" ? [] : trimmed.split(/\s+/);
    }
    const fsChars = [...fs];
    if (fsChars.length === 1) return record.split(fsChars[0]);
    try {
        return record.split(new RegExp(expandPosixBracketClasses(fs)));
    } catch {
        return [record];
    }
}

// ============================================================================
// Expression evaluation
// ============================================================================

function compileRegex(pat) {
    try {
        return new RegExp(expandPosixBracketClasses(pat), "g");
    } catch (e) {
        throw new AwkError(`invalid regex /${pat}/: ${e.message}`);
    }
}

// `~`/`!~`/`match()`'s right operand may be a bare regex literal (which
// would otherwise evaluate to a 0/1 match against $0) or a string/expr.
function regexOperandText(ctx, expr) {
    if (expr.kind === "regex") return expr.pat;
    if (expr.kind === "group") return regexOperandText(ctx, expr.expr);
    return valueToStr(evalExpr(ctx, expr));
}

function evalExpr(ctx, expr) {
    switch (expr.kind) {
        case "num": return vNum(expr.value);
        case "str": return vStr(expr.value);
        case "regex": {
            const re = compileRegex(expr.pat);
            re.lastIndex = 0;
            return vNum(re.test(ctx.record) ? 1 : 0);
        }
        case "var": return ctx.getVar(expr.name);
        case "arrayIndex": {
            const key = valueToStr(evalExpr(ctx, expr.idx));
            return ctx.arrays.get(expr.name)?.get(key) ?? UNINIT;
        }
        case "field": {
            const n = Math.trunc(valueToNum(evalExpr(ctx, expr.idx)));
            return ctx.getField(n);
        }
        case "group": return evalExpr(ctx, expr.expr);
        case "assign": {
            const v = evalExpr(ctx, expr.value);
            assign(ctx, expr.target, v);
            return v;
        }
        case "compoundAssign": {
            const cur = valueToNum(evalExpr(ctx, expr.target));
            const rhs = valueToNum(evalExpr(ctx, expr.value));
            const v = vNum(applyNumericOp(expr.op[0], cur, rhs));
            assign(ctx, expr.target, v);
            return v;
        }
        case "preIncr": {
            const v = vNum(valueToNum(evalExpr(ctx, expr.target)) + 1);
            assign(ctx, expr.target, v);
            return v;
        }
        case "preDecr": {
            const v = vNum(valueToNum(evalExpr(ctx, expr.target)) - 1);
            assign(ctx, expr.target, v);
            return v;
        }
        case "postIncr": {
            const old = valueToNum(evalExpr(ctx, expr.target));
            assign(ctx, expr.target, vNum(old + 1));
            return vNum(old);
        }
        case "postDecr": {
            const old = valueToNum(evalExpr(ctx, expr.target));
            assign(ctx, expr.target, vNum(old - 1));
            return vNum(old);
        }
        case "binary": {
            const lv = valueToNum(evalExpr(ctx, expr.left));
            const rv = valueToNum(evalExpr(ctx, expr.right));
            return vNum(applyNumericOp(expr.op, lv, rv));
        }
        case "concat": {
            const lv = valueToStr(evalExpr(ctx, expr.left));
            const rv = valueToStr(evalExpr(ctx, expr.right));
            return vStr(lv + rv);
        }
        case "compare": {
            const lv = evalExpr(ctx, expr.left);
            const rv = evalExpr(ctx, expr.right);
            return vNum(compareOp(expr.op, lv, rv) ? 1 : 0);
        }
        case "and": {
            if (!valueTruthy(evalExpr(ctx, expr.left))) return vNum(0);
            return vNum(valueTruthy(evalExpr(ctx, expr.right)) ? 1 : 0);
        }
        case "or": {
            if (valueTruthy(evalExpr(ctx, expr.left))) return vNum(1);
            return vNum(valueTruthy(evalExpr(ctx, expr.right)) ? 1 : 0);
        }
        case "not": return vNum(valueTruthy(evalExpr(ctx, expr.expr)) ? 0 : 1);
        case "neg": return vNum(-valueToNum(evalExpr(ctx, expr.expr)));
        case "pos": return vNum(valueToNum(evalExpr(ctx, expr.expr)));
        case "match": {
            const text = valueToStr(evalExpr(ctx, expr.left));
            const pat = regexOperandText(ctx, expr.right);
            const re = compileRegex(pat);
            re.lastIndex = 0;
            const m = re.test(text);
            return vNum(m !== expr.negate ? 1 : 0);
        }
        case "ternary":
            return valueTruthy(evalExpr(ctx, expr.cond)) ? evalExpr(ctx, expr.then) : evalExpr(ctx, expr.else);
        case "call": return evalCall(ctx, expr.name, expr.args);
        default: throw new AwkError(`unhandled expression kind ${expr.kind}`);
    }
}

// Range pattern (pat1,pat2): matches every record from one where `start`
// matches through the next one (inclusive) where `end` matches, then
// re-arms. `pattern.active` is the one piece of state a range pattern
// carries between records, mutated in place on the parsed pattern object
// (one per occurrence in the program, matching how real awk scopes it).
function matchRangePattern(ctx, pattern) {
    if (!pattern.active) {
        if (!valueTruthy(evalExpr(ctx, pattern.start))) return false;
        pattern.active = true;
        if (valueTruthy(evalExpr(ctx, pattern.end))) pattern.active = false;
        return true;
    }
    if (valueTruthy(evalExpr(ctx, pattern.end))) pattern.active = false;
    return true;
}

function assign(ctx, target, value) {
    switch (target.kind) {
        case "var": ctx.setVar(target.name, value); return;
        case "field": {
            const n = Math.trunc(valueToNum(evalExpr(ctx, target.idx)));
            ctx.setField(n, value);
            return;
        }
        case "arrayIndex": {
            const key = valueToStr(evalExpr(ctx, target.idx));
            if (!ctx.arrays.has(target.name)) ctx.arrays.set(target.name, new Map());
            ctx.arrays.get(target.name).set(key, value);
            return;
        }
        case "group": assign(ctx, target.expr, value); return;
        default: throw new AwkError("invalid assignment target");
    }
}

// ============================================================================
// Builtins
// ============================================================================

function evalCall(ctx, name, args) {
    switch (name) {
        case "length": {
            const s = args.length === 0 ? ctx.record : valueToStr(evalExpr(ctx, args[0]));
            return vNum([...s].length);
        }
        case "substr": {
            const s = valueToStr(evalExpr(ctx, args[0]));
            const chars = [...s];
            const startArg = valueToNum(evalExpr(ctx, args[1]));
            const start = Math.max(Math.round(startArg), 1);
            const len = args.length > 2 ? Math.round(valueToNum(evalExpr(ctx, args[2]))) : chars.length;
            const start0 = start - 1;
            if (start0 >= chars.length || len <= 0) return vStr("");
            const end = Math.min(start0 + len, chars.length);
            return vStr(chars.slice(start0, end).join(""));
        }
        case "index": {
            const hay = valueToStr(evalExpr(ctx, args[0]));
            const needle = valueToStr(evalExpr(ctx, args[1]));
            if (needle === "") return vNum(1);
            const idx = hay.indexOf(needle);
            return vNum(idx === -1 ? 0 : idx + 1);
        }
        case "split": {
            const s = valueToStr(evalExpr(ctx, args[0]));
            if (args[1].kind !== "var") {
                throw new AwkError(`split(): second argument must be an array name, got ${args[1].kind}`);
            }
            const arrayName = args[1].name;
            const fs = args.length > 2 ? regexOperandText(ctx, args[2]) : ctx.fs;
            const parts = splitRecord(s, fs);
            const map = new Map();
            parts.forEach((p, i) => map.set(String(i + 1), vStrNum(p)));
            ctx.arrays.set(arrayName, map);
            return vNum(parts.length);
        }
        case "sub":
        case "gsub": {
            const pat = regexOperandText(ctx, args[0]);
            const repl = valueToStr(evalExpr(ctx, args[1]));
            const target = args.length > 2 ? args[2] : { kind: "field", idx: { kind: "num", value: 0 } };
            const text = valueToStr(evalExpr(ctx, target));
            const re = compileRegex(pat);
            const global = name === "gsub";
            const [result, count] = regexReplace(re, text, repl, global, null);
            if (count > 0) assign(ctx, target, vStr(result));
            return vNum(count);
        }
        case "gensub": {
            const pat = regexOperandText(ctx, args[0]);
            const repl = valueToStr(evalExpr(ctx, args[1]));
            const how = args.length > 2 ? valueToStr(evalExpr(ctx, args[2])) : "1";
            const text = args.length > 3 ? valueToStr(evalExpr(ctx, args[3])) : ctx.record;
            const re = compileRegex(pat);
            const global = how.trim().toLowerCase() === "g";
            const nth = global ? null : Math.max(parseLeadingNumber(how), 1);
            const [result] = regexReplace(re, text, repl, global, nth);
            return vStr(result);
        }
        case "match": {
            const text = valueToStr(evalExpr(ctx, args[0]));
            const pat = regexOperandText(ctx, args[1]);
            const re = compileRegex(pat);
            re.lastIndex = 0;
            const m = re.exec(text);
            if (m) {
                ctx.rstart = m.index + 1;
                ctx.rlength = m[0].length;
                return vNum(ctx.rstart);
            }
            ctx.rstart = 0;
            ctx.rlength = -1;
            return vNum(0);
        }
        case "toupper": return vStr(valueToStr(evalExpr(ctx, args[0])).toUpperCase());
        case "tolower": return vStr(valueToStr(evalExpr(ctx, args[0])).toLowerCase());
        case "sprintf": {
            const fmt = valueToStr(evalExpr(ctx, args[0]));
            const vals = args.slice(1).map((a) => evalExpr(ctx, a));
            return vStr(awkSprintf(fmt, vals));
        }
        case "sin": return vNum(Math.sin(valueToNum(evalExpr(ctx, args[0]))));
        case "cos": return vNum(Math.cos(valueToNum(evalExpr(ctx, args[0]))));
        case "atan2": {
            const y = valueToNum(evalExpr(ctx, args[0]));
            const x = valueToNum(evalExpr(ctx, args[1]));
            return vNum(Math.atan2(y, x));
        }
        case "exp": return vNum(Math.exp(valueToNum(evalExpr(ctx, args[0]))));
        case "log": return vNum(Math.log(valueToNum(evalExpr(ctx, args[0]))));
        case "sqrt": return vNum(Math.sqrt(valueToNum(evalExpr(ctx, args[0]))));
        case "int": return vNum(Math.trunc(valueToNum(evalExpr(ctx, args[0]))));
        case "rand": return vNum(ctx.nextRand());
        case "srand": {
            const prev = ctx.rng;
            const seed = args.length === 0
                ? 1n
                : BigInt.asUintN(64, BigInt(Math.trunc(valueToNum(evalExpr(ctx, args[0])))));
            const mult = BigInt.asUintN(64, seed * 0x9e3779b97f4a7c15n);
            ctx.rng = mult > 1n ? mult : 1n;
            return vNum(Number(prev));
        }
        default: throw new AwkError(`calling undefined function ${name}`);
    }
}

// Replaces matches of `re` (must have the "g" flag) in `text` with `repl`,
// supporting `&` (whole match) / `\&` (literal ampersand) and `\1`..`\9`
// backreferences. `nth` (1-based) replaces only that occurrence; `global`
// replaces all; the default (both null) replaces the first. Returns
// [result, count].
function regexReplace(re, text, repl, global, nth) {
    re.lastIndex = 0;
    let out = "";
    let lastEnd = 0;
    let count = 0;
    let occurrence = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        occurrence += 1;
        const shouldReplace = global || (nth != null ? nth === occurrence : occurrence === 1);
        out += text.slice(lastEnd, m.index);
        if (shouldReplace) {
            out += expandReplacement(repl, m);
            count += 1;
        } else {
            out += m[0];
        }
        lastEnd = m.index + m[0].length;
        if (m[0] === "") re.lastIndex += 1; // avoid an infinite loop on empty matches
        if (!global && count > 0 && nth == null) break;
        if (nth != null && occurrence >= nth) break;
    }
    out += text.slice(lastEnd);
    return [out, count];
}

function expandReplacement(repl, m) {
    const chars = [...repl];
    let out = "";
    let i = 0;
    while (i < chars.length) {
        if (chars[i] === "\\" && i + 1 < chars.length) {
            const next = chars[i + 1];
            if (next === "&") { out += "&"; i += 2; continue; }
            if (next === "\\") { out += "\\"; i += 2; continue; }
            if (isDigit(next)) { out += m[Number(next)] ?? ""; i += 2; continue; }
            out += next;
            i += 2;
            continue;
        }
        if (chars[i] === "&") { out += m[0] ?? ""; i += 1; continue; }
        out += chars[i];
        i += 1;
    }
    return out;
}

function pad(s, width, left, zeroPad) {
    const len = [...s].length;
    if (len >= width) return s;
    const fill = zeroPad ? "0" : " ";
    const padding = fill.repeat(width - len);
    if (left) return s + padding;
    if (zeroPad && (s.startsWith("-") || s.startsWith("+"))) return s[0] + padding + s.slice(1);
    return padding + s;
}

function toUnsigned64(n) {
    return BigInt.asUintN(64, BigInt(Number.isFinite(n) ? Math.trunc(n) : 0));
}

function formatExp(f, precision, upper) {
    if (f === 0) return `${(0).toFixed(precision)}e+0`;
    const neg = f < 0;
    const af = Math.abs(f);
    let exp = Math.floor(Math.log10(af));
    let mantissa = af / 10 ** exp;
    let mantStr = mantissa.toFixed(precision);
    if (mantStr.startsWith("10")) {
        exp += 1;
        mantissa /= 10;
        mantStr = mantissa.toFixed(precision);
    }
    const e = upper ? "E" : "e";
    const sign = exp >= 0 ? "+" : "-";
    return `${neg ? "-" : ""}${mantStr}${e}${sign}${Math.abs(exp)}`;
}

// A compact printf/sprintf formatter covering %s %d %i %o %x %X %c %e %E %f
// %F %g %G %% with -+0 # flags and literal width/precision digits (no
// *-from-args). Not a port of any upstream file (awk's own printf isn't
// shared code upstream either); intentionally smaller than text.js's printf
// since awk's conversions operate on Values, not shell argv strings.
function awkSprintf(fmt, args) {
    const chars = [...fmt];
    let out = "";
    let i = 0;
    let argI = 0;
    const nextArg = () => {
        const v = args[argI] ?? vNum(0);
        argI += 1;
        return v;
    };
    while (i < chars.length) {
        if (chars[i] !== "%") { out += chars[i]; i += 1; continue; }
        i += 1;
        if (chars[i] === "%") { out += "%"; i += 1; continue; }
        let flags = "";
        while (chars[i] !== undefined && "-+0 #".includes(chars[i])) { flags += chars[i]; i += 1; }
        let width = "";
        while (isDigit(chars[i])) { width += chars[i]; i += 1; }
        let precision = null;
        if (chars[i] === ".") {
            i += 1;
            let p = "";
            while (isDigit(chars[i])) { p += chars[i]; i += 1; }
            precision = p === "" ? 0 : parseInt(p, 10);
        }
        const conv = chars[i];
        if (conv === undefined) throw new AwkError("printf: dangling format spec");
        i += 1;
        const widthN = width === "" ? 0 : parseInt(width, 10);
        const left = flags.includes("-");
        const zero = flags.includes("0") && !left;
        const plus = flags.includes("+");
        const space = flags.includes(" ");
        let piece;
        switch (conv) {
            case "s": {
                let s = valueToStr(nextArg());
                if (precision != null) s = [...s].slice(0, precision).join("");
                piece = pad(s, widthN, left, false);
                break;
            }
            case "d":
            case "i": {
                const n = Math.trunc(valueToNum(nextArg()));
                let s = Math.abs(n).toString();
                if (precision != null) while (s.length < precision) s = `0${s}`;
                const sign = n < 0 ? "-" : plus ? "+" : space ? " " : "";
                piece = pad(`${sign}${s}`, widthN, left, zero);
                break;
            }
            case "o": {
                const n = Math.trunc(valueToNum(nextArg()));
                piece = pad(toUnsigned64(n).toString(8), widthN, left, zero);
                break;
            }
            case "x": {
                const n = Math.trunc(valueToNum(nextArg()));
                piece = pad(toUnsigned64(n).toString(16), widthN, left, zero);
                break;
            }
            case "X": {
                const n = Math.trunc(valueToNum(nextArg()));
                piece = pad(toUnsigned64(n).toString(16).toUpperCase(), widthN, left, zero);
                break;
            }
            case "c": {
                const v = nextArg();
                const ch = v.t === "num" ? (String.fromCharCode(v.n) || "\0") : (v.s[0] ?? "\0");
                piece = pad(ch, widthN, left, false);
                break;
            }
            case "e":
            case "E": {
                const n = valueToNum(nextArg());
                piece = pad(formatExp(n, precision ?? 6, conv === "E"), widthN, left, zero);
                break;
            }
            case "f":
            case "F": {
                const n = valueToNum(nextArg());
                let s = n.toFixed(precision ?? 6);
                if (n >= 0 && plus) s = `+${s}`;
                piece = pad(s, widthN, left, zero);
                break;
            }
            case "g":
            case "G": {
                const n = valueToNum(nextArg());
                piece = pad(formatAwkNumber(n), widthN, left, zero);
                break;
            }
            default: throw new AwkError(`printf: unsupported conversion %${conv}`);
        }
        out += piece;
    }
    return out;
}

// ============================================================================
// Statement execution
// ============================================================================

// Flow: "normal" | "break" | "continue" | "next" | "exit"
function execStmt(ctx, stmt) {
    switch (stmt.kind) {
        case "block": {
            for (const s of stmt.stmts) {
                const flow = execStmt(ctx, s);
                if (flow !== "normal") return flow;
            }
            return "normal";
        }
        case "expr":
            evalExpr(ctx, stmt.expr);
            return "normal";
        case "print": {
            const line = stmt.args.length === 0
                ? ctx.record
                : stmt.args.map((a) => valueToStr(evalExpr(ctx, a))).join(ctx.ofs);
            ctx.stdout += line + ctx.ors;
            return "normal";
        }
        case "printf": {
            if (stmt.args.length === 0) throw new AwkError("printf: missing format string");
            const fmt = valueToStr(evalExpr(ctx, stmt.args[0]));
            const vals = stmt.args.slice(1).map((a) => evalExpr(ctx, a));
            ctx.stdout += awkSprintf(fmt, vals);
            return "normal";
        }
        case "if":
            if (valueTruthy(evalExpr(ctx, stmt.cond))) return execStmt(ctx, stmt.then);
            if (stmt.else) return execStmt(ctx, stmt.else);
            return "normal";
        case "while": {
            while (valueTruthy(evalExpr(ctx, stmt.cond))) {
                const flow = execStmt(ctx, stmt.body);
                if (flow === "break") break;
                if (flow !== "continue" && flow !== "normal") return flow;
            }
            return "normal";
        }
        case "doWhile": {
            for (;;) {
                const flow = execStmt(ctx, stmt.body);
                if (flow === "break") break;
                if (flow !== "continue" && flow !== "normal") return flow;
                if (!valueTruthy(evalExpr(ctx, stmt.cond))) break;
            }
            return "normal";
        }
        case "for": {
            if (stmt.init) execStmt(ctx, stmt.init);
            for (;;) {
                if (stmt.cond && !valueTruthy(evalExpr(ctx, stmt.cond))) break;
                const flow = execStmt(ctx, stmt.body);
                if (flow === "break") break;
                if (flow !== "continue" && flow !== "normal") return flow;
                if (stmt.incr) execStmt(ctx, stmt.incr);
            }
            return "normal";
        }
        case "break": return "break";
        case "continue": return "continue";
        case "next": return "next";
        case "exit":
            if (stmt.arg) ctx.exitCode = Math.trunc(valueToNum(evalExpr(ctx, stmt.arg)));
            return "exit";
        default: throw new AwkError(`unhandled statement kind ${stmt.kind}`);
    }
}

// ============================================================================
// Command entry point
// ============================================================================

function splitRecords(content) {
    if (content === "") return [];
    const lines = content.split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
}

// `-F` treats a literal `\t` (as typed on the command line) as a tab, same
// as real awk/gawk.
function interpretFsFlag(fs) {
    return fs === "\\t" ? "\t" : fs;
}

function finish(ctx, rules, runEnd) {
    if (runEnd) {
        for (const rule of rules) {
            if (rule.pattern.kind === "end" && rule.action) {
                try {
                    execStmt(ctx, rule.action);
                } catch (e) {
                    if (e instanceof AwkError) return fail(`awk: ${e.message}\n`, 1);
                    throw e;
                }
            }
        }
    }
    const exitCode = ctx.exitCode ?? 0;
    if (exitCode !== 0) return { stdout: ctx.stdout, stderr: "", exitCode };
    return ok(ctx.stdout);
}

export function awkCommand(interp, args, stdin) {
    const argv = args.slice(1);
    if (argv.includes("--help")) {
        return ok("awk - pattern scanning and processing language\nusage: awk [-F fs] [-v var=val] 'program' [file...]\n");
    }

    let fsOverride = null;
    const assignments = [];
    let programText = null;
    const files = [];
    let i = 0;
    while (i < argv.length) {
        const a = argv[i];
        if (a === "-F") {
            i += 1;
            fsOverride = argv[i] ?? null;
        } else if (a.startsWith("-F") && a.length > 2) {
            fsOverride = a.slice(2);
        } else if (a === "-v") {
            i += 1;
            const kv = argv[i];
            if (kv !== undefined) {
                const eq = kv.indexOf("=");
                if (eq !== -1) assignments.push([kv.slice(0, eq), kv.slice(eq + 1)]);
            }
        } else if (programText === null) {
            programText = a;
        } else {
            files.push(a);
        }
        i += 1;
    }

    if (programText === null) return fail("awk: missing program\n", 1);

    let rules;
    try {
        rules = parseProgram(programText);
    } catch (e) {
        if (e instanceof AwkError) return fail(`awk: syntax error: ${e.message}\n`, 1);
        throw e;
    }

    const ctx = new Ctx();
    if (fsOverride !== null) ctx.fs = interpretFsFlag(fsOverride);
    for (const [k, v] of assignments) ctx.setVar(k, vStrNum(v));

    // BEGIN
    for (const rule of rules) {
        if (rule.pattern.kind === "begin" && rule.action) {
            try {
                if (execStmt(ctx, rule.action) === "exit") return finish(ctx, rules, false);
            } catch (e) {
                if (e instanceof AwkError) return fail(`awk: ${e.message}\n`, 1);
                throw e;
            }
        }
    }

    const needsInput = rules.some((r) => r.pattern.kind !== "begin");
    if (needsInput) {
        let sources;
        if (files.length === 0) {
            sources = [["", stdin, null]];
        } else {
            sources = files.map((f) => {
                const path = interp.resolvePath(f);
                if (interp.vfs.isDir(path)) return [f, null, `awk: ${f}: Is a directory`];
                if (!interp.vfs.isFile(path)) return [f, null, `awk: ${f}: No such file or directory`];
                return [f, interp.vfs.readFile(path), null];
            });
        }

        outer:
        for (const [filename, content, err] of sources) {
            if (err) return fail(`${err}\n`, 1);
            ctx.filename = filename;
            ctx.fnr = 0;
            for (const record of splitRecords(content)) {
                ctx.nr += 1;
                ctx.fnr += 1;
                ctx.setRecord(record);
                for (const rule of rules) {
                    let matched;
                    if (rule.pattern.kind === "begin" || rule.pattern.kind === "end") {
                        matched = false;
                    } else if (rule.pattern.kind === "always") {
                        matched = true;
                    } else {
                        try {
                            matched = rule.pattern.kind === "range"
                                ? matchRangePattern(ctx, rule.pattern)
                                : valueTruthy(evalExpr(ctx, rule.pattern.expr));
                        } catch (e) {
                            if (e instanceof AwkError) return fail(`awk: ${e.message}\n`, 1);
                            throw e;
                        }
                    }
                    if (!matched) continue;
                    let flow;
                    try {
                        flow = rule.action ? execStmt(ctx, rule.action) : execStmt(ctx, { kind: "print", args: [] });
                    } catch (e) {
                        if (e instanceof AwkError) return fail(`awk: ${e.message}\n`, 1);
                        throw e;
                    }
                    if (flow === "next") break;
                    if (flow === "exit") break outer;
                }
            }
        }
    }

    return finish(ctx, rules, true);
}
