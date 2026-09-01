// Hand-written recursive-descent parser for the just-bash-rs grammar subset:
// statements joined by &&/||/;, pipelines, simple commands with prefix
// assignments and redirections, if/for/c-style-for/while/until/case/group/
// subshell compound commands, and words built from literal/quoted/variable/
// command-substitution/arithmetic parts. No [[ ]], function definitions,
// arrays, or background jobs (matches the bash tool's advertised subset).

export class ParseError extends Error {}

const KEYWORDS = new Set([
    "if", "then", "elif", "else", "fi",
    "for", "in", "do", "done",
    "while", "until",
    "case", "esac",
]);

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/;
const SPECIAL_PARAM_RE = /^[?#@*$!0-9-]/;

export function parseScript(src) {
    const p = new Parser(src);
    const script = p.parseStatementList(new Set());
    p.skipSeparators();
    if (!p.eof()) {
        throw new ParseError(`unexpected token near: ${p.text.slice(p.pos, p.pos + 20)}`);
    }
    return { statements: script };
}

class Parser {
    constructor(text) {
        this.text = text;
        this.pos = 0;
    }

    eof() {
        return this.pos >= this.text.length;
    }

    peekCh(offset = 0) {
        return this.text[this.pos + offset];
    }

    // Whitespace (not newline) and comments, but not statement separators.
    skipInlineWs() {
        while (!this.eof()) {
            const ch = this.peekCh();
            if (ch === " " || ch === "\t") {
                this.pos++;
            } else if (ch === "\\" && this.peekCh(1) === "\n") {
                this.pos += 2;
            } else if (ch === "#" && this.atWordBoundary()) {
                while (!this.eof() && this.peekCh() !== "\n") this.pos++;
            } else {
                break;
            }
        }
    }

    atWordBoundary() {
        const prev = this.text[this.pos - 1];
        return prev === undefined || prev === " " || prev === "\t" || prev === "\n" || prev === ";" || prev === "|" || prev === "&" || prev === "(";
    }

    // Whitespace, comments, newlines, and redundant `;` — used between
    // statements.
    skipSeparators() {
        while (!this.eof()) {
            this.skipInlineWs();
            const ch = this.peekCh();
            if (ch === "\n" || ch === ";") {
                this.pos++;
            } else {
                break;
            }
        }
    }

    peekKeyword() {
        this.skipInlineWs();
        const m = IDENT_RE.exec(this.text.slice(this.pos));
        if (!m || !KEYWORDS.has(m[0])) return null;
        return m[0];
    }

    consumeKeyword(word) {
        this.skipInlineWs();
        const m = IDENT_RE.exec(this.text.slice(this.pos));
        if (!m || m[0] !== word) throw new ParseError(`expected '${word}'`);
        this.pos += word.length;
    }

    // A statement list runs until EOF or one of `stopKeywords` (checked at
    // command position) is seen.
    parseStatementList(stopKeywords) {
        const statements = [];
        this.skipSeparators();
        while (!this.eof()) {
            const kw = this.peekKeyword();
            if (kw && stopKeywords.has(kw)) break;
            // `)` closes a subshell/command-substitution list, and a
            // standalone `}` closes a group — neither can start a statement,
            // so treat them as implicit list terminators too.
            if (this.peekCh() === ")") break;
            if (this.isStandaloneWord("}")) break;
            const before = this.pos;
            statements.push(this.parseStatement());
            if (this.pos === before) throw new ParseError(`stuck parsing near: ${this.text.slice(this.pos, this.pos + 20)}`);
            this.skipSeparators();
        }
        return statements;
    }

    parseStatement() {
        const pipelines = [this.parsePipeline()];
        const operators = [];
        while (true) {
            this.skipInlineWs();
            if (this.text.startsWith("&&", this.pos)) {
                this.pos += 2;
                operators.push("and");
                this.skipSeparators();
                pipelines.push(this.parsePipeline());
            } else if (this.text.startsWith("||", this.pos)) {
                this.pos += 2;
                operators.push("or");
                this.skipSeparators();
                pipelines.push(this.parsePipeline());
            } else {
                break;
            }
        }
        this.skipInlineWs();
        let background = false;
        if (this.peekCh() === "&" && this.peekCh(1) !== "&") {
            background = true;
            this.pos++;
        }
        return { pipelines, operators, background };
    }

    parsePipeline() {
        this.skipInlineWs();
        let negated = false;
        while (this.peekCh() === "!" && (this.peekCh(1) === " " || this.peekCh(1) === "\t" || this.peekCh(1) === "\n")) {
            negated = !negated;
            this.pos++;
            this.skipInlineWs();
        }
        const commands = [this.parseCommand()];
        while (true) {
            this.skipInlineWs();
            if (this.peekCh() === "|" && this.peekCh(1) !== "|") {
                this.pos++;
                this.skipSeparators();
                commands.push(this.parseCommand());
            } else break;
        }
        return { commands, negated };
    }

    parseCommand() {
        this.skipInlineWs();
        if (this.peekCh() === "(") {
            this.pos++;
            const body = this.parseStatementList(new Set());
            this.skipSeparators();
            this.expectChar(")");
            return { kind: "compound", compound: { type: "subshell", body } };
        }
        if (this.isStandaloneWord("{")) {
            this.pos += 1;
            const body = this.parseStatementList(new Set());
            this.skipSeparators();
            if (!this.isStandaloneWord("}")) throw new ParseError("expected '}'");
            this.pos += 1;
            return { kind: "compound", compound: { type: "group", body } };
        }
        const kw = this.peekKeyword();
        if (kw === "if") return { kind: "compound", compound: this.parseIf() };
        if (kw === "for") return { kind: "compound", compound: this.parseFor() };
        if (kw === "while") return { kind: "compound", compound: this.parseWhile(false) };
        if (kw === "until") return { kind: "compound", compound: this.parseWhile(true) };
        if (kw === "case") return { kind: "compound", compound: this.parseCase() };
        return this.parseSimpleCommand();
    }

    isStandaloneWord(word) {
        this.skipInlineWs();
        if (!this.text.startsWith(word, this.pos)) return false;
        const after = this.text[this.pos + word.length];
        return after === undefined || after === " " || after === "\t" || after === "\n" || after === ";" || after === "|" || after === "&";
    }

    expectChar(ch) {
        this.skipInlineWs();
        if (this.peekCh() !== ch) throw new ParseError(`expected '${ch}'`);
        this.pos++;
    }

    parseIf() {
        this.consumeKeyword("if");
        const cond = this.parseStatementList(new Set(["then"]));
        this.consumeKeyword("then");
        const body = this.parseStatementList(new Set(["elif", "else", "fi"]));
        const elifs = [];
        while (this.peekKeyword() === "elif") {
            this.consumeKeyword("elif");
            const elifCond = this.parseStatementList(new Set(["then"]));
            this.consumeKeyword("then");
            const elifBody = this.parseStatementList(new Set(["elif", "else", "fi"]));
            elifs.push([elifCond, elifBody]);
        }
        let elseBody = null;
        if (this.peekKeyword() === "else") {
            this.consumeKeyword("else");
            elseBody = this.parseStatementList(new Set(["fi"]));
        }
        this.consumeKeyword("fi");
        return { type: "if", cond, body, elifs, elseBody };
    }

    parseFor() {
        this.consumeKeyword("for");
        this.skipInlineWs();
        if (this.text.startsWith("((", this.pos)) {
            this.pos += 2;
            const init = this.readArithUntil(";");
            this.expectChar(";");
            const cond = this.readArithUntil(";");
            this.expectChar(";");
            const update = this.readArithUntil(")");
            this.expectChar(")");
            this.expectChar(")");
            this.skipSeparators();
            const body = this.parseDoBlock();
            return { type: "cstylefor", init, cond, update, body };
        }
        const name = this.readIdentifier();
        this.skipInlineWs();
        let items = [];
        if (this.peekKeyword() === "in") {
            this.consumeKeyword("in");
            items = this.readWordList();
        }
        this.skipSeparators();
        const body = this.parseDoBlock();
        return { type: "for", name, items, body };
    }

    readArithUntil(stopCh) {
        this.skipInlineWs();
        let depth = 0;
        const start = this.pos;
        while (!this.eof()) {
            const ch = this.peekCh();
            if (ch === "(") depth++;
            if (ch === ")") { if (depth === 0) break; depth--; }
            if (ch === stopCh && depth === 0) break;
            this.pos++;
        }
        const text = this.text.slice(start, this.pos).trim();
        return text.length ? text : null;
    }

    parseDoBlock() {
        this.consumeKeyword("do");
        const body = this.parseStatementList(new Set(["done"]));
        this.consumeKeyword("done");
        return body;
    }

    parseWhile(until) {
        this.consumeKeyword(until ? "until" : "while");
        const cond = this.parseStatementList(new Set(["do"]));
        const body = this.parseDoBlock();
        return { type: "while", cond, body, until };
    }

    parseCase() {
        this.consumeKeyword("case");
        const subject = this.readWord();
        this.skipInlineWs();
        this.consumeKeyword("in");
        this.skipSeparators();
        const arms = [];
        while (this.peekKeyword() !== "esac") {
            this.skipInlineWs();
            if (this.peekCh() === "(") this.pos++;
            const patterns = [this.readWord()];
            this.skipInlineWs();
            while (this.peekCh() === "|") {
                this.pos++;
                patterns.push(this.readWord());
                this.skipInlineWs();
            }
            this.expectChar(")");
            const body = this.parseCaseBody();
            arms.push({ patterns, body });
        }
        this.consumeKeyword("esac");
        return { type: "case", subject, arms };
    }

    // Like skipSeparators, but a lone `;` is a statement separator while `;;`
    // is the arm terminator and must be left for the caller to consume.
    skipCaseSeparators() {
        while (!this.eof()) {
            this.skipInlineWs();
            const ch = this.peekCh();
            if (ch === "\n") { this.pos++; continue; }
            if (ch === ";" && this.peekCh(1) !== ";") { this.pos++; continue; }
            break;
        }
    }

    parseCaseBody() {
        this.skipCaseSeparators();
        const statements = [];
        while (!this.eof()) {
            this.skipInlineWs();
            if (this.text.startsWith(";;", this.pos)) {
                this.pos += 2;
                break;
            }
            if (this.peekKeyword() === "esac") break;
            const before = this.pos;
            statements.push(this.parseStatement());
            if (this.pos === before) throw new ParseError(`stuck parsing case body near: ${this.text.slice(this.pos, this.pos + 20)}`);
            this.skipCaseSeparators();
            if (this.text.startsWith(";;", this.pos)) {
                this.pos += 2;
                break;
            }
        }
        this.skipSeparators();
        return statements;
    }

    parseSimpleCommand() {
        const assignments = [];
        const words = [];
        const redirects = [];
        while (true) {
            this.skipInlineWs();
            if (this.eof()) break;
            const redirect = this.tryReadRedirect();
            if (redirect) {
                redirects.push(redirect);
                continue;
            }
            if (this.isStatementBoundary()) break;
            if (words.length === 0) {
                const assignment = this.tryReadAssignment();
                if (assignment) {
                    assignments.push(assignment);
                    continue;
                }
            }
            words.push(this.readWord());
        }
        this.drainHeredocs(redirects);
        return { kind: "simple", assignments, words, redirects };
    }

    isStatementBoundary() {
        const ch = this.peekCh();
        if (ch === undefined || ch === "\n" || ch === ";" || ch === "(" || ch === ")") return true;
        if (ch === "&") return true;
        if (ch === "|") return true;
        return false;
    }

    tryReadAssignment() {
        const start = this.pos;
        const m = IDENT_RE.exec(this.text.slice(this.pos));
        if (!m) return null;
        const after = this.text[this.pos + m[0].length];
        if (after !== "=") return null;
        this.pos += m[0].length + 1;
        const value = this.readWord();
        return { name: m[0], value };
    }

    tryReadRedirect() {
        const start = this.pos;
        const digitMatch = /^[0-9]*/.exec(this.text.slice(this.pos));
        const digits = digitMatch[0];
        const after = this.text.slice(this.pos + digits.length);
        let kind, opLen, isDup = false, isHeredoc = false, stripTabs = false, defaultFd;
        if (after.startsWith("<<-")) { isHeredoc = true; stripTabs = true; opLen = 3; defaultFd = 0; }
        else if (after.startsWith("<<<")) { kind = "here-string"; opLen = 3; defaultFd = 0; }
        else if (after.startsWith("<<")) { isHeredoc = true; opLen = 2; defaultFd = 0; }
        else if (after.startsWith(">>")) { kind = "append"; opLen = 2; defaultFd = 1; }
        else if (after.startsWith(">&")) { isDup = true; opLen = 2; defaultFd = 1; }
        else if (after.startsWith("<&")) { isDup = true; opLen = 2; defaultFd = 0; }
        else if (after.startsWith(">")) { kind = "write"; opLen = 1; defaultFd = 1; }
        else if (after.startsWith("<")) { kind = "read"; opLen = 1; defaultFd = 0; }
        else return null;
        if (digits === "" && after[0] !== "<" && after[0] !== ">") return null;
        const fd = digits === "" ? defaultFd : parseInt(digits, 10);
        this.pos += digits.length + opLen;
        this.skipInlineWs();
        if (isDup) {
            const m = /^[0-9]+/.exec(this.text.slice(this.pos));
            if (m) {
                this.pos += m[0].length;
                return { fd, kind: fd === 0 ? "read" : "write", target: { type: "dup", fd: parseInt(m[0], 10) } };
            }
            if (this.peekCh() === "-") {
                this.pos++;
                return { fd, kind: fd === 0 ? "read" : "write", target: { type: "dup", fd: -1 } };
            }
            const word = this.readWord();
            return { fd, kind: fd === 0 ? "read" : "write", target: { type: "file", word } };
        }
        if (isHeredoc) {
            const word = this.readWord();
            return { fd, kind: "read", target: { type: "heredoc", word, stripTabs } };
        }
        if (kind === "here-string") {
            const word = this.readWord();
            return { fd, kind: "read", target: { type: "herestring", word } };
        }
        const word = this.readWord();
        return { fd, kind, target: { type: "file", word } };
    }

    // After the current logical line is fully parsed, fill in heredoc bodies
    // registered via `<<`/`<<-` from the following source lines.
    drainHeredocs(redirects) {
        const pending = redirects.filter((r) => r.target.type === "heredoc" && r.target.body === undefined);
        if (pending.length === 0) return;
        // Heredocs are read starting at the next newline in source order.
        if (this.peekCh() !== "\n" && !this.eof()) {
            // Redirect parsing may have stopped right before `;`/`&&` etc.; skip
            // to end of this physical line before collecting bodies, matching
            // bash's "rest of the line is the heredoc marker line" rule closely
            // enough for the scripts this interpreter targets.
        }
        let lineEnd = this.text.indexOf("\n", this.pos);
        if (lineEnd === -1) lineEnd = this.text.length;
        this.pos = lineEnd;
        for (const redirect of pending) {
            if (this.peekCh() === "\n") this.pos++;
            const delimiterWord = redirect.target.word;
            const { text: delimiter, quoted } = literalWordText(delimiterWord);
            const lines = [];
            while (!this.eof()) {
                const nextNl = this.text.indexOf("\n", this.pos);
                const line = nextNl === -1 ? this.text.slice(this.pos) : this.text.slice(this.pos, nextNl);
                const compare = redirect.target.stripTabs ? line.replace(/^\t+/, "") : line;
                if (compare === delimiter) {
                    this.pos = nextNl === -1 ? this.text.length : nextNl + 1;
                    break;
                }
                lines.push(redirect.target.stripTabs ? line.replace(/^\t+/, "") : line);
                if (nextNl === -1) { this.pos = this.text.length; break; }
                this.pos = nextNl + 1;
            }
            const body = lines.length ? lines.join("\n") + "\n" : "";
            redirect.target.body = quoted ? [{ type: "quoted", text: body }] : parseInterpolatedText(body);
        }
    }

    readWordList() {
        const words = [];
        while (true) {
            this.skipInlineWs();
            if (this.isStatementBoundary()) break;
            if (this.peekKeyword() === "do") break;
            words.push(this.readWord());
        }
        return words;
    }

    readIdentifier() {
        this.skipInlineWs();
        const m = IDENT_RE.exec(this.text.slice(this.pos));
        if (!m) throw new ParseError("expected identifier");
        this.pos += m[0].length;
        return m[0];
    }

    readWord() {
        this.skipInlineWs();
        const parts = [];
        let literal = "";
        const flush = () => {
            if (literal) { parts.push({ type: "literal", text: literal }); literal = ""; }
        };
        while (!this.eof()) {
            const ch = this.peekCh();
            if (ch === " " || ch === "\t" || ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")" || ch === "<" || ch === ">") {
                break;
            }
            if (ch === "'") {
                flush();
                this.pos++;
                const start = this.pos;
                while (!this.eof() && this.peekCh() !== "'") this.pos++;
                parts.push({ type: "quoted", text: this.text.slice(start, this.pos) });
                if (this.eof()) throw new ParseError("unterminated single quote");
                this.pos++;
                continue;
            }
            if (ch === '"') {
                this.pos++;
                flush();
                const inner = this.readDoubleQuoted();
                for (const part of inner) parts.push(part);
                continue;
            }
            if (ch === "\\") {
                if (this.peekCh(1) === "\n") { this.pos += 2; continue; }
                flush();
                this.pos++;
                if (!this.eof()) { parts.push({ type: "quoted", text: this.peekCh() }); this.pos++; }
                continue;
            }
            if (ch === "$") {
                flush();
                const part = this.readDollar(false);
                if (part) { parts.push(part); continue; }
                literal += "$";
                this.pos++;
                continue;
            }
            if (ch === "`") {
                flush();
                parts.push(this.readBacktick(false));
                continue;
            }
            literal += ch;
            this.pos++;
        }
        flush();
        if (parts.length === 0) return [{ type: "literal", text: "" }];
        return parts;
    }

    readDoubleQuoted() {
        const parts = [];
        let literal = "";
        const flush = () => {
            if (literal) { parts.push({ type: "quoted", text: literal }); literal = ""; }
        };
        while (!this.eof() && this.peekCh() !== '"') {
            const ch = this.peekCh();
            if (ch === "\\" && '"\\$`\n'.includes(this.peekCh(1) ?? "")) {
                if (this.peekCh(1) === "\n") { this.pos += 2; continue; }
                literal += this.peekCh(1);
                this.pos += 2;
                continue;
            }
            if (ch === "$") {
                flush();
                const part = this.readDollar(true);
                if (part) { parts.push(part); continue; }
                literal += "$";
                this.pos++;
                continue;
            }
            if (ch === "`") {
                flush();
                parts.push(this.readBacktick(true));
                continue;
            }
            literal += ch;
            this.pos++;
        }
        flush();
        if (this.eof()) throw new ParseError("unterminated double quote");
        this.pos++;
        if (parts.length === 0) return [{ type: "quoted", text: "" }];
        return parts;
    }

    // Called with `this.pos` at `$`. Returns a WordPart or null if `$` was
    // not followed by a recognized expansion (caller emits a literal `$`).
    readDollar(quoted) {
        const next = this.peekCh(1);
        if (next === "(" && this.peekCh(2) === "(") {
            this.pos += 3;
            const start = this.pos;
            let depth = 0;
            while (!this.eof()) {
                if (this.text.startsWith("))", this.pos) && depth === 0) break;
                if (this.peekCh() === "(") depth++;
                if (this.peekCh() === ")") depth--;
                this.pos++;
            }
            const expr = this.text.slice(start, this.pos);
            if (!this.text.startsWith("))", this.pos)) throw new ParseError("unterminated arithmetic expansion");
            this.pos += 2;
            return { type: "arith", expr, quoted };
        }
        if (next === "(") {
            this.pos += 2;
            const start = this.pos;
            let depth = 1;
            while (!this.eof() && depth > 0) {
                const ch = this.peekCh();
                if (ch === "(") depth++;
                else if (ch === ")") { depth--; if (depth === 0) break; }
                else if (ch === "'") { this.pos++; while (!this.eof() && this.peekCh() !== "'") this.pos++; }
                else if (ch === '"') { this.pos++; while (!this.eof() && !(this.peekCh() === '"' && this.text[this.pos-1] !== "\\")) this.pos++; }
                this.pos++;
            }
            const script = this.text.slice(start, this.pos);
            if (this.peekCh() !== ")") throw new ParseError("unterminated command substitution");
            this.pos++;
            return { type: "cmdsub", script: parseScript(script), quoted };
        }
        if (next === "{") {
            this.pos += 2;
            const start = this.pos;
            let depth = 1;
            while (!this.eof() && depth > 0) {
                const ch = this.peekCh();
                if (ch === "{") depth++;
                else if (ch === "}") { depth--; if (depth === 0) break; }
                this.pos++;
            }
            const body = this.text.slice(start, this.pos);
            if (this.peekCh() !== "}") throw new ParseError("unterminated parameter expansion");
            this.pos++;
            return parseBraceParam(body, quoted);
        }
        if (next !== undefined && SPECIAL_PARAM_RE.test(next) && !/[A-Za-z_]/.test(next)) {
            this.pos += 2;
            return { type: "var", name: next, quoted, op: null, arg: null };
        }
        const m = IDENT_RE.exec(this.text.slice(this.pos + 1));
        if (m) {
            this.pos += 1 + m[0].length;
            return { type: "var", name: m[0], quoted, op: null, arg: null };
        }
        return null;
    }

    readBacktick(quoted) {
        this.pos++;
        const start = this.pos;
        let raw = "";
        while (!this.eof() && this.peekCh() !== "`") {
            if (this.peekCh() === "\\" && (this.peekCh(1) === "`" || this.peekCh(1) === "\\" || this.peekCh(1) === "$")) {
                raw += this.peekCh(1);
                this.pos += 2;
                continue;
            }
            raw += this.peekCh();
            this.pos++;
        }
        if (this.eof()) throw new ParseError("unterminated backtick substitution");
        this.pos++;
        return { type: "cmdsub", script: parseScript(raw), quoted };
    }
}

function literalWordText(word) {
    let text = "";
    let quoted = false;
    for (const part of word) {
        if (part.type === "literal") text += part.text;
        else if (part.type === "quoted") { text += part.text; quoted = true; }
        else text += "";
    }
    return { text, quoted };
}

// Parse heredoc-body-style interpolated text (variables/command-subs/arith
// expand, no field splitting or globbing) into word parts, reusing the
// double-quote scanner by wrapping the text as if already inside quotes.
function parseInterpolatedText(text) {
    const p = new Parser(`"${text.replace(/"/g, '\\"')}"`);
    p.pos = 1;
    return p.readDoubleQuoted();
}

const PARAM_OP_RE = /^(:-|:=|:\+|:\?|-|=|\+|\?|##|#|%%|%)/;

function parseBraceParam(body, quoted) {
    if (body.startsWith("#") && body.length > 1 && !PARAM_OP_RE.test(body.slice(1))) {
        return { type: "var", name: body.slice(1), quoted, op: "len", arg: null };
    }
    const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*|[0-9]+|[?#@*$!-])/.exec(body);
    if (!nameMatch) {
        return { type: "var", name: body, quoted, op: null, arg: null };
    }
    const name = nameMatch[0];
    const rest = body.slice(name.length);
    if (rest === "") return { type: "var", name, quoted, op: null, arg: null };
    const opMatch = PARAM_OP_RE.exec(rest);
    if (!opMatch) return { type: "var", name, quoted, op: null, arg: null };
    const op = opMatch[0];
    const argText = rest.slice(op.length);
    const arg = argText.length ? parseInterpolatedText(argText) : [];
    return { type: "var", name, quoted, op, arg };
}
