// A small TOML parser covering what app.toml uses (no dates): tables, arrays of
// tables, dotted and quoted keys, strings, numbers, booleans, arrays and inline tables.

export function parseToml(text) {
    const root = {};
    const parser = new Parser(text);
    let current = root;
    // Tables created by a header or an inline value, which TOML forbids redefining.
    const defined = new Set();
    for (;;) {
        parser.skipBlank();
        if (parser.done()) return root;
        if (parser.peek() === "[") {
            const array = parser.text.startsWith("[[", parser.pos);
            parser.pos += array ? 2 : 1;
            const path = parser.key("]");
            parser.expect(array ? "]]" : "]");
            parser.endOfLine();
            current = array ? appendTable(root, path, parser) : headerTable(root, path, defined, parser);
        } else {
            const path = parser.key("=");
            parser.expect("=");
            const value = parser.value();
            parser.endOfLine();
            assign(current, path, value, parser);
        }
    }
}

function headerTable(root, path, defined, parser) {
    const id = JSON.stringify(path);
    if (defined.has(id)) parser.fail(`table [${path.join(".")}] defined twice`);
    defined.add(id);
    return descend(root, path, parser);
}

function appendTable(root, path, parser) {
    const parent = descend(root, path.slice(0, -1), parser);
    const last = path[path.length - 1];
    if (!(last in parent)) parent[last] = [];
    if (!Array.isArray(parent[last])) parser.fail(`${path.join(".")} is not an array of tables`);
    const table = {};
    parent[last].push(table);
    return table;
}

// Walk to (creating) the table at `path`; an array of tables resolves to its last element.
function descend(table, path, parser) {
    let node = table;
    for (const part of path) {
        if (!(part in node)) node[part] = {};
        let next = node[part];
        if (Array.isArray(next)) next = next[next.length - 1];
        if (next === null || typeof next !== "object" || Array.isArray(next)) {
            parser.fail(`key ${part} is not a table`);
        }
        node = next;
    }
    return node;
}

function assign(table, path, value, parser) {
    const target = descend(table, path.slice(0, -1), parser);
    const last = path[path.length - 1];
    if (last in target) parser.fail(`duplicate key ${path.join(".")}`);
    target[last] = value;
}

const BARE_KEY = /[A-Za-z0-9_-]/;
const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

class Parser {
    constructor(text) {
        this.text = text.replace(/\r\n/g, "\n");
        this.pos = 0;
    }

    done() {
        return this.pos >= this.text.length;
    }

    peek() {
        return this.text[this.pos];
    }

    fail(message) {
        const line = this.text.slice(0, this.pos).split("\n").length;
        throw `TOML parse error at line ${line}: ${message}`;
    }

    expect(token) {
        this.skipSpaces();
        if (!this.text.startsWith(token, this.pos)) this.fail(`expected \`${token}\``);
        this.pos += token.length;
    }

    skipSpaces() {
        while (this.peek() === " " || this.peek() === "\t") this.pos++;
    }

    skipComment() {
        if (this.peek() !== "#") return;
        while (!this.done() && this.peek() !== "\n") this.pos++;
    }

    // Whitespace, newlines and comments (between statements and inside arrays).
    skipBlank() {
        for (;;) {
            this.skipSpaces();
            this.skipComment();
            if (this.peek() !== "\n") return;
            this.pos++;
        }
    }

    endOfLine() {
        this.skipSpaces();
        this.skipComment();
        if (this.done()) return;
        if (this.peek() !== "\n") this.fail(`unexpected \`${this.peek()}\``);
        this.pos++;
    }

    key(terminator) {
        const parts = [];
        for (;;) {
            this.skipSpaces();
            const ch = this.peek();
            if (ch === '"') parts.push(this.basicString());
            else if (ch === "'") parts.push(this.literalString());
            else {
                const start = this.pos;
                while (!this.done() && BARE_KEY.test(this.peek())) this.pos++;
                if (start === this.pos) this.fail(`expected a key before \`${terminator}\``);
                parts.push(this.text.slice(start, this.pos));
            }
            this.skipSpaces();
            if (this.peek() !== ".") return parts;
            this.pos++;
        }
    }

    value() {
        this.skipSpaces();
        const rest = this.text.slice(this.pos);
        if (rest.startsWith('"""')) return this.multilineBasic();
        if (rest.startsWith("'''")) return this.multilineLiteral();
        const ch = this.peek();
        if (ch === '"') return this.basicString();
        if (ch === "'") return this.literalString();
        if (ch === "[") return this.array();
        if (ch === "{") return this.inlineTable();
        const word = /^[^\s,\]}#]+/.exec(rest)?.[0] ?? "";
        this.pos += word.length;
        if (word === "true") return true;
        if (word === "false") return false;
        if (/^[+-]?(0|[1-9](_?\d)*)$/.test(word)) return Number(word.replace(/_/g, ""));
        if (/^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$/.test(word)) return parseInt(word.slice(2).replace(/_/g, ""), 16);
        if (/^[+-]?(0|[1-9](_?\d)*)(\.\d(_?\d)*)?([eE][+-]?\d(_?\d)*)?$/.test(word)) return Number(word.replace(/_/g, ""));
        this.fail(word ? `unsupported value \`${word}\`` : "expected a value");
    }

    basicString() {
        this.pos++;
        let out = "";
        for (;;) {
            if (this.done() || this.peek() === "\n") this.fail("unterminated string");
            const ch = this.text[this.pos++];
            if (ch === '"') return out;
            out += ch === "\\" ? this.escape() : ch;
        }
    }

    escape() {
        const ch = this.text[this.pos++];
        if (ch in ESCAPES) return ESCAPES[ch];
        if (ch === "u" || ch === "U") {
            const len = ch === "u" ? 4 : 8;
            const hex = this.text.slice(this.pos, this.pos + len);
            if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) this.fail("invalid unicode escape");
            this.pos += len;
            return String.fromCodePoint(parseInt(hex, 16));
        }
        this.fail(`invalid escape \\${ch}`);
    }

    literalString() {
        const end = this.text.indexOf("'", this.pos + 1);
        const newline = this.text.indexOf("\n", this.pos + 1);
        if (end === -1 || (newline !== -1 && newline < end)) this.fail("unterminated string");
        const out = this.text.slice(this.pos + 1, end);
        this.pos = end + 1;
        return out;
    }

    multilineBasic() {
        this.pos += 3;
        if (this.peek() === "\n") this.pos++;
        let out = "";
        for (;;) {
            if (this.done()) this.fail("unterminated string");
            if (this.text.startsWith('"""', this.pos) && !this.text.startsWith('""""', this.pos)) {
                this.pos += 3;
                return out;
            }
            const ch = this.text[this.pos++];
            if (ch !== "\\") {
                out += ch;
            } else if (/^[ \t]*\n/.test(this.text.slice(this.pos))) {
                // A line-ending backslash trims the newline and following whitespace.
                while (/\s/.test(this.peek() ?? "")) this.pos++;
            } else {
                out += this.escape();
            }
        }
    }

    multilineLiteral() {
        this.pos += 3;
        if (this.peek() === "\n") this.pos++;
        const end = this.text.indexOf("'''", this.pos);
        if (end === -1) this.fail("unterminated string");
        const out = this.text.slice(this.pos, end);
        this.pos = end + 3;
        return out;
    }

    array() {
        this.pos++;
        const out = [];
        for (;;) {
            this.skipBlank();
            if (this.peek() === "]") {
                this.pos++;
                return out;
            }
            out.push(this.value());
            this.skipBlank();
            if (this.peek() === ",") this.pos++;
            else if (this.peek() !== "]") this.fail("expected `,` or `]` in array");
        }
    }

    inlineTable() {
        this.pos++;
        const out = {};
        this.skipSpaces();
        if (this.peek() === "}") {
            this.pos++;
            return out;
        }
        for (;;) {
            const path = this.key("=");
            this.expect("=");
            assign(out, path, this.value(), this);
            this.skipSpaces();
            const ch = this.text[this.pos++];
            if (ch === "}") return out;
            if (ch !== ",") this.fail("expected `,` or `}` in inline table");
        }
    }
}
