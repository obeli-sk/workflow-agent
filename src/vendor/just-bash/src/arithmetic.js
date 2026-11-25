// Bash arithmetic expressions: $(( expr )), (( expr )), array/loop headers.
// Integers only, evaluated with BigInt for correct 64-bit-ish shift/bitwise
// behavior; results are converted back to Number-range strings on output.

class ArithError extends Error {}

class Scanner {
    constructor(text) {
        this.text = text;
        this.pos = 0;
    }
    skipWs() {
        while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
    }
    peek(n = 0) {
        return this.text[this.pos + n];
    }
    startsWith(s) {
        return this.text.startsWith(s, this.pos);
    }
    eof() {
        this.skipWs();
        return this.pos >= this.text.length;
    }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

export class Arith {
    constructor(text, vars) {
        this.s = new Scanner(text);
        this.getVar = vars.getVar;
        this.setVar = vars.setVar;
    }

    evaluate() {
        this.s.skipWs();
        if (this.s.eof()) return 0n;
        const value = this.parseComma();
        this.s.skipWs();
        if (this.s.pos < this.s.text.length) {
            throw new ArithError(`syntax error near ${this.s.text.slice(this.s.pos)}`);
        }
        return value;
    }

    numOf(name) {
        const raw = this.getVar(name);
        if (raw === undefined || raw === "") return 0n;
        if (IDENT_START.test(raw[0] ?? "")) {
            // bash allows a variable's value to itself be a variable name
            return this.readVarValue(raw);
        }
        try {
            return this.parseLiteralText(raw);
        } catch {
            return 0n;
        }
    }

    readVarValue(name) {
        const raw = this.getVar(name);
        if (raw === undefined || raw === "") return 0n;
        try {
            return this.parseLiteralText(raw);
        } catch {
            return 0n;
        }
    }

    parseLiteralText(text) {
        const sub = new Arith(text, { getVar: this.getVar, setVar: this.setVar });
        return sub.evaluate();
    }

    parseComma() {
        let value = this.parseAssign();
        while (true) {
            this.s.skipWs();
            if (this.s.peek() === "," ) {
                this.s.pos++;
                value = this.parseAssign();
            } else break;
        }
        return value;
    }

    parseAssign() {
        const start = this.s.pos;
        this.s.skipWs();
        const name = this.tryIdent();
        if (name) {
            this.s.skipWs();
            const ops = ["+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", "="];
            for (const op of ops) {
                if (this.s.startsWith(op) && this.s.peek(op.length) !== "=") {
                    this.s.pos += op.length;
                    const rhs = this.parseAssign();
                    const cur = () => this.numOf(name);
                    let result;
                    switch (op) {
                        case "=": result = rhs; break;
                        case "+=": result = cur() + rhs; break;
                        case "-=": result = cur() - rhs; break;
                        case "*=": result = cur() * rhs; break;
                        case "/=": result = intDiv(cur(), rhs); break;
                        case "%=": result = intMod(cur(), rhs); break;
                        case "&=": result = cur() & rhs; break;
                        case "|=": result = cur() | rhs; break;
                        case "^=": result = cur() ^ rhs; break;
                        case "<<=": result = cur() << rhs; break;
                        case ">>=": result = cur() >> rhs; break;
                    }
                    this.setVar(name, result.toString());
                    return result;
                }
            }
        }
        this.s.pos = start;
        return this.parseTernary();
    }

    tryIdent() {
        this.s.skipWs();
        const start = this.s.pos;
        if (!IDENT_START.test(this.s.peek() ?? "")) return null;
        let end = start;
        while (end < this.s.text.length && IDENT_PART.test(this.s.text[end])) end++;
        this.s.pos = end;
        return this.s.text.slice(start, end);
    }

    parseTernary() {
        const cond = this.parseLogicalOr();
        this.s.skipWs();
        if (this.s.peek() === "?") {
            this.s.pos++;
            const whenTrue = this.parseAssign();
            this.s.skipWs();
            if (this.s.peek() !== ":") throw new ArithError("expected ':'");
            this.s.pos++;
            const whenFalse = this.parseAssign();
            return truthy(cond) ? whenTrue : whenFalse;
        }
        return cond;
    }

    parseLogicalOr() {
        let value = this.parseLogicalAnd();
        while (true) {
            this.s.skipWs();
            if (this.s.startsWith("||")) {
                this.s.pos += 2;
                const rhs = this.parseLogicalAnd();
                value = bi(truthy(value) || truthy(rhs));
            } else break;
        }
        return value;
    }

    parseLogicalAnd() {
        let value = this.parseBitOr();
        while (true) {
            this.s.skipWs();
            if (this.s.startsWith("&&")) {
                this.s.pos += 2;
                const rhs = this.parseBitOr();
                value = bi(truthy(value) && truthy(rhs));
            } else break;
        }
        return value;
    }

    parseBitOr() {
        let value = this.parseBitXor();
        while (true) {
            this.s.skipWs();
            if (this.s.peek() === "|" && this.s.peek(1) !== "|") {
                this.s.pos++;
                value = value | this.parseBitXor();
            } else break;
        }
        return value;
    }

    parseBitXor() {
        let value = this.parseBitAnd();
        while (true) {
            this.s.skipWs();
            if (this.s.peek() === "^") {
                this.s.pos++;
                value = value ^ this.parseBitAnd();
            } else break;
        }
        return value;
    }

    parseBitAnd() {
        let value = this.parseEquality();
        while (true) {
            this.s.skipWs();
            if (this.s.peek() === "&" && this.s.peek(1) !== "&") {
                this.s.pos++;
                value = value & this.parseEquality();
            } else break;
        }
        return value;
    }

    parseEquality() {
        let value = this.parseRelational();
        while (true) {
            this.s.skipWs();
            if (this.s.startsWith("==")) {
                this.s.pos += 2;
                value = bi(value === this.parseRelational());
            } else if (this.s.startsWith("!=")) {
                this.s.pos += 2;
                value = bi(value !== this.parseRelational());
            } else break;
        }
        return value;
    }

    parseRelational() {
        let value = this.parseShift();
        while (true) {
            this.s.skipWs();
            if (this.s.startsWith("<=")) { this.s.pos += 2; value = bi(value <= this.parseShift()); }
            else if (this.s.startsWith(">=")) { this.s.pos += 2; value = bi(value >= this.parseShift()); }
            else if (this.s.peek() === "<" && this.s.peek(1) !== "<") { this.s.pos++; value = bi(value < this.parseShift()); }
            else if (this.s.peek() === ">" && this.s.peek(1) !== ">") { this.s.pos++; value = bi(value > this.parseShift()); }
            else break;
        }
        return value;
    }

    parseShift() {
        let value = this.parseAdditive();
        while (true) {
            this.s.skipWs();
            if (this.s.startsWith("<<")) { this.s.pos += 2; value = value << this.parseAdditive(); }
            else if (this.s.startsWith(">>")) { this.s.pos += 2; value = value >> this.parseAdditive(); }
            else break;
        }
        return value;
    }

    parseAdditive() {
        let value = this.parseMultiplicative();
        while (true) {
            this.s.skipWs();
            if (this.s.peek() === "+" && this.s.peek(1) !== "+") { this.s.pos++; value = value + this.parseMultiplicative(); }
            else if (this.s.peek() === "-" && this.s.peek(1) !== "-") { this.s.pos++; value = value - this.parseMultiplicative(); }
            else break;
        }
        return value;
    }

    parseMultiplicative() {
        let value = this.parseExponent();
        while (true) {
            this.s.skipWs();
            if (this.s.peek() === "*" && this.s.peek(1) !== "*") { this.s.pos++; value = value * this.parseExponent(); }
            else if (this.s.peek() === "/") { this.s.pos++; value = intDiv(value, this.parseExponent()); }
            else if (this.s.peek() === "%") { this.s.pos++; value = intMod(value, this.parseExponent()); }
            else break;
        }
        return value;
    }

    parseExponent() {
        const base = this.parseUnary();
        this.s.skipWs();
        if (this.s.startsWith("**")) {
            this.s.pos += 2;
            const exp = this.parseExponent();
            return exp < 0n ? 0n : base ** exp;
        }
        return base;
    }

    parseUnary() {
        this.s.skipWs();
        if (this.s.startsWith("++")) {
            this.s.pos += 2;
            const name = this.tryIdent();
            if (!name) throw new ArithError("expected identifier after ++");
            const next = this.numOf(name) + 1n;
            this.setVar(name, next.toString());
            return next;
        }
        if (this.s.startsWith("--")) {
            this.s.pos += 2;
            const name = this.tryIdent();
            if (!name) throw new ArithError("expected identifier after --");
            const next = this.numOf(name) - 1n;
            this.setVar(name, next.toString());
            return next;
        }
        if (this.s.peek() === "+") { this.s.pos++; return this.parseUnary(); }
        if (this.s.peek() === "-") { this.s.pos++; return -this.parseUnary(); }
        if (this.s.peek() === "!") { this.s.pos++; return bi(!truthy(this.parseUnary())); }
        if (this.s.peek() === "~") { this.s.pos++; return ~this.parseUnary(); }
        return this.parsePostfix();
    }

    parsePostfix() {
        const value = this.parsePrimary();
        this.s.skipWs();
        if (this.s.startsWith("++") && this._lastWasIdent) {
            this.s.pos += 2;
            this.setVar(this._lastIdent, (value + 1n).toString());
            return value;
        }
        if (this.s.startsWith("--") && this._lastWasIdent) {
            this.s.pos += 2;
            this.setVar(this._lastIdent, (value - 1n).toString());
            return value;
        }
        return value;
    }

    parsePrimary() {
        this.s.skipWs();
        this._lastWasIdent = false;
        if (this.s.peek() === "(") {
            this.s.pos++;
            const value = this.parseComma();
            this.s.skipWs();
            if (this.s.peek() !== ")") throw new ArithError("expected ')'");
            this.s.pos++;
            return value;
        }
        const numStart = this.s.pos;
        const numMatch = /^0[xX][0-9a-fA-F]+|^0[0-7]+|^[0-9]+/.exec(this.s.text.slice(numStart));
        if (numMatch) {
            this.s.pos += numMatch[0].length;
            return parseIntLiteral(numMatch[0]);
        }
        const name = this.tryIdent();
        if (name) {
            this._lastWasIdent = true;
            this._lastIdent = name;
            return this.numOf(name);
        }
        throw new ArithError(`syntax error near ${this.s.text.slice(this.s.pos)}`);
    }
}

function parseIntLiteral(text) {
    if (/^0[xX]/.test(text)) return BigInt(text);
    if (/^0[0-7]+$/.test(text)) return BigInt(parseInt(text, 8));
    return BigInt(text);
}

function bi(cond) {
    return cond ? 1n : 0n;
}

function truthy(value) {
    return value !== 0n;
}

function intDiv(a, b) {
    if (b === 0n) throw new ArithError("division by 0");
    return a / b;
}

function intMod(a, b) {
    if (b === 0n) throw new ArithError("division by 0");
    return a % b;
}

// Evaluate an arithmetic expression string; returns a decimal string.
export function evalArith(text, vars) {
    return new Arith(text, vars).evaluate().toString();
}

export { ArithError };
