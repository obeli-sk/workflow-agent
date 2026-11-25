// A practical subset of awk: a from-scratch hand-rolled lexer + recursive-descent parser + tree-walking
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
// ternary ?:, if/else, while, do/while, classic for(;;), for (k in arr),
// break/continue/next/nextfile/exit [code]; user-defined functions (arrays
// by reference, return); arrays with delete, `in`, (i,j) SUBSEP keys and
// length(arr); getline in all forms (plain, var, < file, cmd |); print/printf
// redirection (> >> | and /dev/stdout, /dev/stderr) with close/fflush;
// system(); builtins length substr index split sub gsub gensub match toupper
// tolower sprintf sin cos atan2 exp log sqrt int rand srand; built-in vars
// NR NF FS OFS ORS RS SUBSEP FILENAME FNR RSTART RLENGTH; RS as newline,
// "" (paragraphs), a single char or a regex; var=value operands; CLI flags
// -F/-v/-f/--. Numbers print with %.6g.
//
// Explicitly out of scope: |& coprocesses, CONVFMT/OFMT changes, RT, arrays
// of arrays, gawk's asort/strftime/etc., and execution/allocation limits
// beyond a function-recursion cap.
//
// Regex flavor: awk regex is ERE, and JS RegExp is already ERE/PCRE-ish, so
// (unlike sed/grep's BRE mode) there is no translateBre step here — only
// expandPosixBracketClasses, since JS RegExp has no native [:class:] support.

import { ok, fail } from "./core.js";
import { expandPosixBracketClasses } from "../regex-bre.js";

export class AwkError extends Error {}

// ============================================================================
// Lexer
// ============================================================================

const KEYWORDS = new Set([
    "BEGIN", "END", "if", "else", "while", "do", "for", "break", "continue",
    "next", "nextfile", "exit", "print", "printf", "return", "in", "function", "func", "delete", "getline",
]);
function isKeyword(s) {
    return KEYWORDS.has(s);
}

const PUNCTS_2 = ["**", "==", "!=", "<=", ">=", ">>", "&&", "||", "!~", "++", "--", "+=", "-=", "*=", "/=", "%=", "^="];
const PUNCTS_1 = ["{", "}", "(", ")", "[", "]", ";", ",", "$", "=", "<", ">", "!", "~", "+", "-", "*", "/", "%", "^", "?", ":", "|"];

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

// String-literal escapes, as applied to -v and var=value operands.
function processEscapes(s) {
    const chars = [...s];
    let out = "";
    let i = 0;
    while (i < chars.length) {
        if (chars[i] === "\\" && i + 1 < chars.length) {
            const [ch, next] = decodeEscape(chars, i + 1);
            out += ch;
            i = next;
        } else {
            out += chars[i];
            i += 1;
        }
    }
    return out;
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
        this.functions = new Map();
        // Inside print/printf arguments an unparenthesized `>` is a redirection.
        this.noGt = false;
    }

    // Runs `parse` with `>` meaning comparison again (inside (), [] and call args).
    withGt(parse) {
        const saved = this.noGt;
        this.noGt = false;
        try {
            return parse();
        } finally {
            this.noGt = saved;
        }
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
            if (this.eatIdent("function") || this.eatIdent("func")) this.parseFunction();
            else rules.push(this.parseRule());
            this.skipTerms();
        }
        return { rules, functions: this.functions };
    }

    parseFunction() {
        const name = this.advance();
        if (!name || name.k !== "ident" || isKeyword(name.v)) throw new AwkError("expected a function name");
        if (this.functions.has(name.v)) throw new AwkError(`function \`${name.v}' previously defined`);
        this.expectPunct("(");
        const params = [];
        while (!this.peekPunct(")")) {
            const p = this.advance();
            if (!p || p.k !== "ident" || isKeyword(p.v)) throw new AwkError(`bad parameter list for function \`${name.v}'`);
            params.push(p.v);
            if (!this.eatPunct(",")) break;
        }
        this.expectPunct(")");
        this.skipTermsOptBeforeStmt();
        this.functions.set(name.v, { params, body: this.parseBlock() });
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
            const [v, kw, arr, close] = this.toks.slice(this.pos, this.pos + 4);
            if (v?.k === "ident" && kw?.k === "ident" && kw.v === "in" && arr?.k === "ident" && close?.k === "punct" && close.v === ")") {
                this.pos += 4;
                this.skipTermsOptBeforeStmt();
                return { kind: "forIn", var: v.v, name: arr.v, body: this.parseStmt() };
            }
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
        if (this.eatIdent("nextfile")) return { kind: "nextfile" };
        if (this.eatIdent("exit")) {
            const arg = this.stmtEnds() ? null : this.parseExpr();
            return { kind: "exit", arg };
        }
        if (this.eatIdent("return")) {
            const arg = this.stmtEnds() ? null : this.parseExpr();
            return { kind: "return", arg };
        }
        if (this.eatIdent("delete")) {
            const name = this.advance();
            if (!name || name.k !== "ident") throw new AwkError("expected an array name after delete");
            const idx = this.eatPunct("[") ? this.parseSubscript() : null;
            return { kind: "delete", name: name.v, idx };
        }
        if (this.eatIdent("print")) return { kind: "print", ...this.parsePrintArgs() };
        if (this.eatIdent("printf")) return { kind: "printf", ...this.parsePrintArgs() };
        return { kind: "expr", expr: this.parseExpr() };
    }

    peekRedirect() {
        const t = this.peek();
        return !!t && t.k === "punct" && (t.v === ">" || t.v === ">>" || t.v === "|");
    }

    // print/printf arguments, `(a, b)` grouped form included, then an optional > >> | target.
    parsePrintArgs() {
        let args = [];
        const saved = this.noGt;
        this.noGt = true;
        if (!this.stmtEnds() && !this.peekRedirect()) {
            for (;;) {
                args.push(this.parseTernary());
                if (!this.eatPunct(",")) break;
            }
        }
        if (args.length === 1 && args[0].kind === "grouping") args = args[0].exprs;
        let dest = null;
        if (this.peekRedirect()) {
            const mode = this.advance().v;
            dest = { mode, expr: this.parseConcat() };
        }
        this.noGt = saved;
        return { args, dest };
    }

    parseSubscript() {
        return this.withGt(() => {
            const exprs = [this.parseExpr()];
            while (this.eatPunct(",")) exprs.push(this.parseExpr());
            this.expectPunct("]");
            return exprs.length === 1 ? exprs[0] : { kind: "subscript", exprs };
        });
    }

    // The optional lvalue after `getline`.
    parseGetlineTarget() {
        const t = this.peek();
        if (t?.k === "punct" && t.v === "$") {
            this.pos += 1;
            return { kind: "field", idx: this.parseDollarOperand() };
        }
        if (t?.k === "ident" && !isKeyword(t.v)) {
            this.pos += 1;
            if (this.eatPunct("[")) return { kind: "arrayIndex", name: t.v, idx: this.parseSubscript() };
            return { kind: "var", name: t.v };
        }
        return null;
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
        let left = this.parseIn();
        while (this.eatPunct("&&")) {
            this.skipTermsOptBeforeStmt();
            left = { kind: "and", left, right: this.parseIn() };
        }
        return left;
    }

    parseIn() {
        let left = this.parseMatch();
        while (this.eatIdent("in")) {
            const name = this.advance();
            if (!name || name.k !== "ident") throw new AwkError("expected an array name after 'in'");
            const keys = left.kind === "grouping" ? left.exprs : [left];
            left = { kind: "in", idx: keys.length === 1 ? keys[0] : { kind: "subscript", exprs: keys }, name: name.v };
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
        if (t && t.k === "punct" && REL_OPS.has(t.v) && !(this.noGt && t.v === ">")) {
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
        for (;;) {
            const after = this.toks[this.pos + 1];
            if (this.startsConcatTerm()) {
                left = { kind: "concat", left, right: this.parseAdd() };
            } else if (this.peekPunct("|") && after?.k === "ident" && after.v === "getline") {
                // `cmd | getline [var]`: everything concatenated so far is the command.
                this.pos += 2;
                left = { kind: "getline", source: "cmd", cmd: left, target: this.parseGetlineTarget() };
            } else {
                break;
            }
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
            return this.withGt(() => {
                const exprs = [this.parseExpr()];
                while (this.eatPunct(",")) exprs.push(this.parseExpr());
                this.expectPunct(")");
                // `(a, b)` is only valid before `in` or as print arguments.
                return exprs.length === 1 ? { kind: "group", expr: exprs[0] } : { kind: "grouping", exprs };
            });
        }
        if (t.k === "ident") {
            const name = t.v;
            if (name === "getline") {
                const target = this.parseGetlineTarget();
                if (this.eatPunct("<")) return { kind: "getline", source: "file", file: this.parsePrimary(), target };
                return { kind: "getline", source: "main", target };
            }
            if (isKeyword(name)) throw new AwkError(`unexpected '${name}'`);
            if (this.peekPunct("(")) {
                this.pos += 1;
                const args = this.withGt(() => {
                    const list = [];
                    if (!this.peekPunct(")")) {
                        for (;;) {
                            list.push(this.parseTernary());
                            if (!this.eatPunct(",")) break;
                        }
                    }
                    this.expectPunct(")");
                    return list;
                });
                return { kind: "call", name, args };
            }
            if (name === "length") return { kind: "call", name, args: [] };
            if (this.eatPunct("[")) return { kind: "arrayIndex", name, idx: this.parseSubscript() };
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
            return this.withGt(() => {
                const inner = this.parseExpr();
                this.expectPunct(")");
                return inner;
            });
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

// Integral values print in full, everything else with the default OFMT/CONVFMT %.6g.
function formatAwkNumber(f) {
    if (Number.isNaN(f)) return "nan";
    if (!Number.isFinite(f)) return f > 0 ? "inf" : "-inf";
    if (Number.isInteger(f)) return Object.is(f, -0) ? "-0" : BigInt(f).toString();
    return formatG(f, 6, false, false);
}

function formatExp(f, precision, upper) {
    if (!Number.isFinite(f)) return formatAwkNumber(f);
    const [mant, exp] = f.toExponential(precision).split("e");
    const digits = exp.replace(/^[+-]/, "").padStart(2, "0");
    return `${mant}${upper ? "E" : "e"}${exp[0] === "-" ? "-" : "+"}${digits}`;
}

// C's %g: %e or %f by exponent, trailing zeros dropped unless `alt` (#).
function formatG(f, precision, upper, alt) {
    const p = precision === 0 ? 1 : precision;
    if (!Number.isFinite(f)) return formatAwkNumber(f);
    if (f === 0) return alt ? (0).toFixed(p - 1) : "0";
    const exp = Number(f.toExponential(p - 1).split("e")[1]);
    if (exp < -4 || exp >= p) {
        const s = formatExp(f, p - 1, upper);
        return alt ? s : s.replace(/\.?0+(?=[eE])/, "");
    }
    const s = f.toFixed(p - 1 - exp);
    return alt || !s.includes(".") ? s : s.replace(/\.?0+$/, "");
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

const SPECIAL_VARS = new Set(["NR", "NF", "FNR", "FS", "OFS", "ORS", "RS", "SUBSEP", "FILENAME", "RSTART", "RLENGTH"]);
const MAX_CALL_DEPTH = 1000;

// Thrown to carry next/nextfile/exit out of a user-defined function.
class FlowSignal {
    constructor(flow) {
        this.flow = flow;
    }
}

// A function frame maps each parameter to a cell: {v} for a scalar, {arr}
// for an array, or {lazy} for an untyped argument that becomes the caller's
// array once the callee uses it as one.
function cellArray(cell) {
    if (!cell.arr) {
        if (cell.v !== undefined) throw new AwkError("attempt to use a scalar as an array");
        cell.arr = cell.lazy ? cell.lazy() : new Map();
    }
    return cell.arr;
}

class Ctx {
    constructor(interp, stdin, functions) {
        this.interp = interp;
        this.stdin = stdin;
        this.functions = functions;
        this.frames = [];
        this.returnValue = UNINIT;
        this.outputs = new Map();
        this.readers = new Map();
        this.stderr = "";
        this.vars = new Map();
        this.arrays = new Map();
        this.fields = [];
        this.record = "";
        this.fs = " ";
        this.ofs = " ";
        this.ors = "\n";
        this.rs = "\n";
        this.subsep = "\x1c";
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
        // In paragraph mode (RS="") newline always separates fields too.
        this.fields = this.rs === "" && this.fs !== " "
            ? record.split("\n").flatMap((line) => splitRecord(line, this.fs))
            : splitRecord(record, this.fs);
    }

    localCell(name) {
        return this.frames[this.frames.length - 1]?.get(name);
    }

    isArray(name) {
        const cell = this.localCell(name);
        return cell ? !!cell.arr : this.arrays.has(name);
    }

    globalArray(name) {
        if (this.vars.has(name) || SPECIAL_VARS.has(name)) throw new AwkError(`attempt to use scalar \`${name}' as an array`);
        if (!this.arrays.has(name)) this.arrays.set(name, new Map());
        return this.arrays.get(name);
    }

    getArray(name) {
        const cell = this.localCell(name);
        return cell ? cellArray(cell) : this.globalArray(name);
    }

    // The frame cell for passing variable `name` as a function argument.
    argumentCell(name) {
        const cell = this.localCell(name);
        if (cell) {
            if (cell.arr) return { arr: cell.arr };
            if (cell.v === undefined) return { lazy: () => cellArray(cell) };
            return { v: cell.v };
        }
        if (this.arrays.has(name)) return { arr: this.arrays.get(name) };
        if (!this.vars.has(name) && !SPECIAL_VARS.has(name)) return { lazy: () => this.globalArray(name) };
        return { v: this.getVar(name) };
    }

    // Output target for print/printf redirection; returns a writer function.
    output(name, mode) {
        if (name === "/dev/stdout" || name === "-") return (text) => { this.stdout += text; };
        if (name === "/dev/stderr") return (text) => { this.stderr += text; };
        if (name === "/dev/null") return () => {};
        let out = this.outputs.get(name);
        if (!out) {
            if (mode === "|") {
                out = { pipe: true, text: "" };
            } else {
                const path = this.interp.resolvePath(name);
                if (this.interp.vfs.isDir(path)) throw new AwkError(`can't redirect to \`${name}' (Is a directory)`);
                if (mode === ">" || !this.interp.vfs.isFile(path)) this.interp.vfs.writeFile(path, "");
                out = { path };
            }
            this.outputs.set(name, out);
        }
        return out.pipe
            ? (text) => { out.text += text; }
            : (text) => { this.interp.vfs.appendFile(out.path, text); };
    }

    // Reader for `getline < file` (source "file") or `cmd | getline` (source "cmd"); null if the file is missing.
    reader(name, source) {
        let r = this.readers.get(name);
        if (!r) {
            let content;
            let status = 0;
            if (source === "cmd") {
                const res = runShell(this, name, "");
                this.stderr += res.stderr;
                content = res.stdout;
                status = res.exitCode;
            } else if (name === "-" || name === "/dev/stdin") {
                content = this.stdin;
            } else {
                const path = this.interp.resolvePath(name);
                if (!this.interp.vfs.isFile(path)) return null;
                content = this.interp.vfs.readFile(path);
            }
            r = { records: splitRecords(content, this.rs), idx: 0, status };
            this.readers.set(name, r);
        }
        return r;
    }

    // close(): finishes an output pipe or file, or forgets a reader. Returns the exit status.
    close(name) {
        const out = this.outputs.get(name);
        if (out) {
            this.outputs.delete(name);
            if (!out.pipe) return 0;
            const res = runShell(this, name, out.text);
            this.stdout += res.stdout;
            this.stderr += res.stderr;
            return res.exitCode;
        }
        const r = this.readers.get(name);
        if (r) {
            this.readers.delete(name);
            return r.status;
        }
        return -1;
    }

    closeAll() {
        for (const name of [...this.outputs.keys()]) this.close(name);
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
        const cell = this.localCell(name);
        if (cell) {
            if (cell.arr) throw new AwkError(`attempt to use array \`${name}' in a scalar context`);
            return cell.v ?? UNINIT;
        }
        switch (name) {
            case "NR": return vNum(this.nr);
            case "NF": return vNum(this.fields.length);
            case "FNR": return vNum(this.fnr);
            case "FS": return vStr(this.fs);
            case "OFS": return vStr(this.ofs);
            case "ORS": return vStr(this.ors);
            case "RS": return vStr(this.rs);
            case "SUBSEP": return vStr(this.subsep);
            case "FILENAME": return vStr(this.filename);
            case "RSTART": return vNum(this.rstart);
            case "RLENGTH": return vNum(this.rlength);
            default:
                if (this.arrays.has(name)) throw new AwkError(`attempt to use array \`${name}' in a scalar context`);
                return this.vars.get(name) ?? UNINIT;
        }
    }

    setVar(name, value) {
        const cell = this.localCell(name);
        if (cell) {
            if (cell.arr) throw new AwkError(`attempt to use array \`${name}' in a scalar context`);
            cell.v = value;
            return;
        }
        if (this.arrays.has(name)) throw new AwkError(`attempt to use array \`${name}' in a scalar context`);
        switch (name) {
            case "NF": this.setNF(Math.trunc(valueToNum(value))); break;
            case "FS": this.fs = valueToStr(value); break;
            case "OFS": this.ofs = valueToStr(value); break;
            case "ORS": this.ors = valueToStr(value); break;
            case "RS": this.rs = valueToStr(value); break;
            case "SUBSEP": this.subsep = valueToStr(value); break;
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
            const key = subscriptKey(ctx, expr.idx);
            const map = ctx.getArray(expr.name);
            // Referencing an element creates it, as in awk.
            if (!map.has(key)) map.set(key, UNINIT);
            return map.get(key);
        }
        case "in": {
            const key = subscriptKey(ctx, expr.idx);
            return vNum(ctx.getArray(expr.name).has(key) ? 1 : 0);
        }
        case "getline": return vNum(evalGetline(ctx, expr));
        case "grouping": throw new AwkError("a parenthesized list is only valid before `in' or in print");
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

// Array key: a single expression, or `i, j` joined with SUBSEP.
function subscriptKey(ctx, idx) {
    if (idx.kind === "subscript") return idx.exprs.map((e) => valueToStr(evalExpr(ctx, e))).join(ctx.subsep);
    return valueToStr(evalExpr(ctx, idx));
}

// Returns 1 on a record, 0 at end of input, -1 when the file can't be opened.
function evalGetline(ctx, expr) {
    let record;
    if (expr.source === "main") {
        record = ctx.mainInput.next();
    } else {
        const name = valueToStr(evalExpr(ctx, expr.source === "file" ? expr.file : expr.cmd));
        const r = ctx.reader(name, expr.source);
        if (!r) return -1;
        record = r.idx < r.records.length ? r.records[r.idx++] : null;
        if (record !== null && expr.source === "cmd") ctx.nr += 1;
    }
    if (record === null) return 0;
    if (expr.target) assign(ctx, expr.target, vStrNum(record));
    else ctx.setRecord(record);
    return 1;
}

// Runs `cmd` with `sh -c` semantics in the shell interpreter.
function runShell(ctx, cmd, stdin) {
    return ctx.interp.runScriptIsolated(cmd, "sh", [], stdin);
}

function callUser(ctx, name, fn, args) {
    if (args.length > fn.params.length) {
        throw new AwkError(`function \`${name}' called with more arguments than declared`);
    }
    if (ctx.frames.length >= MAX_CALL_DEPTH) throw new AwkError(`function call nesting too deep in \`${name}'`);
    const frame = new Map();
    fn.params.forEach((param, i) => {
        const arg = args[i];
        if (arg === undefined) frame.set(param, {});
        else if (arg.kind === "var") frame.set(param, ctx.argumentCell(arg.name));
        else frame.set(param, { v: evalExpr(ctx, arg) });
    });
    ctx.frames.push(frame);
    try {
        const flow = execStmt(ctx, fn.body);
        if (flow === "next" || flow === "nextfile" || flow === "exit") throw new FlowSignal(flow);
        if (flow !== "return") return UNINIT;
        const value = ctx.returnValue;
        ctx.returnValue = UNINIT;
        return value;
    } finally {
        ctx.frames.pop();
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
            const key = subscriptKey(ctx, target.idx);
            ctx.getArray(target.name).set(key, value);
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
    const fn = ctx.functions.get(name);
    if (fn) return callUser(ctx, name, fn, args);
    switch (name) {
        case "length": {
            if (args[0]?.kind === "var" && ctx.isArray(args[0].name)) return vNum(ctx.getArray(args[0].name).size);
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
            const fs = args.length > 2 ? regexOperandText(ctx, args[2]) : ctx.fs;
            const parts = splitRecord(s, fs);
            const map = ctx.getArray(args[1].name);
            map.clear();
            parts.forEach((p, i) => map.set(String(i + 1), vStrNum(p)));
            return vNum(parts.length);
        }
        case "close": return vNum(ctx.close(valueToStr(evalExpr(ctx, args[0]))));
        case "fflush": return vNum(0);
        case "system": {
            const res = runShell(ctx, valueToStr(evalExpr(ctx, args[0])), "");
            ctx.stdout += res.stdout;
            ctx.stderr += res.stderr;
            return vNum(res.exitCode);
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

// A compact printf/sprintf formatter covering %s %d %i %o %x %X %c %e %E %f
// %F %g %G %% with -+0 # flags and width/precision digits or `*`. Not a port of any upstream file (awk's own printf isn't
// shared code upstream either); intentionally smaller than text.js's printf
// since awk's conversions operate on Values, not shell argv strings.
function awkSprintf(fmt, args) {
    const chars = [...fmt];
    let out = "";
    let i = 0;
    let argI = 0;
    const nextArg = () => {
        if (argI >= args.length) throw new AwkError("fatal: not enough arguments to satisfy format string");
        argI += 1;
        return args[argI - 1];
    };
    while (i < chars.length) {
        if (chars[i] !== "%") { out += chars[i]; i += 1; continue; }
        i += 1;
        if (chars[i] === "%") { out += "%"; i += 1; continue; }
        let flags = "";
        while (chars[i] !== undefined && "-+0 #".includes(chars[i])) { flags += chars[i]; i += 1; }
        let width = "";
        if (chars[i] === "*") {
            const w = Math.trunc(valueToNum(nextArg()));
            if (w < 0) flags += "-";
            width = String(Math.abs(w));
            i += 1;
        }
        while (isDigit(chars[i])) { width += chars[i]; i += 1; }
        let precision = null;
        if (chars[i] === ".") {
            i += 1;
            let p = "";
            if (chars[i] === "*") {
                p = String(Math.max(Math.trunc(valueToNum(nextArg())), 0));
                i += 1;
            }
            while (isDigit(chars[i])) { p += chars[i]; i += 1; }
            precision = p === "" ? 0 : parseInt(p, 10);
        }
        const conv = chars[i];
        if (conv === undefined) throw new AwkError("printf: dangling format spec");
        i += 1;
        const widthN = width === "" ? 0 : parseInt(width, 10);
        const signed = (s, n) => (n >= 0 && !s.startsWith("-") ? (flags.includes("+") ? "+" : flags.includes(" ") ? " " : "") : "") + s;
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
                piece = pad(signed(formatExp(n, precision ?? 6, conv === "E"), n), widthN, left, zero);
                break;
            }
            case "f":
            case "F": {
                const n = valueToNum(nextArg());
                piece = pad(signed(n.toFixed(precision ?? 6), n), widthN, left, zero);
                break;
            }
            case "g":
            case "G": {
                const n = valueToNum(nextArg());
                piece = pad(signed(formatG(n, precision ?? 6, conv === "G", flags.includes("#")), n), widthN, left, zero);
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

function writeOutput(ctx, dest, text) {
    if (!dest) ctx.stdout += text;
    else ctx.output(valueToStr(evalExpr(ctx, dest.expr)), dest.mode)(text);
}

// Flow: "normal" | "break" | "continue" | "next" | "nextfile" | "exit" | "return"
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
            writeOutput(ctx, stmt.dest, line + ctx.ors);
            return "normal";
        }
        case "printf": {
            if (stmt.args.length === 0) throw new AwkError("printf: missing format string");
            const fmt = valueToStr(evalExpr(ctx, stmt.args[0]));
            const vals = stmt.args.slice(1).map((a) => evalExpr(ctx, a));
            writeOutput(ctx, stmt.dest, awkSprintf(fmt, vals));
            return "normal";
        }
        case "delete": {
            const map = ctx.getArray(stmt.name);
            if (stmt.idx) map.delete(subscriptKey(ctx, stmt.idx));
            else map.clear();
            return "normal";
        }
        case "forIn": {
            const map = ctx.getArray(stmt.name);
            for (const key of [...map.keys()]) {
                // Elements deleted by an earlier iteration are skipped.
                if (map.has(key)) {
                    assign(ctx, { kind: "var", name: stmt.var }, vStrNum(key));
                    const flow = execStmt(ctx, stmt.body);
                    if (flow === "break") break;
                    if (flow !== "continue" && flow !== "normal") return flow;
                }
            }
            return "normal";
        }
        case "return":
            ctx.returnValue = stmt.arg ? evalExpr(ctx, stmt.arg) : UNINIT;
            return "return";
        case "nextfile": return "nextfile";
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

// Splits input into records per RS: "\n", "" (paragraphs separated by blank
// lines), a single literal character, or a regex.
function splitRecords(content, rs) {
    if (content === "") return [];
    if (rs === "") {
        const trimmed = content.replace(/^\n+/, "").replace(/\n+$/, "");
        return trimmed === "" ? [] : trimmed.split(/\n\n+/);
    }
    const parts = [...rs].length === 1 ? content.split(rs) : splitByRegex(content, compileRegex(rs));
    if (parts[parts.length - 1] === "") parts.pop();
    return parts;
}

function splitByRegex(content, re) {
    const parts = [];
    let last = 0;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
        if (m[0] === "") {
            re.lastIndex += 1;
        } else {
            parts.push(content.slice(last, m.index));
            last = m.index + m[0].length;
        }
    }
    parts.push(content.slice(last));
    return parts;
}

// `-F` treats a literal `\t` (as typed on the command line) as a tab, same
// as real awk/gawk.
function interpretFsFlag(fs) {
    return fs === "\\t" ? "\t" : fs;
}

const ASSIGNMENT_OPERAND = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;

// The main input: file operands (or stdin) read in order, with var=value
// operands applied when reached. Shared by the record loop and plain getline.
class MainInput {
    constructor(ctx, operands) {
        this.ctx = ctx;
        this.operands = operands;
        this.pos = 0;
        this.records = [];
        this.idx = 0;
        this.openedAny = false;
    }

    next() {
        while (this.idx >= this.records.length) {
            if (!this.openNext()) return null;
        }
        this.ctx.nr += 1;
        this.ctx.fnr += 1;
        return this.records[this.idx++];
    }

    skipFile() {
        this.idx = this.records.length;
    }

    openNext() {
        while (this.pos < this.operands.length) {
            const operand = this.operands[this.pos];
            this.pos += 1;
            const assignment = ASSIGNMENT_OPERAND.exec(operand);
            if (assignment) this.ctx.setVar(assignment[1], vStrNum(processEscapes(assignment[2])));
            else if (operand !== "" && this.open(operand)) return true;
        }
        if (this.openedAny) return false;
        this.openedAny = true;
        this.load("", this.ctx.stdin);
        return true;
    }

    // False for a directory, which is skipped with a warning like gawk does.
    open(name) {
        this.openedAny = true;
        if (name === "-" || name === "/dev/stdin") {
            this.load(name, this.ctx.stdin);
            return true;
        }
        const { vfs } = this.ctx.interp;
        const path = this.ctx.interp.resolvePath(name);
        if (vfs.isDir(path)) {
            this.ctx.stderr += `awk: warning: command line argument \`${name}' is a directory: skipped\n`;
            return false;
        }
        if (!vfs.isFile(path)) throw new AwkError(`fatal: cannot open file \`${name}' for reading: No such file or directory`);
        this.load(name, vfs.readFile(path));
        return true;
    }

    load(name, content) {
        this.ctx.filename = name;
        this.ctx.fnr = 0;
        this.records = splitRecords(content, this.ctx.rs);
        this.idx = 0;
    }
}

const USAGE = "usage: awk [-F fs] [-v var=value] [-f progfile | 'program'] [file ...]\n";

function parseCommandLine(interp, argv, stdin) {
    const opts = { fs: null, assignments: [], help: false, programText: null, operands: [] };
    const progFiles = [];
    const apply = (flag, value) => {
        if (flag === "F") {
            opts.fs = value;
        } else if (flag === "f") {
            progFiles.push(value);
        } else {
            const eq = value.indexOf("=");
            if (eq < 1) throw new AwkError(`\`${value}' argument to \`-v' not in \`var=value' form`);
            opts.assignments.push([value.slice(0, eq), processEscapes(value.slice(eq + 1))]);
        }
    };
    const LONG = { "--field-separator": "F", "--assign": "v", "--file": "f" };
    let i = 0;
    while (i < argv.length && argv[i].startsWith("-") && argv[i] !== "-") {
        const a = argv[i];
        i += 1;
        if (a === "--") break;
        const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, null];
        if (a === "--help") {
            opts.help = true;
        } else if (a === "--version") {
            opts.version = true;
        } else if (LONG[name] && inline !== null) {
            apply(LONG[name], inline);
        } else if (["-F", "-v", "-f"].includes(a.slice(0, 2)) && !a.startsWith("--")) {
            let value = a.slice(2);
            if (value === "") {
                if (i >= argv.length) throw new AwkError(`option requires an argument -- '${a[1]}'`);
                value = argv[i];
                i += 1;
            }
            apply(a[1], value);
        } else {
            throw new AwkError(a.startsWith("--") ? `unrecognized option '${a}'` : `invalid option -- '${a[1]}'`);
        }
    }
    if (opts.help || opts.version) return opts;
    if (progFiles.length > 0) {
        opts.programText = progFiles.map((file) => {
            if (file === "-" || file === "/dev/stdin") return stdin;
            const path = interp.resolvePath(file);
            if (!interp.vfs.isFile(path)) throw new AwkError(`fatal: can't open source file \`${file}' for reading: No such file or directory`);
            return interp.vfs.readFile(path);
        }).join("\n");
    } else {
        if (i >= argv.length) throw new AwkError("missing program");
        opts.programText = argv[i];
        i += 1;
    }
    opts.operands = argv.slice(i);
    return opts;
}

// Runs a BEGIN/END action; next/exit inside a function arrive as FlowSignal.
function runAction(ctx, stmt) {
    try {
        return execStmt(ctx, stmt);
    } catch (e) {
        if (e instanceof FlowSignal) return e.flow;
        throw e;
    }
}

function runSpecial(ctx, rules) {
    for (const rule of rules) {
        if (runAction(ctx, rule.action) === "exit") return "exit";
    }
    return "normal";
}

function ruleMatches(ctx, pattern) {
    if (pattern.kind === "always") return true;
    if (pattern.kind === "range") return matchRangePattern(ctx, pattern);
    return valueTruthy(evalExpr(ctx, pattern.expr));
}

const PRINT_RECORD = { kind: "print", args: [], dest: null };

// Runs the main rules against the current record: "normal", "nextfile" or "exit".
function runRecord(ctx, rules) {
    try {
        for (const rule of rules) {
            if (ruleMatches(ctx, rule.pattern)) {
                const flow = execStmt(ctx, rule.action ?? PRINT_RECORD);
                if (flow === "next") return "normal";
                if (flow === "nextfile" || flow === "exit") return flow;
            }
        }
    } catch (e) {
        if (e instanceof FlowSignal) return e.flow === "next" ? "normal" : e.flow;
        throw e;
    }
    return "normal";
}

export function awkCommand(interp, args, stdin) {
    let opts;
    let program;
    try {
        opts = parseCommandLine(interp, args.slice(1), stdin);
    } catch (e) {
        if (e instanceof AwkError) return fail(`awk: ${e.message}\n${USAGE}`, 2);
        throw e;
    }
    if (opts.version) return ok("awk (just-bash), a POSIX awk subset with some gawk extensions\n");
    if (opts.help) return ok(`awk - pattern scanning and processing language\n${USAGE}`);
    try {
        program = parseProgram(opts.programText);
    } catch (e) {
        if (e instanceof AwkError) return fail(`awk: syntax error: ${e.message}\n`, 1);
        throw e;
    }

    const ctx = new Ctx(interp, stdin, program.functions);
    ctx.mainInput = new MainInput(ctx, opts.operands);
    if (opts.fs !== null) ctx.fs = interpretFsFlag(opts.fs);
    const ofKind = (kind) => program.rules.filter((r) => r.pattern.kind === kind);
    const mains = program.rules.filter((r) => r.pattern.kind !== "begin" && r.pattern.kind !== "end");
    const ends = ofKind("end");

    try {
        for (const [k, v] of opts.assignments) ctx.setVar(k, vStrNum(v));
        let flow = runSpecial(ctx, ofKind("begin"));
        // exit in BEGIN skips the input but END still runs.
        if (flow !== "exit" && (mains.length > 0 || ends.length > 0)) {
            while (flow !== "exit") {
                const record = ctx.mainInput.next();
                if (record === null) break;
                ctx.setRecord(record);
                flow = runRecord(ctx, mains);
                if (flow === "nextfile") ctx.mainInput.skipFile();
            }
        }
        runSpecial(ctx, ends);
        ctx.closeAll();
    } catch (e) {
        if (e instanceof AwkError) return { stdout: ctx.stdout, stderr: `${ctx.stderr}awk: ${e.message}\n`, exitCode: 2 };
        throw e;
    }
    return { stdout: ctx.stdout, stderr: ctx.stderr, exitCode: ctx.exitCode ?? 0 };
}
