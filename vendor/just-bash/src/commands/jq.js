// PORT (partial): vendor/just-bash-rs/src/commands/jq.rs
//
// A practical subset of jq, matching the Rust port's own scope (see that
// file's top-of-file doc comment): not full upstream jq fidelity. Hand-
// rolled scanner/recursive-descent parser producing a plain-object Filter
// AST, evaluated directly over parsed JSON values (JS null/boolean/number/
// string/Array/plain-object).
//
// Supported: identity `.`, field access `.foo`/`.foo.bar` (with `?` after
// any postfix step), `.[0]`/`.foo[0]` indexing (negative indices), `.[]`
// iteration, `.[a:b]` slicing (arrays and strings), `|` and `,`, object
// construction `{a: .b, c, (.k): .v}`, array construction `[...]`, string
// interpolation `"\(expr)"`, `if/then/elif/else/end`, the `//` alternative
// operator, `and`/`or`, comparisons `== != < <= > >=` (jq's typed ordering:
// null < bool < number < string < array < object), arithmetic `+ - * / %`
// with jq's per-type rules (string/array concat, shallow object merge on
// `+`, deep merge on `*` of two objects, string split on `/`), literals, the
// `@tsv` formatter, and the builtins `length keys keys_unsorted has empty
// not type select map add range floor ceil round sqrt abs tostring tonumber
// fromjson tojson split join`. CLI flags: -r/-R/-c/-n/-s/-e/-S, with their
// long forms (--raw-output/--raw-input/--compact-output/--null-input/
// --slurp/--exit-status/--sort-keys), plus --arg/--argjson/--rawfile/
// --slurpfile/--args/--jsonargs.
//
// External-argument variables: $NAME resolves an argument bound via --arg/
// --argjson/--rawfile/--slurpfile, or the builtin $ARGS ({positional, named})
// populated by those plus --args/--jsonargs. This is only the external-
// binding surface, not general variable binding: "... as $x |" still isn't
// supported (nowhere to introduce a new binding mid-filter), so $NAME is a
// lookup into the fixed external-argument map threaded through evaluate(),
// never a pattern target.
//
// Explicitly out of scope (matches the Rust port's scope): reduce/foreach,
// custom def, try/catch (bare `?` is supported, full try is not),
// path()/paths, "... as $x |" binding, @base64/@csv-style format strings
// other than @tsv, module imports, input/inputs streaming, regex builtins
// (test/match/sub/gsub/capture), and resource limits.
//
// Value representation note: jq objects are represented as plain JS
// objects, so a key that looks like an array index (e.g. "0", "1") will be
// reordered by the JS engine's own property-enumeration rules instead of
// preserving insertion order, unlike the Rust port's IndexMap-backed
// serde_json::Map. This is a narrow, known divergence, not expected to
// matter for realistic agent-shell JSON (config, counts, ids), so it is
// left as-is rather than reimplementing jq objects atop a Map to sidestep
// it (which would also lose the JSON.stringify-based formatter below).

import { fail, ok } from "./core.js";

class ParseError extends Error {}
class JqError extends Error {}

function isPlainObj(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}

// ============================================================================
// Parser (combined scanner + recursive descent, no separate token pass so
// string interpolation can recurse into the same char cursor)
// ============================================================================

class Parser {
    constructor(src) {
        this.chars = [...src];
        this.pos = 0;
    }

    peek() { return this.chars[this.pos]; }
    peekAt(offset) { return this.chars[this.pos + offset]; }
    eof() { return this.pos >= this.chars.length; }

    skipWs() {
        while (this.pos < this.chars.length && /\s/.test(this.chars[this.pos])) this.pos++;
    }

    startsWith(s) {
        for (let i = 0; i < s.length; i++) {
            if (this.peekAt(i) !== s[i]) return false;
        }
        return true;
    }

    /// Consumes `kw` if it's next (after skipping leading whitespace), also
    /// requiring the following char isn't an identifier char (`and`, `or`).
    eatKeyword(kw) {
        this.skipWs();
        if (this.startsWith(kw)) {
            const after = this.peekAt(kw.length);
            if (!(after !== undefined && /[A-Za-z0-9_]/.test(after))) {
                this.pos += kw.length;
                return true;
            }
        }
        return false;
    }

    eatChar(c) {
        this.skipWs();
        if (this.peek() === c) { this.pos++; return true; }
        return false;
    }

    expectChar(c) {
        if (!this.eatChar(c)) throw new ParseError(`jq: expected '${c}' near position ${this.pos}`);
    }

    // ---- top-level entry ----

    parseProgram() {
        const f = this.parsePipe();
        this.skipWs();
        if (!this.eof()) throw new ParseError(`unexpected trailing input at position ${this.pos}`);
        return f;
    }

    parsePipe() {
        let left = this.parseComma();
        while (this.eatChar("|")) {
            const right = this.parseComma();
            left = { t: "Pipe", l: left, r: right };
        }
        return left;
    }

    parseComma() {
        let left = this.parseAlt();
        while (true) {
            this.skipWs();
            if (this.peek() === ",") {
                this.pos++;
                const right = this.parseAlt();
                left = { t: "Comma", l: left, r: right };
            } else break;
        }
        return left;
    }

    /// Object-value grammar: pipe-chained but comma terminates the pair.
    parseObjValue() {
        let left = this.parseAlt();
        while (true) {
            this.skipWs();
            if (this.peek() === "|") {
                this.pos++;
                const right = this.parseAlt();
                left = { t: "Pipe", l: left, r: right };
            } else break;
        }
        return left;
    }

    parseAlt() {
        let left = this.parseOr();
        while (true) {
            this.skipWs();
            if (this.startsWith("//")) {
                this.pos += 2;
                const right = this.parseOr();
                left = { t: "Alt", l: left, r: right };
            } else break;
        }
        return left;
    }

    parseOr() {
        let left = this.parseAnd();
        while (this.eatKeyword("or")) {
            const right = this.parseAnd();
            left = { t: "Or", l: left, r: right };
        }
        return left;
    }

    parseAnd() {
        let left = this.parseCmp();
        while (this.eatKeyword("and")) {
            const right = this.parseCmp();
            left = { t: "And", l: left, r: right };
        }
        return left;
    }

    parseCmp() {
        const left = this.parseAdd();
        this.skipWs();
        let op = null;
        if (this.startsWith("==")) op = "==";
        else if (this.startsWith("!=")) op = "!=";
        else if (this.startsWith("<=")) op = "<=";
        else if (this.startsWith(">=")) op = ">=";
        else if (this.peek() === "<") op = "<";
        else if (this.peek() === ">") op = ">";
        if (op) {
            this.pos += op.length;
            const right = this.parseAdd();
            return { t: "BinOp", op, l: left, r: right };
        }
        return left;
    }

    parseAdd() {
        let left = this.parseMul();
        while (true) {
            this.skipWs();
            const c = this.peek();
            if (c === "+") { this.pos++; left = { t: "BinOp", op: "+", l: left, r: this.parseMul() }; }
            else if (c === "-") { this.pos++; left = { t: "BinOp", op: "-", l: left, r: this.parseMul() }; }
            else break;
        }
        return left;
    }

    parseMul() {
        let left = this.parseUnary();
        while (true) {
            this.skipWs();
            const c = this.peek();
            if (c === "*") { this.pos++; left = { t: "BinOp", op: "*", l: left, r: this.parseUnary() }; }
            else if (c === "/" && this.peekAt(1) !== "/") { this.pos++; left = { t: "BinOp", op: "/", l: left, r: this.parseUnary() }; }
            else if (c === "%") { this.pos++; left = { t: "BinOp", op: "%", l: left, r: this.parseUnary() }; }
            else break;
        }
        return left;
    }

    parseUnary() {
        this.skipWs();
        if (this.peek() === "-" && !this.startsWith("--")) {
            this.pos++;
            return { t: "Neg", inner: this.parsePostfix() };
        }
        return this.parsePostfix();
    }

    parsePostfix() {
        let base = this.parsePrimary();
        base = this.maybeOptional(base);
        while (true) {
            this.skipWs();
            const c1 = this.peekAt(1);
            if (this.peek() === "." && c1 !== undefined && /[A-Za-z_]/.test(c1)) {
                this.pos++;
                const name = this.readIdent();
                base = { t: "Field", base, name };
            } else if (this.peek() === "." && this.peekAt(1) === "[") {
                this.pos++;
                base = this.parseBracketSuffix(base);
            } else if (this.peek() === "[") {
                base = this.parseBracketSuffix(base);
            } else break;
            // `?` binds to the nearest preceding postfix step.
            base = this.maybeOptional(base);
        }
        return base;
    }

    /// Consumes a trailing `?` (but not `?//`/`?=`, neither supported here).
    maybeOptional(base) {
        this.skipWs();
        if (this.peek() === "?" && this.peekAt(1) !== "/" && this.peekAt(1) !== "=") {
            this.pos++;
            return { t: "Optional", inner: base };
        }
        return base;
    }

    /// Parses `[ ... ]` (index / slice / iterate) after `base`.
    parseBracketSuffix(base) {
        this.expectChar("[");
        this.skipWs();
        if (this.peek() === "]") { this.pos++; return { t: "Iterate", base }; }
        if (this.peek() === ":") {
            this.pos++;
            const hi = this.parsePipe();
            this.expectChar("]");
            return { t: "Slice", base, lo: null, hi };
        }
        const first = this.parsePipe();
        this.skipWs();
        if (this.peek() === ":") {
            this.pos++;
            this.skipWs();
            if (this.peek() === "]") { this.pos++; return { t: "Slice", base, lo: first, hi: null }; }
            const hi = this.parsePipe();
            this.expectChar("]");
            return { t: "Slice", base, lo: first, hi };
        }
        this.expectChar("]");
        return { t: "Index", base, idx: first };
    }

    readIdent() {
        const start = this.pos;
        while (this.pos < this.chars.length && /[A-Za-z0-9_]/.test(this.chars[this.pos])) this.pos++;
        return this.chars.slice(start, this.pos).join("");
    }

    parsePrimary() {
        this.skipWs();
        const c = this.peek();
        if (c === undefined) throw new ParseError("unexpected end of filter");
        if (c === ".") {
            this.pos++;
            const c2 = this.peek();
            if (c2 !== undefined && /[A-Za-z_]/.test(c2)) {
                const name = this.readIdent();
                return { t: "Field", base: { t: "Identity" }, name };
            }
            if (this.peek() === "[") return this.parseBracketSuffix({ t: "Identity" });
            return { t: "Identity" };
        }
        if (c === "(") {
            this.pos++;
            const inner = this.parsePipe();
            this.expectChar(")");
            return inner;
        }
        if (c === "[") {
            this.pos++;
            this.skipWs();
            if (this.peek() === "]") { this.pos++; return { t: "ArrayConstruct", inner: null }; }
            const inner = this.parsePipe();
            this.expectChar("]");
            return { t: "ArrayConstruct", inner };
        }
        if (c === "{") return this.parseObject();
        if (c === '"') return stringPartsToFilter(this.parseStringParts());
        if (c === "@") {
            this.pos++;
            const name = this.readIdent();
            if (name === "tsv") return { t: "Format", name };
            throw new ParseError(`unsupported format '@${name}'`);
        }
        if (c === "$") {
            this.pos++;
            const c2 = this.peek();
            if (c2 === undefined || !/[A-Za-z_]/.test(c2)) throw new ParseError(`expected a variable name at position ${this.pos}`);
            return { t: "Var", name: this.readIdent() };
        }
        if (/[0-9]/.test(c)) return this.parseNumber();
        if (/[A-Za-z_]/.test(c)) {
            const name = this.readIdent();
            if (name === "true") return { t: "Literal", v: true };
            if (name === "false") return { t: "Literal", v: false };
            if (name === "null") return { t: "Literal", v: null };
            if (name === "if") return this.parseIf();
            this.skipWs();
            const args = [];
            if (this.peek() === "(") {
                this.pos++;
                while (true) {
                    args.push(this.parseAlt());
                    this.skipWs();
                    if (this.peek() === ";" || this.peek() === ",") { this.pos++; }
                    else break;
                }
                this.expectChar(")");
            }
            return { t: "Call", name, args };
        }
        throw new ParseError(`unexpected character '${c}' at position ${this.pos}`);
    }

    parseIf() {
        const cond = this.parsePipe();
        if (!this.eatKeyword("then")) throw new ParseError("expected 'then'");
        const thenBranch = this.parsePipe();
        this.skipWs();
        if (this.eatKeyword("elif")) return { t: "If", cond, then: thenBranch, else: this.parseIfTail() };
        if (this.eatKeyword("else")) {
            const elseBranch = this.parsePipe();
            if (!this.eatKeyword("end")) throw new ParseError("expected 'end'");
            return { t: "If", cond, then: thenBranch, else: elseBranch };
        }
        if (!this.eatKeyword("end")) throw new ParseError("expected 'else', 'elif' or 'end'");
        return { t: "If", cond, then: thenBranch, else: { t: "Identity" } };
    }

    /// Called right after consuming an `elif` keyword: parses its
    /// condition/then and recurses for further elif/else/end, without
    /// expecting a leading `if`.
    parseIfTail() {
        const cond = this.parsePipe();
        if (!this.eatKeyword("then")) throw new ParseError("expected 'then'");
        const thenBranch = this.parsePipe();
        this.skipWs();
        if (this.eatKeyword("elif")) return { t: "If", cond, then: thenBranch, else: this.parseIfTail() };
        if (this.eatKeyword("else")) {
            const elseBranch = this.parsePipe();
            if (!this.eatKeyword("end")) throw new ParseError("expected 'end'");
            return { t: "If", cond, then: thenBranch, else: elseBranch };
        }
        if (!this.eatKeyword("end")) throw new ParseError("expected 'else', 'elif' or 'end'");
        return { t: "If", cond, then: thenBranch, else: { t: "Identity" } };
    }

    parseNumber() {
        const start = this.pos;
        while (/[0-9]/.test(this.chars[this.pos] ?? "")) this.pos++;
        if (this.peek() === "." && /[0-9]/.test(this.peekAt(1) ?? "")) {
            this.pos++;
            while (/[0-9]/.test(this.chars[this.pos] ?? "")) this.pos++;
        }
        if (this.peek() === "e" || this.peek() === "E") {
            const save = this.pos;
            this.pos++;
            if (this.peek() === "+" || this.peek() === "-") this.pos++;
            if (/[0-9]/.test(this.peek() ?? "")) {
                while (/[0-9]/.test(this.peek() ?? "")) this.pos++;
            } else {
                this.pos = save;
            }
        }
        const text = this.chars.slice(start, this.pos).join("");
        const n = Number(text);
        if (Number.isNaN(n)) throw new ParseError(`invalid number '${text}'`);
        return { t: "Literal", v: num(n) };
    }

    parseObject() {
        this.expectChar("{");
        const pairs = [];
        this.skipWs();
        if (this.peek() === "}") { this.pos++; return { t: "ObjectConstruct", pairs }; }
        while (true) {
            this.skipWs();
            let key, explicitValue;
            if (this.peek() === "(") {
                this.pos++;
                const keyFilter = this.parsePipe();
                this.expectChar(")");
                key = { t: "Dynamic", f: keyFilter };
                explicitValue = true;
            } else if (this.peek() === '"') {
                const parts = this.parseStringParts();
                if (parts.length === 1 && parts[0].t === "Lit") {
                    key = { t: "Literal", s: parts[0].s };
                    explicitValue = false;
                } else {
                    key = { t: "Dynamic", f: stringPartsToFilter(parts) };
                    explicitValue = true;
                }
            } else if (/[A-Za-z_]/.test(this.peek() ?? "")) {
                key = { t: "Literal", s: this.readIdent() };
                explicitValue = false;
            } else {
                throw new ParseError(`invalid object key at position ${this.pos}`);
            }
            this.skipWs();
            let value;
            if (this.eatChar(":")) {
                value = this.parseObjValue();
            } else if (explicitValue) {
                throw new ParseError("expected ':' after dynamic object key");
            } else {
                // Shorthand `{name}` == `{name: .name}`.
                value = { t: "Field", base: { t: "Identity" }, name: key.s };
            }
            pairs.push([key, value]);
            this.skipWs();
            if (this.eatChar(",")) continue;
            break;
        }
        this.expectChar("}");
        return { t: "ObjectConstruct", pairs };
    }

    /// Scans a `"..."` string literal, splitting into literal/interpolated
    /// parts. `\(...)` recurses into `parsePipe` on the same cursor.
    parseStringParts() {
        this.expectChar('"');
        const parts = [];
        let lit = "";
        while (true) {
            const c = this.peek();
            if (c === undefined) throw new ParseError("unterminated string literal");
            if (c === '"') { this.pos++; break; }
            if (c === "\\" && this.peekAt(1) === "(") {
                this.pos += 2;
                const inner = this.parsePipe();
                this.expectChar(")");
                if (lit !== "") { parts.push({ t: "Lit", s: lit }); lit = ""; }
                parts.push({ t: "Expr", f: inner });
                continue;
            }
            if (c === "\\") {
                this.pos++;
                const n = this.peek();
                if (n === "n") lit += "\n";
                else if (n === "t") lit += "\t";
                else if (n === "r") lit += "\r";
                else if (n === '"') lit += '"';
                else if (n === "\\") lit += "\\";
                else if (n === "/") lit += "/";
                else if (n !== undefined) lit += n;
                else throw new ParseError("unterminated string literal");
                this.pos++;
                continue;
            }
            lit += c;
            this.pos++;
        }
        if (parts.length === 0 || lit !== "") parts.push({ t: "Lit", s: lit });
        return parts;
    }
}

function stringPartsToFilter(parts) {
    if (parts.length === 1 && parts[0].t === "Lit") return { t: "Literal", v: parts[0].s };
    return { t: "StringInterp", parts };
}

function parseFilter(src) {
    return new Parser(src).parseProgram();
}

// ============================================================================
// Evaluator
// ============================================================================

function typeName(v) {
    if (v === null) return "null";
    if (typeof v === "boolean") return "boolean";
    if (typeof v === "number") return "number";
    if (typeof v === "string") return "string";
    if (Array.isArray(v)) return "array";
    return "object";
}

function isTruthy(v) {
    return !(v === false || v === null);
}

function asF64(v) {
    return typeof v === "number" ? v : 0;
}

/// Never store a non-finite result (matches the Rust port's
/// `Number::from_f64(f).unwrap_or_else(|| Number::from(0))`).
function num(f) {
    return Number.isFinite(f) ? f : 0;
}

/// Structural equality with jq's semantics: order-independent object key
/// comparison, order-dependent array comparison.
function valuesEqual(a, b) {
    if (typeof a === "number" && typeof b === "number") return a === b;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]));
    }
    if (isPlainObj(a) && isPlainObj(b)) {
        const ak = Object.keys(a);
        const bk = Object.keys(b);
        if (ak.length !== bk.length) return false;
        return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && valuesEqual(a[k], b[k]));
    }
    return a === b;
}

/// jq's typed ordering: null < bool < number < string < array < object.
function rank(v) {
    if (v === null) return 0;
    if (typeof v === "boolean") return 1;
    if (typeof v === "number") return 2;
    if (typeof v === "string") return 3;
    if (Array.isArray(v)) return 4;
    return 5;
}

function compareJq(a, b) {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    switch (ra) {
        case 1: return a === b ? 0 : a ? 1 : -1;
        case 2: return a < b ? -1 : a > b ? 1 : 0;
        case 3: return a < b ? -1 : a > b ? 1 : 0;
        case 4: {
            const n = Math.min(a.length, b.length);
            for (let i = 0; i < n; i++) {
                const c = compareJq(a[i], b[i]);
                if (c !== 0) return c;
            }
            return a.length - b.length;
        }
        case 5: {
            const ak = Object.keys(a).sort();
            const bk = Object.keys(b).sort();
            const n = Math.min(ak.length, bk.length);
            for (let i = 0; i < n; i++) {
                if (ak[i] !== bk[i]) return ak[i] < bk[i] ? -1 : 1;
            }
            if (ak.length !== bk.length) return ak.length - bk.length;
            for (const k of ak) {
                const c = compareJq(a[k], b[k]);
                if (c !== 0) return c;
            }
            return 0;
        }
        default: return 0;
    }
}

function shallowMerge(a, b) {
    return { ...a, ...b };
}

function deepMerge(a, b) {
    const out = { ...a };
    for (const k of Object.keys(b)) {
        out[k] = isPlainObj(out[k]) && isPlainObj(b[k]) ? deepMerge(out[k], b[k]) : b[k];
    }
    return out;
}

function binop(op, l, r) {
    switch (op) {
        case "+":
            if (l === null) return r;
            if (r === null) return l;
            if (typeof l === "number" && typeof r === "number") return num(l + r);
            if (typeof l === "string" && typeof r === "string") return l + r;
            if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
            if (isPlainObj(l) && isPlainObj(r)) return shallowMerge(l, r);
            throw new JqError(`${typeName(l)} and ${typeName(r)} cannot be added`);
        case "-":
            if (typeof l === "number" && typeof r === "number") return num(l - r);
            if (Array.isArray(l) && Array.isArray(r)) return l.filter((x) => !r.some((y) => valuesEqual(x, y)));
            throw new JqError(`${typeName(l)} and ${typeName(r)} cannot be subtracted`);
        case "*":
            if (typeof l === "number" && typeof r === "number") return num(l * r);
            if (typeof l === "string" && typeof r === "number") {
                const n = Math.trunc(r);
                return n <= 0 ? null : l.repeat(n);
            }
            if (isPlainObj(l) && isPlainObj(r)) return deepMerge(l, r);
            throw new JqError(`${typeName(l)} and ${typeName(r)} cannot be multiplied`);
        case "/":
            if (typeof l === "number" && typeof r === "number") {
                if (r === 0) throw new JqError("cannot divide by zero");
                return num(l / r);
            }
            if (typeof l === "string" && typeof r === "string") return r === "" ? [...l] : l.split(r);
            throw new JqError(`${typeName(l)} and ${typeName(r)} cannot be divided`);
        case "%":
            if (typeof l === "number" && typeof r === "number") {
                if (r === 0) throw new JqError("cannot mod by zero");
                return num(l % r);
            }
            throw new JqError(`${typeName(l)} and ${typeName(r)} cannot be divided (remainder)`);
        case "==": return valuesEqual(l, r);
        case "!=": return !valuesEqual(l, r);
        case "<": return compareJq(l, r) < 0;
        case "<=": return compareJq(l, r) <= 0;
        case ">": return compareJq(l, r) > 0;
        case ">=": return compareJq(l, r) >= 0;
        default: throw new JqError(`unknown binary operator ${op}`);
    }
}

/// Index a container by a runtime-typed index value (`.[expr]`).
function indexValue(base, idx) {
    if (base === null && (typeof idx === "number" || typeof idx === "string")) return null;
    if (Array.isArray(base) && typeof idx === "number") {
        const n = Math.trunc(idx);
        const len = base.length;
        const real = n < 0 ? n + len : n;
        return real < 0 || real >= len ? null : base[real];
    }
    if (isPlainObj(base) && typeof idx === "string") {
        return Object.prototype.hasOwnProperty.call(base, idx) ? base[idx] : null;
    }
    throw new JqError(`Cannot index ${typeName(base)} with ${typeName(idx)}`);
}

function sliceBounds(len, lo, hi) {
    const clamp = (v) => Math.min(Math.max(v, 0), len);
    let loN = lo === undefined ? 0 : Math.trunc(lo);
    let hiN = hi === undefined ? len : Math.trunc(hi);
    loN = clamp(loN < 0 ? loN + len : loN);
    hiN = clamp(hiN < 0 ? hiN + len : hiN);
    return hiN < loN ? [loN, loN] : [loN, hiN];
}

function sliceValue(base, lo, hi) {
    if (base === null) return null;
    if (Array.isArray(base)) {
        const [s, e] = sliceBounds(base.length, lo, hi);
        return base.slice(s, e);
    }
    if (typeof base === "string") {
        const chars = [...base];
        const [s, e] = sliceBounds(chars.length, lo, hi);
        return chars.slice(s, e).join("");
    }
    throw new JqError(`Cannot slice ${typeName(base)}`);
}

/// Renders a value the way jq's `\(...)` interpolation and `tostring` do:
/// strings pass through raw, everything else is compact JSON.
function interpToString(v) {
    return typeof v === "string" ? v : formatJson(v, true, false);
}

function formatTsv(value) {
    if (!Array.isArray(value)) throw new JqError(`${typeName(value)} cannot be tsv-formatted, only an array`);
    const fields = value.map((v) => {
        if (v === null) return "";
        if (typeof v === "boolean" || typeof v === "number") return formatJson(v, true, false);
        if (typeof v === "string") return v.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
        throw new JqError(`${typeName(v)} is not valid in a tsv row`);
    });
    return fields.join("\t");
}

function evaluate(filter, value, vars) {
    switch (filter.t) {
        case "Identity": return [value];
        case "Field": {
            const out = [];
            for (const b of evaluate(filter.base, value, vars)) {
                if (b === null) out.push(null);
                else if (isPlainObj(b)) out.push(Object.prototype.hasOwnProperty.call(b, filter.name) ? b[filter.name] : null);
                else throw new JqError(`Cannot index ${typeName(b)} with "${filter.name}"`);
            }
            return out;
        }
        case "Index": {
            const bases = evaluate(filter.base, value, vars);
            const idxs = evaluate(filter.idx, value, vars);
            const out = [];
            for (const b of bases) for (const i of idxs) out.push(indexValue(b, i));
            return out;
        }
        case "Iterate": {
            const out = [];
            for (const b of evaluate(filter.base, value, vars)) {
                if (Array.isArray(b)) out.push(...b);
                else if (isPlainObj(b)) out.push(...Object.values(b));
                else throw new JqError(`Cannot iterate over ${typeName(b)}`);
            }
            return out;
        }
        case "Slice": {
            const bases = evaluate(filter.base, value, vars);
            const los = filter.lo ? evaluate(filter.lo, value, vars).map(asF64) : [undefined];
            const his = filter.hi ? evaluate(filter.hi, value, vars).map(asF64) : [undefined];
            const out = [];
            for (const b of bases) for (const lo of los) for (const hi of his) out.push(sliceValue(b, lo, hi));
            return out;
        }
        case "Optional": {
            try { return evaluate(filter.inner, value, vars); } catch { return []; }
        }
        case "Pipe": {
            const out = [];
            for (const v of evaluate(filter.l, value, vars)) out.push(...evaluate(filter.r, v, vars));
            return out;
        }
        case "Comma": return [...evaluate(filter.l, value, vars), ...evaluate(filter.r, value, vars)];
        case "Literal": return [filter.v];
        case "StringInterp": {
            let acc = [""];
            for (const part of filter.parts) {
                if (part.t === "Lit") {
                    acc = acc.map((a) => a + part.s);
                } else {
                    const vals = evaluate(part.f, value, vars);
                    const next = [];
                    for (const a of acc) for (const v of vals) next.push(a + interpToString(v));
                    acc = next;
                }
            }
            return acc;
        }
        case "Format": {
            if (filter.name === "tsv") return [formatTsv(value)];
            throw new JqError(`unsupported jq format ${filter.name}`);
        }
        case "ArrayConstruct": return filter.inner ? [evaluate(filter.inner, value, vars)] : [[]];
        case "ObjectConstruct": {
            // Cartesian product across all pairs' (possibly multi-valued) keys/values.
            let objs = [{}];
            for (const [key, valueFilter] of filter.pairs) {
                const keys = key.t === "Literal"
                    ? [key.s]
                    : evaluate(key.f, value, vars).map((v) => {
                        if (typeof v !== "string") throw new JqError(`Cannot use ${typeName(v)} as object key`);
                        return v;
                    });
                const vals = evaluate(valueFilter, value, vars);
                const next = [];
                for (const obj of objs) for (const k of keys) for (const v of vals) next.push({ ...obj, [k]: v });
                objs = next;
            }
            return objs;
        }
        case "Call": return evalCall(filter.name, filter.args, value, vars);
        case "Var": {
            if (!Object.prototype.hasOwnProperty.call(vars, filter.name)) throw new JqError(`$${filter.name} is not defined`);
            return [vars[filter.name]];
        }
        case "Neg": {
            return evaluate(filter.inner, value, vars).map((v) => {
                if (typeof v !== "number") throw new JqError(`${typeName(v)} cannot be negated`);
                return num(-v);
            });
        }
        case "BinOp": {
            const lvals = evaluate(filter.l, value, vars);
            const rvals = evaluate(filter.r, value, vars);
            const out = [];
            for (const lv of lvals) for (const rv of rvals) out.push(binop(filter.op, lv, rv));
            return out;
        }
        case "And": {
            const out = [];
            for (const lv of evaluate(filter.l, value, vars)) {
                if (!isTruthy(lv)) { out.push(false); continue; }
                for (const rv of evaluate(filter.r, value, vars)) out.push(isTruthy(rv));
            }
            return out;
        }
        case "Or": {
            const out = [];
            for (const lv of evaluate(filter.l, value, vars)) {
                if (isTruthy(lv)) { out.push(true); continue; }
                for (const rv of evaluate(filter.r, value, vars)) out.push(isTruthy(rv));
            }
            return out;
        }
        case "Alt": {
            let lvals;
            try { lvals = evaluate(filter.l, value, vars); } catch { lvals = []; }
            const nonnull = lvals.filter(isTruthy);
            return nonnull.length ? nonnull : evaluate(filter.r, value, vars);
        }
        case "If": {
            const out = [];
            for (const c of evaluate(filter.cond, value, vars)) {
                out.push(...evaluate(isTruthy(c) ? filter.then : filter.else, value, vars));
            }
            return out;
        }
        default: throw new JqError(`unknown filter node ${filter.t}`);
    }
}

function evalCall(name, args, value, vars) {
    switch (name) {
        case "empty": return [];
        case "not": return [!isTruthy(value)];
        case "length": {
            if (value === null) return [num(0)];
            if (typeof value === "string") return [num([...value].length)];
            if (Array.isArray(value)) return [num(value.length)];
            if (isPlainObj(value)) return [num(Object.keys(value).length)];
            if (typeof value === "number") return [num(Math.abs(value))];
            throw new JqError("boolean has no length");
        }
        case "type": return [typeName(value)];
        case "keys":
        case "keys_unsorted": {
            if (isPlainObj(value)) {
                const ks = Object.keys(value);
                return [name === "keys" ? [...ks].sort() : ks];
            }
            if (Array.isArray(value)) return [value.map((_, i) => num(i))];
            throw new JqError(`${typeName(value)} has no keys`);
        }
        case "has": {
            return evaluate(args[0], value, vars).map((k) => {
                if (isPlainObj(value) && typeof k === "string") return Object.prototype.hasOwnProperty.call(value, k);
                if (Array.isArray(value) && typeof k === "number") {
                    const i = Math.trunc(k);
                    return i >= 0 && i < value.length;
                }
                throw new JqError("has() needs an object/string or array/number");
            });
        }
        case "select": {
            return evaluate(args[0], value, vars).filter(isTruthy).map(() => value);
        }
        case "map": {
            if (!Array.isArray(value)) throw new JqError(`Cannot map over ${typeName(value)}`);
            const out = [];
            for (const item of value) out.push(...evaluate(args[0], item, vars));
            return [out];
        }
        case "add": {
            if (!Array.isArray(value)) throw new JqError(`Cannot add over ${typeName(value)}`);
            let acc = null;
            for (const item of value) acc = binop("+", acc, item);
            return [acc];
        }
        case "range": {
            let from, to, by;
            if (args.length === 1) {
                from = 0; to = asF64(evaluate(args[0], value, vars)[0]); by = 1;
            } else if (args.length === 2) {
                from = asF64(evaluate(args[0], value, vars)[0]);
                to = asF64(evaluate(args[1], value, vars)[0]);
                by = 1;
            } else {
                from = asF64(evaluate(args[0], value, vars)[0]);
                to = asF64(evaluate(args[1], value, vars)[0]);
                by = asF64(evaluate(args[2], value, vars)[0]);
            }
            const out = [];
            if (by > 0) for (let x = from; x < to; x += by) out.push(num(x));
            else if (by < 0) for (let x = from; x > to; x += by) out.push(num(x));
            return out;
        }
        case "floor": return [num(Math.floor(asF64(value)))];
        case "ceil": return [num(Math.ceil(asF64(value)))];
        case "round": return [num(Math.round(asF64(value)))];
        case "sqrt": return [num(Math.sqrt(asF64(value)))];
        case "abs": return [num(Math.abs(asF64(value)))];
        case "tostring": return [interpToString(value)];
        case "tonumber": {
            if (typeof value === "number") return [value];
            if (typeof value === "string") {
                const trimmed = value.trim();
                const n = Number(trimmed);
                if (trimmed === "" || Number.isNaN(n)) throw new JqError(`Cannot parse '${value}' as number`);
                return [num(n)];
            }
            throw new JqError(`Cannot parse ${typeName(value)} as number`);
        }
        // jq's fromjson: parse the input string as JSON (any value, not
        // just objects). tojson: serialize the value to compact JSON.
        case "fromjson": {
            if (typeof value !== "string") throw new JqError(`fromjson requires a string, got ${typeName(value)}`);
            try {
                return [JSON.parse(value.trim())];
            } catch (e) {
                throw new JqError(`fromjson: ${e.message}`);
            }
        }
        case "tojson": {
            if (args.length !== 0) throw new JqError(`${name}/${args.length} is not defined`);
            return [JSON.stringify(value) ?? "null"];
        }
        case "split": {
            if (typeof value !== "string") throw new JqError(`Cannot split ${typeName(value)}`);
            const sep = evaluate(args[0], value, vars)[0];
            if (typeof sep !== "string") throw new JqError("split() separator must be a string");
            return [sep === "" ? [...value] : value.split(sep)];
        }
        case "join": {
            if (!Array.isArray(value)) throw new JqError(`Cannot join ${typeName(value)}`);
            const sep = evaluate(args[0], value, vars)[0];
            if (typeof sep !== "string") throw new JqError("join() separator must be a string");
            const parts = value.map((v) => (v === null ? "" : typeof v === "string" ? v : interpToString(v)));
            return [parts.join(sep)];
        }
        default: throw new JqError(`${name}/${args.length} is not defined`);
    }
}

// ============================================================================
// JSON output (2-space pretty by default, matching jq; JSON.stringify's
// number/string formatting and escaping already line up closely enough with
// jq's for this practical subset)
// ============================================================================

function sortKeysDeep(v) {
    if (Array.isArray(v)) return v.map(sortKeysDeep);
    if (isPlainObj(v)) {
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
        return out;
    }
    return v;
}

function formatJson(value, compact, sortKeys) {
    const v = sortKeys ? sortKeysDeep(value) : value;
    return compact ? JSON.stringify(v) : JSON.stringify(v, null, 2);
}

// ============================================================================
// Minimal JSON-value-stream reader (stdin/--slurpfile may contain several
// whitespace-separated top-level JSON documents, the way `jq` reads them).
// ============================================================================

function scanJsonValue(s, start) {
    const n = s.length;
    let i = start;
    const c = s[i];
    if (c === "{" || c === "[") {
        const stack = [c];
        i++;
        let inStr = false;
        let esc = false;
        while (i < n && stack.length) {
            const ch = s[i];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === "\\") esc = true;
                else if (ch === '"') inStr = false;
            } else if (ch === '"') {
                inStr = true;
            } else if (ch === "{" || ch === "[") {
                stack.push(ch);
            } else if (ch === "}" || ch === "]") {
                stack.pop();
            }
            i++;
        }
        if (stack.length) throw new Error("unexpected end of JSON input");
        return i;
    }
    if (c === '"') {
        i++;
        let esc = false;
        while (i < n) {
            const ch = s[i];
            i++;
            if (esc) { esc = false; continue; }
            if (ch === "\\") { esc = true; continue; }
            if (ch === '"') break;
        }
        return i;
    }
    const stop = /[\s,\]}{[]/;
    while (i < n && !stop.test(s[i])) i++;
    if (i === start) throw new Error(`unexpected character '${c}' at position ${start}`);
    return i;
}

function parseJsonStream(text) {
    const values = [];
    const n = text.length;
    let i = 0;
    while (i < n) {
        while (i < n && /\s/.test(text[i])) i++;
        if (i >= n) break;
        const end = scanJsonValue(text, i);
        try {
            values.push(JSON.parse(text.slice(i, end)));
        } catch (e) {
            throw new Error(`invalid JSON near position ${i}: ${e.message}`);
        }
        i = end;
    }
    return values;
}

/// Parses a single JSON value, requiring it to decode to exactly one value
/// (matching upstream's `parseJsonStream` check for --argjson/--jsonargs).
function parseOneJson(text) {
    let values;
    try {
        values = parseJsonStream(text.trim());
    } catch {
        return { ok: false };
    }
    return values.length === 1 ? { ok: true, value: values[0] } : { ok: false };
}

// ============================================================================
// Command entry point
// ============================================================================

/// Error result for external-argument option parsing failures. jq uses exit
/// code 2 for command-line option errors.
function jqArgError(message) {
    return fail(`jq: ${message}\n`, 2);
}

export function jqCommand(interp, args, stdin) {
    const argv = args.slice(1);
    const opts = { raw: false, rawInput: false, compact: false, nullInput: false, slurp: false, exitStatus: false, sortKeys: false };
    let filterText;
    const named = {};
    const positional = [];
    let positionalMode = "none";

    const applyShortFlag = (c) => {
        switch (c) {
            case "r": opts.raw = true; return true;
            case "R": opts.rawInput = true; return true;
            case "c": opts.compact = true; return true;
            case "n": opts.nullInput = true; return true;
            case "s": opts.slurp = true; return true;
            case "e": opts.exitStatus = true; return true;
            case "S": opts.sortKeys = true; return true;
            default: return false;
        }
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "-r" || arg === "--raw-output") opts.raw = true;
        else if (arg === "-R" || arg === "--raw-input") opts.rawInput = true;
        else if (arg === "-c" || arg === "--compact-output") opts.compact = true;
        else if (arg === "-n" || arg === "--null-input") opts.nullInput = true;
        else if (arg === "-s" || arg === "--slurp") opts.slurp = true;
        else if (arg === "-e" || arg === "--exit-status") opts.exitStatus = true;
        else if (arg === "-S" || arg === "--sort-keys") opts.sortKeys = true;
        else if (arg === "--arg") {
            const name = argv[i + 1];
            const value = argv[i + 2];
            if (name === undefined || value === undefined) return jqArgError("--arg takes two parameters (e.g. --arg varname value)");
            named[name] = value;
            i += 2;
        } else if (arg === "--argjson") {
            const name = argv[i + 1];
            const json = argv[i + 2];
            if (name === undefined || json === undefined) return jqArgError("--argjson takes two parameters (e.g. --argjson varname text)");
            const parsed = parseOneJson(json);
            if (!parsed.ok) return jqArgError("invalid JSON text passed to --argjson");
            named[name] = parsed.value;
            i += 2;
        } else if (arg === "--rawfile") {
            const name = argv[i + 1];
            const file = argv[i + 2];
            if (name === undefined || file === undefined) return jqArgError("--rawfile takes two parameters (e.g. --rawfile varname filename)");
            const path = interp.resolvePath(file);
            if (!interp.vfs.isFile(path)) return jqArgError(`${file}: No such file or directory`);
            named[name] = interp.vfs.readFile(path);
            i += 2;
        } else if (arg === "--slurpfile") {
            const name = argv[i + 1];
            const file = argv[i + 2];
            if (name === undefined || file === undefined) return jqArgError("--slurpfile takes two parameters (e.g. --slurpfile varname filename)");
            const path = interp.resolvePath(file);
            if (!interp.vfs.isFile(path)) return jqArgError(`${file}: No such file or directory`);
            const trimmed = interp.vfs.readFile(path).trim();
            let values = [];
            if (trimmed !== "") {
                try { values = parseJsonStream(trimmed); } catch { return jqArgError("invalid JSON text passed to --slurpfile"); }
            }
            named[name] = values;
            i += 2;
        } else if (arg === "--args") {
            positionalMode = "args";
        } else if (arg === "--jsonargs") {
            positionalMode = "jsonargs";
        } else if (arg.startsWith("-") && arg.length > 1 && !arg.startsWith("--")) {
            for (const c of arg.slice(1)) {
                if (!applyShortFlag(c)) return fail(`jq: unknown option -${c}\n`, 2);
            }
        } else if (filterText === undefined) {
            filterText = arg;
        } else if (positionalMode === "args") {
            positional.push(arg);
        } else if (positionalMode === "jsonargs") {
            const parsed = parseOneJson(arg);
            if (!parsed.ok) return jqArgError("invalid JSON text passed to --jsonargs");
            positional.push(parsed.value);
        } else {
            return fail(`jq: unexpected argument '${arg}'\n`, 2);
        }
    }

    const vars = { ...named, ARGS: { positional, named: { ...named } } };
    // No positional filter defaults to identity `.`, matching upstream jq.
    filterText = filterText ?? ".";

    let filter;
    try {
        filter = parseFilter(filterText);
    } catch (e) {
        return fail(`jq: parse error: ${e.message}\n`, 3);
    }

    let inputs = [];
    if (opts.nullInput) {
        inputs = [null];
    } else if (opts.rawInput) {
        // Raw input: treat stdin as text, not JSON. With --slurp the whole
        // input (trailing newline included) is one string; otherwise each
        // line becomes a string and a single trailing newline does not
        // yield an empty element, matching upstream `jq -R`.
        if (opts.slurp) {
            inputs = [stdin];
        } else if (stdin !== "") {
            const body = stdin.endsWith("\n") ? stdin.slice(0, -1) : stdin;
            inputs = body.split("\n");
        }
    } else {
        try {
            inputs = parseJsonStream(stdin);
        } catch (e) {
            return fail(`jq: parse error: ${e.message}\n`, 2);
        }
        if (opts.slurp) inputs = [inputs];
    }

    const outputs = [];
    for (const input of inputs) {
        try {
            outputs.push(...evaluate(filter, input, vars));
        } catch (e) {
            return fail(`jq: error: ${e.message}\n`, 5);
        }
    }

    let stdout = "";
    for (const v of outputs) {
        if (opts.raw && typeof v === "string") {
            stdout += `${v}\n`;
            continue;
        }
        stdout += `${formatJson(v, opts.compact, opts.sortKeys)}\n`;
    }

    const exitStatusFail = opts.exitStatus && (outputs.length === 0 || outputs.every((v) => v === null || v === false));
    if (exitStatusFail) return { stdout, stderr: "", exitCode: 1 };
    return ok(stdout);
}
