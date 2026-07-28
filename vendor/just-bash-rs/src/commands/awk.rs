//! PORT (partial): vendor/just-bash/src/commands/awk/*.ts
//!
//! A practical subset of awk, not full upstream fidelity: upstream is a full
//! lexer + two-stage parser + a dedicated interpreter package (~13000 LOC
//! across `lexer.ts`/`parser2.ts`/`interpreter/*.ts`/`builtins.ts`) including
//! user-defined functions, `getline`, `nextfile`, and execution-limit
//! bookkeeping this port doesn't need. This is a from-scratch hand-rolled
//! lexer + recursive-descent parser + tree-walking interpreter, not a
//! line-by-line port.
//!
//! Supported: `BEGIN{...}`/`END{...}`, pattern-action pairs, bare pattern
//! (implicit `{print}`), bare `{action}` (implicit always-true pattern),
//! `/regex/` patterns (matched against `$0`), general expression patterns
//! (comparisons on fields/vars, `NR`/`NF`); fields `$0`..`$NF` (read and
//! assign, including extending past `NF` and truncating via `NF=`), FS
//! (single-char literal or multi-char ERE) / `-F`; `print`/`printf`,
//! assignment incl. compound (`+= -= *= /= %= ^=`), `++`/`--` (pre/post),
//! arithmetic `+ - * / % ^ **`, string concatenation (juxtaposition),
//! comparisons (POSIX numeric-string rules), `~`/`!~`, `&&`/`||`/`!`,
//! ternary `?:`, `if/else`, `while`, `do/while`, classic `for(;;)`,
//! `break`/`continue`/`next`/`exit [code]`; builtins `length substr index
//! split sub gsub gensub match toupper tolower sprintf sin cos atan2 exp log
//! sqrt int rand srand`; built-in vars `NR NF FS OFS ORS RS FILENAME FNR
//! RSTART RLENGTH`; minimal single-dimension arrays (`arr[key]`, only so
//! `split()` and hand-rolled counters are useful — see skip list below);
//! CLI flags `-F`/`-v`/`--help`.
//!
//! Explicitly out of scope (skipped, not started): user-defined functions
//! (`function name(...) {...}`), `getline`, `nextfile`, `for (k in arr)` /
//! `delete arr[k]` / `(a, b) in arr` / SUBSEP multi-dim keys / the `in`
//! operator, range patterns (`pat1,pat2`), regex `RS`/multi-char `RS`,
//! output redirection (`print > "file"`, `| cmd`), `-f progfile`, and
//! execution/allocation limits (upstream's resource-limit machinery).

use std::collections::HashMap;

use regex::Regex;

use super::{fail, normalize_path, ok};
use crate::interpreter::{CommandOutput, Interpreter};

// ============================================================================
// Lexer
// ============================================================================

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Num(f64),
    Str(String),
    Regex(String),
    Ident(String),
    Punct(&'static str),
    Newline,
}

const PUNCTS_3: &[&str] = &["**="];
const PUNCTS_2: &[&str] = &[
    "**", "==", "!=", "<=", ">=", "&&", "||", "!~", "++", "--", "+=", "-=", "*=", "/=", "%=", "^=",
];
const PUNCTS_1: &[char] = &[
    '{', '}', '(', ')', '[', ']', ';', ',', '$', '=', '<', '>', '!', '~', '+', '-', '*', '/', '%',
    '^', '?', ':',
];

fn lex(src: &str) -> Result<Vec<Tok>, String> {
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0usize;
    let mut toks: Vec<Tok> = Vec::new();
    let mut paren_depth: i32 = 0;

    // Whether a `/` at the current position should be read as the start of a
    // regex literal rather than division: true unless the previous token was
    // something a value can follow (ident, number, string, `)`, `]`, `$`).
    let regex_allowed = |toks: &[Tok]| -> bool {
        match toks.last() {
            None => true,
            Some(Tok::Ident(name)) => is_keyword(name),
            Some(Tok::Num(_)) | Some(Tok::Str(_)) | Some(Tok::Regex(_)) => false,
            Some(Tok::Punct(")")) | Some(Tok::Punct("]")) => false,
            _ => true,
        }
    };

    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && chars.get(i + 1) == Some(&'\n') {
            // Line continuation.
            i += 2;
            continue;
        }
        if c == '#' {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '\n' {
            i += 1;
            let skip = paren_depth > 0
                || matches!(
                    toks.last(),
                    Some(Tok::Punct(","))
                        | Some(Tok::Punct("{"))
                        | Some(Tok::Punct("&&"))
                        | Some(Tok::Punct("||"))
                )
                || matches!(toks.last(), Some(Tok::Ident(k)) if k == "do" || k == "else");
            if !skip {
                toks.push(Tok::Newline);
            }
            continue;
        }
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '"' {
            i += 1;
            let mut s = String::new();
            while i < chars.len() && chars[i] != '"' {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    let (ch, next) = decode_escape(&chars, i + 1);
                    s.push(ch);
                    i = next;
                } else {
                    s.push(chars[i]);
                    i += 1;
                }
            }
            i += 1; // closing quote
            toks.push(Tok::Str(s));
            continue;
        }
        if c == '/' && regex_allowed(&toks) {
            i += 1;
            let mut pat = String::new();
            let mut in_class = false;
            while i < chars.len() && (chars[i] != '/' || in_class) {
                if chars[i] == '\\' && i + 1 < chars.len() {
                    pat.push(chars[i]);
                    pat.push(chars[i + 1]);
                    i += 2;
                    continue;
                }
                if chars[i] == '[' {
                    in_class = true;
                } else if chars[i] == ']' {
                    in_class = false;
                }
                pat.push(chars[i]);
                i += 1;
            }
            i += 1; // closing slash
            toks.push(Tok::Regex(pat));
            continue;
        }
        if c.is_ascii_digit()
            || (c == '.' && matches!(chars.get(i + 1), Some(d) if d.is_ascii_digit()))
        {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
            if chars.get(i) == Some(&'.') {
                i += 1;
                while i < chars.len() && chars[i].is_ascii_digit() {
                    i += 1;
                }
            }
            if matches!(chars.get(i), Some('e') | Some('E')) {
                let save = i;
                i += 1;
                if matches!(chars.get(i), Some('+') | Some('-')) {
                    i += 1;
                }
                if matches!(chars.get(i), Some(d) if d.is_ascii_digit()) {
                    while i < chars.len() && chars[i].is_ascii_digit() {
                        i += 1;
                    }
                } else {
                    i = save;
                }
            }
            let text: String = chars[start..i].iter().collect();
            toks.push(Tok::Num(
                text.parse()
                    .map_err(|_| format!("invalid number '{text}'"))?,
            ));
            continue;
        }
        if c.is_alphabetic() || c == '_' {
            let start = i;
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                i += 1;
            }
            toks.push(Tok::Ident(chars[start..i].iter().collect()));
            continue;
        }
        if let Some(p) = PUNCTS_3
            .iter()
            .find(|p| chars[i..].starts_with(&p.chars().collect::<Vec<_>>()[..]))
        {
            toks.push(Tok::Punct(p));
            i += p.len();
            continue;
        }
        if let Some(p) = PUNCTS_2
            .iter()
            .find(|p| chars[i..].starts_with(&p.chars().collect::<Vec<_>>()[..]))
        {
            toks.push(Tok::Punct(p));
            i += 2;
            continue;
        }
        if PUNCTS_1.contains(&c) {
            if c == '(' || c == '[' {
                paren_depth += 1;
            } else if c == ')' || c == ']' {
                paren_depth -= 1;
            }
            let p = PUNCTS_1.iter().find(|&&x| x == c).unwrap();
            toks.push(Tok::Punct(match p {
                '{' => "{",
                '}' => "}",
                '(' => "(",
                ')' => ")",
                '[' => "[",
                ']' => "]",
                ';' => ";",
                ',' => ",",
                '$' => "$",
                '=' => "=",
                '<' => "<",
                '>' => ">",
                '!' => "!",
                '~' => "~",
                '+' => "+",
                '-' => "-",
                '*' => "*",
                '/' => "/",
                '%' => "%",
                '^' => "^",
                '?' => "?",
                ':' => ":",
                _ => unreachable!(),
            }));
            i += 1;
            continue;
        }
        return Err(format!("unexpected character '{c}' in awk program"));
    }
    Ok(toks)
}

fn is_keyword(s: &str) -> bool {
    matches!(
        s,
        "BEGIN"
            | "END"
            | "if"
            | "else"
            | "while"
            | "do"
            | "for"
            | "break"
            | "continue"
            | "next"
            | "exit"
            | "print"
            | "printf"
            | "return"
            | "in"
    )
}

fn decode_escape(chars: &[char], pos: usize) -> (char, usize) {
    match chars.get(pos) {
        Some('n') => ('\n', pos + 1),
        Some('t') => ('\t', pos + 1),
        Some('r') => ('\r', pos + 1),
        Some('\\') => ('\\', pos + 1),
        Some('"') => ('"', pos + 1),
        Some('/') => ('/', pos + 1),
        Some('a') => ('\x07', pos + 1),
        Some('b') => ('\x08', pos + 1),
        Some('f') => ('\x0c', pos + 1),
        Some('v') => ('\x0b', pos + 1),
        Some('x') => {
            let mut j = pos + 1;
            let mut hex = String::new();
            while j < chars.len() && hex.len() < 2 && chars[j].is_ascii_hexdigit() {
                hex.push(chars[j]);
                j += 1;
            }
            if hex.is_empty() {
                ('x', pos + 1)
            } else {
                (
                    char::from_u32(u32::from_str_radix(&hex, 16).unwrap_or(0))
                        .unwrap_or('\u{FFFD}'),
                    j,
                )
            }
        }
        Some(d) if ('0'..='7').contains(d) => {
            let mut j = pos;
            let mut oct = String::new();
            while j < chars.len() && oct.len() < 3 && ('0'..='7').contains(&chars[j]) {
                oct.push(chars[j]);
                j += 1;
            }
            (
                char::from_u32(u32::from_str_radix(&oct, 8).unwrap_or(0)).unwrap_or('\u{FFFD}'),
                j,
            )
        }
        Some(other) => (*other, pos + 1),
        None => ('\\', pos),
    }
}

// ============================================================================
// AST
// ============================================================================

#[derive(Clone, Debug)]
enum Expr {
    Num(f64),
    Str(String),
    Regex(String),
    Var(String),
    ArrayIndex(String, Box<Expr>),
    Field(Box<Expr>),
    Assign(Box<Expr>, Box<Expr>),
    CompoundAssign(&'static str, Box<Expr>, Box<Expr>),
    PreIncr(Box<Expr>),
    PreDecr(Box<Expr>),
    PostIncr(Box<Expr>),
    PostDecr(Box<Expr>),
    Binary(&'static str, Box<Expr>, Box<Expr>),
    Concat(Box<Expr>, Box<Expr>),
    Compare(&'static str, Box<Expr>, Box<Expr>),
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Not(Box<Expr>),
    Neg(Box<Expr>),
    Pos(Box<Expr>),
    Match(bool, Box<Expr>, Box<Expr>),
    Ternary(Box<Expr>, Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
    Group(Box<Expr>),
}

#[derive(Clone, Debug)]
enum Stmt {
    Expr(Expr),
    Print(Vec<Expr>),
    Printf(Vec<Expr>),
    If(Expr, Box<Stmt>, Option<Box<Stmt>>),
    While(Expr, Box<Stmt>),
    DoWhile(Box<Stmt>, Expr),
    For(
        Option<Box<Stmt>>,
        Option<Expr>,
        Option<Box<Stmt>>,
        Box<Stmt>,
    ),
    Block(Vec<Stmt>),
    Next,
    Exit(Option<Expr>),
    Break,
    Continue,
}

#[derive(Clone, Debug)]
enum Pattern {
    Always,
    Begin,
    End,
    Expr(Expr),
}

struct Rule {
    pattern: Pattern,
    action: Option<Stmt>,
}

// ============================================================================
// Parser
// ============================================================================

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
}

type PResult<T> = Result<T, String>;

impl Parser {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }

    fn peek_punct(&self, p: &str) -> bool {
        matches!(self.peek(), Some(Tok::Punct(x)) if *x == p)
    }

    fn peek_ident(&self, name: &str) -> bool {
        matches!(self.peek(), Some(Tok::Ident(x)) if x == name)
    }

    fn advance(&mut self) -> Option<Tok> {
        let t = self.toks.get(self.pos).cloned();
        self.pos += 1;
        t
    }

    fn eat_punct(&mut self, p: &str) -> bool {
        if self.peek_punct(p) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn eat_ident(&mut self, name: &str) -> bool {
        if self.peek_ident(name) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn expect_punct(&mut self, p: &str) -> PResult<()> {
        if self.eat_punct(p) {
            Ok(())
        } else {
            Err(format!("expected '{p}'"))
        }
    }

    fn skip_terms(&mut self) {
        while matches!(self.peek(), Some(Tok::Newline) | Some(Tok::Punct(";"))) {
            self.pos += 1;
        }
    }

    // ---- program ----

    fn parse_program(&mut self) -> PResult<Vec<Rule>> {
        let mut rules = Vec::new();
        self.skip_terms();
        while self.peek().is_some() {
            rules.push(self.parse_rule()?);
            self.skip_terms();
        }
        Ok(rules)
    }

    fn parse_rule(&mut self) -> PResult<Rule> {
        if self.eat_ident("BEGIN") {
            let action = self.parse_block()?;
            return Ok(Rule {
                pattern: Pattern::Begin,
                action: Some(action),
            });
        }
        if self.eat_ident("END") {
            let action = self.parse_block()?;
            return Ok(Rule {
                pattern: Pattern::End,
                action: Some(action),
            });
        }
        let pattern = if self.peek_punct("{") {
            Pattern::Always
        } else {
            Pattern::Expr(self.parse_expr()?)
        };
        let action = if self.peek_punct("{") {
            Some(self.parse_block()?)
        } else {
            None
        };
        Ok(Rule { pattern, action })
    }

    fn parse_block(&mut self) -> PResult<Stmt> {
        self.expect_punct("{")?;
        let mut stmts = Vec::new();
        self.skip_terms();
        while !self.peek_punct("}") {
            stmts.push(self.parse_stmt()?);
            self.skip_terms();
        }
        self.expect_punct("}")?;
        Ok(Stmt::Block(stmts))
    }

    fn parse_stmt(&mut self) -> PResult<Stmt> {
        if self.peek_punct("{") {
            return self.parse_block();
        }
        if self.peek_punct(";") {
            return Ok(Stmt::Block(vec![]));
        }
        if self.eat_ident("if") {
            self.expect_punct("(")?;
            let cond = self.parse_expr()?;
            self.expect_punct(")")?;
            self.skip_terms_opt_before_stmt();
            let then_b = Box::new(self.parse_stmt()?);
            let save = self.pos;
            self.skip_terms();
            if self.eat_ident("else") {
                self.skip_terms_opt_before_stmt();
                let else_b = Box::new(self.parse_stmt()?);
                return Ok(Stmt::If(cond, then_b, Some(else_b)));
            }
            self.pos = save;
            return Ok(Stmt::If(cond, then_b, None));
        }
        if self.eat_ident("while") {
            self.expect_punct("(")?;
            let cond = self.parse_expr()?;
            self.expect_punct(")")?;
            self.skip_terms_opt_before_stmt();
            let body = Box::new(self.parse_stmt()?);
            return Ok(Stmt::While(cond, body));
        }
        if self.eat_ident("do") {
            self.skip_terms_opt_before_stmt();
            let body = Box::new(self.parse_stmt()?);
            self.skip_terms();
            if !self.eat_ident("while") {
                return Err("expected 'while' after 'do' body".to_string());
            }
            self.expect_punct("(")?;
            let cond = self.parse_expr()?;
            self.expect_punct(")")?;
            return Ok(Stmt::DoWhile(body, cond));
        }
        if self.eat_ident("for") {
            self.expect_punct("(")?;
            let init = if self.peek_punct(";") {
                None
            } else {
                Some(Box::new(Stmt::Expr(self.parse_expr()?)))
            };
            self.expect_punct(";")?;
            let cond = if self.peek_punct(";") {
                None
            } else {
                Some(self.parse_expr()?)
            };
            self.expect_punct(";")?;
            let incr = if self.peek_punct(")") {
                None
            } else {
                Some(Box::new(Stmt::Expr(self.parse_expr()?)))
            };
            self.expect_punct(")")?;
            self.skip_terms_opt_before_stmt();
            let body = Box::new(self.parse_stmt()?);
            return Ok(Stmt::For(init, cond, incr, body));
        }
        if self.eat_ident("break") {
            return Ok(Stmt::Break);
        }
        if self.eat_ident("continue") {
            return Ok(Stmt::Continue);
        }
        if self.eat_ident("next") {
            return Ok(Stmt::Next);
        }
        if self.eat_ident("exit") {
            let arg = if self.stmt_ends() {
                None
            } else {
                Some(self.parse_expr()?)
            };
            return Ok(Stmt::Exit(arg));
        }
        if self.eat_ident("print") {
            let args = self.parse_print_args()?;
            return Ok(Stmt::Print(args));
        }
        if self.eat_ident("printf") {
            let args = self.parse_print_args()?;
            return Ok(Stmt::Printf(args));
        }
        Ok(Stmt::Expr(self.parse_expr()?))
    }

    /// Some statement forms (`if`/`while`/`for` headers) may be followed by a
    /// newline before the body; skip it without consuming a real statement
    /// terminator that the enclosing block relies on.
    fn skip_terms_opt_before_stmt(&mut self) {
        while matches!(self.peek(), Some(Tok::Newline)) {
            self.pos += 1;
        }
    }

    fn stmt_ends(&self) -> bool {
        matches!(
            self.peek(),
            None | Some(Tok::Newline) | Some(Tok::Punct(";")) | Some(Tok::Punct("}"))
        )
    }

    fn parse_print_args(&mut self) -> PResult<Vec<Expr>> {
        let mut args = Vec::new();
        if self.stmt_ends() {
            return Ok(args);
        }
        loop {
            args.push(self.parse_ternary()?);
            if self.eat_punct(",") {
                continue;
            }
            break;
        }
        Ok(args)
    }

    // ---- expressions ----

    fn parse_expr(&mut self) -> PResult<Expr> {
        self.parse_assign()
    }

    fn parse_assign(&mut self) -> PResult<Expr> {
        let left = self.parse_ternary()?;
        let op = match self.peek() {
            Some(Tok::Punct("=")) => Some("="),
            Some(Tok::Punct("+=")) => Some("+="),
            Some(Tok::Punct("-=")) => Some("-="),
            Some(Tok::Punct("*=")) => Some("*="),
            Some(Tok::Punct("/=")) => Some("/="),
            Some(Tok::Punct("%=")) => Some("%="),
            Some(Tok::Punct("^=")) => Some("^="),
            _ => None,
        };
        if let Some(op) = op {
            if !is_lvalue(&left) {
                return Err("invalid assignment target".to_string());
            }
            self.pos += 1;
            let right = self.parse_assign()?;
            return Ok(if op == "=" {
                Expr::Assign(Box::new(left), Box::new(right))
            } else {
                Expr::CompoundAssign(op, Box::new(left), Box::new(right))
            });
        }
        Ok(left)
    }

    fn parse_ternary(&mut self) -> PResult<Expr> {
        let cond = self.parse_or()?;
        if self.eat_punct("?") {
            let then_e = self.parse_ternary()?;
            self.expect_punct(":")?;
            let else_e = self.parse_ternary()?;
            return Ok(Expr::Ternary(
                Box::new(cond),
                Box::new(then_e),
                Box::new(else_e),
            ));
        }
        Ok(cond)
    }

    fn parse_or(&mut self) -> PResult<Expr> {
        let mut left = self.parse_and()?;
        while self.eat_punct("||") {
            self.skip_terms_opt_before_stmt();
            let right = self.parse_and()?;
            left = Expr::Or(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> PResult<Expr> {
        let mut left = self.parse_match()?;
        while self.eat_punct("&&") {
            self.skip_terms_opt_before_stmt();
            let right = self.parse_match()?;
            left = Expr::And(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_match(&mut self) -> PResult<Expr> {
        let mut left = self.parse_rel()?;
        loop {
            if self.eat_punct("~") {
                let right = self.parse_rel()?;
                left = Expr::Match(false, Box::new(left), Box::new(right));
            } else if self.eat_punct("!~") {
                let right = self.parse_rel()?;
                left = Expr::Match(true, Box::new(left), Box::new(right));
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn parse_rel(&mut self) -> PResult<Expr> {
        let left = self.parse_concat()?;
        let op = match self.peek() {
            Some(Tok::Punct("==")) => Some("=="),
            Some(Tok::Punct("!=")) => Some("!="),
            Some(Tok::Punct("<=")) => Some("<="),
            Some(Tok::Punct(">=")) => Some(">="),
            Some(Tok::Punct("<")) => Some("<"),
            Some(Tok::Punct(">")) => Some(">"),
            _ => None,
        };
        if let Some(op) = op {
            self.pos += 1;
            let right = self.parse_concat()?;
            return Ok(Expr::Compare(op, Box::new(left), Box::new(right)));
        }
        Ok(left)
    }

    fn starts_concat_term(&self) -> bool {
        matches!(
            self.peek(),
            Some(Tok::Num(_))
                | Some(Tok::Str(_))
                | Some(Tok::Regex(_))
                | Some(Tok::Punct("$"))
                | Some(Tok::Punct("("))
                | Some(Tok::Punct("!"))
                | Some(Tok::Punct("++"))
                | Some(Tok::Punct("--"))
        ) || matches!(self.peek(), Some(Tok::Ident(name)) if !is_keyword(name))
    }

    fn parse_concat(&mut self) -> PResult<Expr> {
        let mut left = self.parse_add()?;
        while self.starts_concat_term() {
            let right = self.parse_add()?;
            left = Expr::Concat(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_add(&mut self) -> PResult<Expr> {
        let mut left = self.parse_mul()?;
        loop {
            let op = match self.peek() {
                Some(Tok::Punct("+")) => "+",
                Some(Tok::Punct("-")) => "-",
                _ => break,
            };
            self.pos += 1;
            let right = self.parse_mul()?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_mul(&mut self) -> PResult<Expr> {
        let mut left = self.parse_unary()?;
        loop {
            let op = match self.peek() {
                Some(Tok::Punct("*")) => "*",
                Some(Tok::Punct("/")) => "/",
                Some(Tok::Punct("%")) => "%",
                _ => break,
            };
            self.pos += 1;
            let right = self.parse_unary()?;
            left = Expr::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> PResult<Expr> {
        if self.eat_punct("!") {
            return Ok(Expr::Not(Box::new(self.parse_unary()?)));
        }
        if self.eat_punct("-") {
            return Ok(Expr::Neg(Box::new(self.parse_unary()?)));
        }
        if self.eat_punct("+") {
            return Ok(Expr::Pos(Box::new(self.parse_unary()?)));
        }
        if self.eat_punct("++") {
            let target = self.parse_unary()?;
            return Ok(Expr::PreIncr(Box::new(target)));
        }
        if self.eat_punct("--") {
            let target = self.parse_unary()?;
            return Ok(Expr::PreDecr(Box::new(target)));
        }
        self.parse_pow()
    }

    fn parse_pow(&mut self) -> PResult<Expr> {
        let left = self.parse_postfix()?;
        if self.eat_punct("^") || self.eat_punct("**") {
            let right = self.parse_unary()?;
            return Ok(Expr::Binary("^", Box::new(left), Box::new(right)));
        }
        Ok(left)
    }

    fn parse_postfix(&mut self) -> PResult<Expr> {
        let mut base = self.parse_primary()?;
        loop {
            if is_lvalue(&base) && self.eat_punct("++") {
                base = Expr::PostIncr(Box::new(base));
            } else if is_lvalue(&base) && self.eat_punct("--") {
                base = Expr::PostDecr(Box::new(base));
            } else {
                break;
            }
        }
        Ok(base)
    }

    fn parse_primary(&mut self) -> PResult<Expr> {
        match self.advance() {
            Some(Tok::Num(n)) => Ok(Expr::Num(n)),
            Some(Tok::Str(s)) => Ok(Expr::Str(s)),
            Some(Tok::Regex(r)) => Ok(Expr::Regex(r)),
            Some(Tok::Punct("$")) => {
                let operand = self.parse_dollar_operand()?;
                Ok(Expr::Field(Box::new(operand)))
            }
            Some(Tok::Punct("(")) => {
                let inner = self.parse_expr()?;
                self.expect_punct(")")?;
                Ok(Expr::Group(Box::new(inner)))
            }
            Some(Tok::Ident(name)) => {
                if self.peek_punct("(") {
                    self.pos += 1;
                    let mut args = Vec::new();
                    if !self.peek_punct(")") {
                        loop {
                            args.push(self.parse_ternary()?);
                            if self.eat_punct(",") {
                                continue;
                            }
                            break;
                        }
                    }
                    self.expect_punct(")")?;
                    return Ok(Expr::Call(name, args));
                }
                if name == "length" {
                    return Ok(Expr::Call(name, vec![]));
                }
                if self.eat_punct("[") {
                    let idx = self.parse_expr()?;
                    self.expect_punct("]")?;
                    return Ok(Expr::ArrayIndex(name, Box::new(idx)));
                }
                Ok(Expr::Var(name))
            }
            other => Err(format!("unexpected token {other:?} in expression")),
        }
    }

    /// The operand of `$` binds tightly: a bare number/ident, or a
    /// parenthesized expression, not a full unary/binary expression.
    fn parse_dollar_operand(&mut self) -> PResult<Expr> {
        match self.peek() {
            Some(Tok::Punct("$")) => {
                self.pos += 1;
                let inner = self.parse_dollar_operand()?;
                Ok(Expr::Field(Box::new(inner)))
            }
            Some(Tok::Punct("(")) => {
                self.pos += 1;
                let inner = self.parse_expr()?;
                self.expect_punct(")")?;
                Ok(inner)
            }
            Some(Tok::Punct("-")) => {
                self.pos += 1;
                Ok(Expr::Neg(Box::new(self.parse_dollar_operand()?)))
            }
            Some(Tok::Punct("++")) => {
                self.pos += 1;
                Ok(Expr::PreIncr(Box::new(self.parse_dollar_operand()?)))
            }
            Some(Tok::Num(_)) | Some(Tok::Ident(_)) => self.parse_primary(),
            other => Err(format!("unexpected token after '$': {other:?}")),
        }
    }
}

fn is_lvalue(e: &Expr) -> bool {
    matches!(e, Expr::Var(_) | Expr::Field(_) | Expr::ArrayIndex(_, _))
}

fn parse_program(src: &str) -> Result<Vec<Rule>, String> {
    let toks = lex(src)?;
    let mut p = Parser { toks, pos: 0 };
    p.parse_program()
}

// ============================================================================
// Runtime value
// ============================================================================

#[derive(Clone, Debug)]
enum Value {
    Num(f64),
    Str(String),
    StrNum(String),
}

impl Value {
    fn to_num(&self) -> f64 {
        match self {
            Value::Num(f) => *f,
            Value::Str(s) | Value::StrNum(s) => parse_leading_number(s),
        }
    }

    fn to_str(&self) -> String {
        match self {
            Value::Num(f) => format_awk_number(*f),
            Value::Str(s) | Value::StrNum(s) => s.clone(),
        }
    }

    fn is_numeric(&self) -> bool {
        match self {
            Value::Num(_) => true,
            Value::StrNum(s) => looks_numeric(s),
            Value::Str(_) => false,
        }
    }

    fn truthy(&self) -> bool {
        match self {
            Value::Num(f) => *f != 0.0,
            Value::StrNum(s) => {
                if looks_numeric(s) {
                    parse_leading_number(s) != 0.0
                } else {
                    !s.is_empty()
                }
            }
            Value::Str(s) => !s.is_empty(),
        }
    }

    fn uninitialized() -> Value {
        Value::StrNum(String::new())
    }
}

fn looks_numeric(s: &str) -> bool {
    let t = s.trim();
    if t.is_empty() {
        return false;
    }
    let bytes = t.as_bytes();
    let mut i = 0;
    if bytes[i] == b'+' || bytes[i] == b'-' {
        i += 1;
    }
    let start_digits = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let mut has_digits = i > start_digits;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let start2 = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        has_digits = has_digits || i > start2;
    }
    if !has_digits {
        return false;
    }
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
            j += 1;
        }
        let start3 = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > start3 {
            i = j;
        }
    }
    i == bytes.len()
}

fn parse_leading_number(s: &str) -> f64 {
    let t = s.trim_start();
    let bytes = t.as_bytes();
    let mut i = 0;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    let start_digits = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    let mut has_digits = i > start_digits;
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let start2 = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        has_digits = has_digits || i > start2;
    }
    if !has_digits {
        return 0.0;
    }
    let mut end = i;
    if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
        let mut j = i + 1;
        if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
            j += 1;
        }
        let start3 = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j > start3 {
            end = j;
        }
    }
    t[..end].parse::<f64>().unwrap_or(0.0)
}

fn format_awk_number(f: f64) -> String {
    if f.is_nan() {
        return "nan".to_string();
    }
    if f.is_infinite() {
        return if f > 0.0 {
            "inf".to_string()
        } else {
            "-inf".to_string()
        };
    }
    if f == f.trunc() && f.abs() < 1e16 {
        return format!("{}", f as i64);
    }
    // Not exactly POSIX's default `%.6g` (OFMT) — a reasonable, simpler
    // approximation using Rust's shortest round-trip float formatting.
    format!("{f}")
}

fn compare_values(a: &Value, b: &Value) -> std::cmp::Ordering {
    if a.is_numeric() && b.is_numeric() {
        a.to_num()
            .partial_cmp(&b.to_num())
            .unwrap_or(std::cmp::Ordering::Equal)
    } else {
        a.to_str().cmp(&b.to_str())
    }
}

// ============================================================================
// Interpreter state
// ============================================================================

enum Flow {
    Normal,
    Break,
    Continue,
    Next,
    Exit,
}

struct Ctx {
    vars: HashMap<String, Value>,
    arrays: HashMap<String, HashMap<String, Value>>,
    fields: Vec<String>,
    record: String,
    fs: String,
    ofs: String,
    ors: String,
    nr: i64,
    fnr: i64,
    filename: String,
    rstart: i64,
    rlength: i64,
    rng: u64,
    stdout: String,
    exit_code: Option<i32>,
}

impl Ctx {
    fn new() -> Self {
        Ctx {
            vars: HashMap::new(),
            arrays: HashMap::new(),
            fields: Vec::new(),
            record: String::new(),
            fs: " ".to_string(),
            ofs: " ".to_string(),
            ors: "\n".to_string(),
            nr: 0,
            fnr: 0,
            filename: String::new(),
            rstart: 0,
            rlength: -1,
            rng: 0x2545_F491_4F6C_DD1D,
            stdout: String::new(),
            exit_code: None,
        }
    }

    fn next_rand(&mut self) -> f64 {
        // xorshift64*: deterministic, good enough for awk's rand()/srand().
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.rng = x;
        ((x >> 11) as f64) / ((1u64 << 53) as f64)
    }

    fn set_record(&mut self, record: String) {
        self.record = record;
        self.fields = split_record(&self.record, &self.fs);
    }

    fn rebuild_record(&mut self) {
        self.record = self.fields.join(&self.ofs);
    }

    fn get_field(&self, n: i64) -> Value {
        if n == 0 {
            Value::StrNum(self.record.clone())
        } else if n >= 1 && (n as usize) <= self.fields.len() {
            Value::StrNum(self.fields[(n - 1) as usize].clone())
        } else {
            Value::StrNum(String::new())
        }
    }

    fn set_field(&mut self, n: i64, value: Value) -> Result<(), String> {
        if n < 0 {
            return Err("field index must not be negative".to_string());
        }
        if n == 0 {
            self.set_record(value.to_str());
            return Ok(());
        }
        let idx = n as usize;
        if idx > self.fields.len() {
            self.fields.resize(idx, String::new());
        }
        self.fields[idx - 1] = value.to_str();
        self.rebuild_record();
        Ok(())
    }

    fn set_nf(&mut self, n: i64) {
        let n = n.max(0) as usize;
        self.fields.resize(n, String::new());
        self.rebuild_record();
    }

    fn get_var(&self, name: &str) -> Value {
        match name {
            "NR" => Value::Num(self.nr as f64),
            "NF" => Value::Num(self.fields.len() as f64),
            "FNR" => Value::Num(self.fnr as f64),
            "FS" => Value::Str(self.fs.clone()),
            "OFS" => Value::Str(self.ofs.clone()),
            "ORS" => Value::Str(self.ors.clone()),
            "FILENAME" => Value::Str(self.filename.clone()),
            "RSTART" => Value::Num(self.rstart as f64),
            "RLENGTH" => Value::Num(self.rlength as f64),
            _ => self
                .vars
                .get(name)
                .cloned()
                .unwrap_or_else(Value::uninitialized),
        }
    }

    fn set_var(&mut self, name: &str, value: Value) {
        match name {
            "NF" => self.set_nf(value.to_num() as i64),
            "FS" => self.fs = value.to_str(),
            "OFS" => self.ofs = value.to_str(),
            "ORS" => self.ors = value.to_str(),
            "FILENAME" => self.filename = value.to_str(),
            "RSTART" => self.rstart = value.to_num() as i64,
            "RLENGTH" => self.rlength = value.to_num() as i64,
            "NR" => self.nr = value.to_num() as i64,
            "FNR" => self.fnr = value.to_num() as i64,
            _ => {
                self.vars.insert(name.to_string(), value);
            }
        }
    }
}

/// Splits a record into fields per `fs`: default (single space) means "split
/// on runs of whitespace, trim ends"; a single non-space char is a literal
/// separator; anything longer is an ERE (regex-field-separator support).
fn split_record(record: &str, fs: &str) -> Vec<String> {
    if record.is_empty() {
        return vec![];
    }
    if fs == " " {
        return record.split_whitespace().map(|s| s.to_string()).collect();
    }
    if fs.chars().count() == 1 {
        let c = fs.chars().next().unwrap();
        return record.split(c).map(|s| s.to_string()).collect();
    }
    match Regex::new(fs) {
        Ok(re) => re.split(record).map(|s| s.to_string()).collect(),
        Err(_) => vec![record.to_string()],
    }
}

// ============================================================================
// Expression evaluation
// ============================================================================

fn eval_expr(ctx: &mut Ctx, expr: &Expr) -> Result<Value, String> {
    match expr {
        Expr::Num(n) => Ok(Value::Num(*n)),
        Expr::Str(s) => Ok(Value::Str(s.clone())),
        Expr::Regex(pat) => {
            let re = compile_regex(pat)?;
            Ok(Value::Num(if re.is_match(&ctx.record) { 1.0 } else { 0.0 }))
        }
        Expr::Var(name) => Ok(ctx.get_var(name)),
        Expr::ArrayIndex(name, idx) => {
            let key = eval_expr(ctx, idx)?.to_str();
            Ok(ctx
                .arrays
                .get(name)
                .and_then(|m| m.get(&key))
                .cloned()
                .unwrap_or_else(Value::uninitialized))
        }
        Expr::Field(idx) => {
            let n = eval_expr(ctx, idx)?.to_num() as i64;
            Ok(ctx.get_field(n))
        }
        Expr::Group(inner) => eval_expr(ctx, inner),
        Expr::Assign(target, value) => {
            let v = eval_expr(ctx, value)?;
            assign(ctx, target, v.clone())?;
            Ok(v)
        }
        Expr::CompoundAssign(op, target, value) => {
            let cur = eval_expr(ctx, target)?.to_num();
            let rhs = eval_expr(ctx, value)?.to_num();
            let result = apply_numeric_op(&op[..1], cur, rhs)?;
            let v = Value::Num(result);
            assign(ctx, target, v.clone())?;
            Ok(v)
        }
        Expr::PreIncr(target) => {
            let v = Value::Num(eval_expr(ctx, target)?.to_num() + 1.0);
            assign(ctx, target, v.clone())?;
            Ok(v)
        }
        Expr::PreDecr(target) => {
            let v = Value::Num(eval_expr(ctx, target)?.to_num() - 1.0);
            assign(ctx, target, v.clone())?;
            Ok(v)
        }
        Expr::PostIncr(target) => {
            let old = eval_expr(ctx, target)?.to_num();
            assign(ctx, target, Value::Num(old + 1.0))?;
            Ok(Value::Num(old))
        }
        Expr::PostDecr(target) => {
            let old = eval_expr(ctx, target)?.to_num();
            assign(ctx, target, Value::Num(old - 1.0))?;
            Ok(Value::Num(old))
        }
        Expr::Binary(op, l, r) => {
            let lv = eval_expr(ctx, l)?.to_num();
            let rv = eval_expr(ctx, r)?.to_num();
            Ok(Value::Num(apply_numeric_op(op, lv, rv)?))
        }
        Expr::Concat(l, r) => {
            let lv = eval_expr(ctx, l)?.to_str();
            let rv = eval_expr(ctx, r)?.to_str();
            Ok(Value::Str(format!("{lv}{rv}")))
        }
        Expr::Compare(op, l, r) => {
            let lv = eval_expr(ctx, l)?;
            let rv = eval_expr(ctx, r)?;
            let ord = compare_values(&lv, &rv);
            use std::cmp::Ordering::*;
            let result = matches!(
                (*op, ord),
                ("==", Equal)
                    | ("!=", Less)
                    | ("!=", Greater)
                    | ("<", Less)
                    | ("<=", Less)
                    | ("<=", Equal)
                    | (">", Greater)
                    | (">=", Greater)
                    | (">=", Equal)
            );
            Ok(Value::Num(if result { 1.0 } else { 0.0 }))
        }
        Expr::And(l, r) => {
            let lv = eval_expr(ctx, l)?.truthy();
            if !lv {
                return Ok(Value::Num(0.0));
            }
            Ok(Value::Num(if eval_expr(ctx, r)?.truthy() {
                1.0
            } else {
                0.0
            }))
        }
        Expr::Or(l, r) => {
            let lv = eval_expr(ctx, l)?.truthy();
            if lv {
                return Ok(Value::Num(1.0));
            }
            Ok(Value::Num(if eval_expr(ctx, r)?.truthy() {
                1.0
            } else {
                0.0
            }))
        }
        Expr::Not(inner) => Ok(Value::Num(if eval_expr(ctx, inner)?.truthy() {
            0.0
        } else {
            1.0
        })),
        Expr::Neg(inner) => Ok(Value::Num(-eval_expr(ctx, inner)?.to_num())),
        Expr::Pos(inner) => Ok(Value::Num(eval_expr(ctx, inner)?.to_num())),
        Expr::Match(negate, l, r) => {
            let text = eval_expr(ctx, l)?.to_str();
            let pat = regex_operand_text(ctx, r)?;
            let re = compile_regex(&pat)?;
            let m = re.is_match(&text);
            Ok(Value::Num(if m != *negate { 1.0 } else { 0.0 }))
        }
        Expr::Ternary(c, t, e) => {
            if eval_expr(ctx, c)?.truthy() {
                eval_expr(ctx, t)
            } else {
                eval_expr(ctx, e)
            }
        }
        Expr::Call(name, args) => eval_call(ctx, name, args),
    }
}

/// `~`/`!~`/`match()`'s right operand may be a bare regex literal (which
/// would otherwise evaluate to a 0/1 match-against-`$0`) or a string/expr.
fn regex_operand_text(ctx: &mut Ctx, expr: &Expr) -> Result<String, String> {
    match expr {
        Expr::Regex(pat) => Ok(pat.clone()),
        Expr::Group(inner) => regex_operand_text(ctx, inner),
        other => Ok(eval_expr(ctx, other)?.to_str()),
    }
}

fn compile_regex(pat: &str) -> Result<Regex, String> {
    Regex::new(pat).map_err(|e| format!("invalid regex /{pat}/: {e}"))
}

fn apply_numeric_op(op: &str, l: f64, r: f64) -> Result<f64, String> {
    Ok(match op {
        "+" => l + r,
        "-" => l - r,
        "*" => l * r,
        "/" => l / r,
        "%" => l % r,
        "^" => l.powf(r),
        _ => return Err(format!("unknown operator {op}")),
    })
}

fn assign(ctx: &mut Ctx, target: &Expr, value: Value) -> Result<(), String> {
    match target {
        Expr::Var(name) => {
            ctx.set_var(name, value);
            Ok(())
        }
        Expr::Field(idx) => {
            let n = eval_expr(ctx, idx)?.to_num() as i64;
            ctx.set_field(n, value)
        }
        Expr::ArrayIndex(name, idx) => {
            let key = eval_expr(ctx, idx)?.to_str();
            ctx.arrays
                .entry(name.clone())
                .or_default()
                .insert(key, value);
            Ok(())
        }
        Expr::Group(inner) => assign(ctx, inner, value),
        _ => Err("invalid assignment target".to_string()),
    }
}

// ============================================================================
// Builtins
// ============================================================================

fn eval_call(ctx: &mut Ctx, name: &str, args: &[Expr]) -> Result<Value, String> {
    match name {
        "length" => {
            let s = if args.is_empty() {
                ctx.record.clone()
            } else {
                eval_expr(ctx, &args[0])?.to_str()
            };
            Ok(Value::Num(s.chars().count() as f64))
        }
        "substr" => {
            let s = eval_expr(ctx, &args[0])?.to_str();
            let chars: Vec<char> = s.chars().collect();
            let start_arg = eval_expr(ctx, &args[1])?.to_num();
            // Matches upstream's own (simplified, not strict-POSIX) rule: a
            // start before the string just clamps to 1 without shortening
            // an explicit length (`substr("hello", 0, 3)` == "hel").
            let start = (start_arg.round() as i64).max(1);
            let len = if args.len() > 2 {
                eval_expr(ctx, &args[2])?.to_num().round() as i64
            } else {
                chars.len() as i64
            };
            let start0 = (start - 1) as usize;
            if start0 >= chars.len() || len <= 0 {
                return Ok(Value::Str(String::new()));
            }
            let end = (start0 as i64).saturating_add(len).min(chars.len() as i64) as usize;
            Ok(Value::Str(chars[start0..end].iter().collect()))
        }
        "index" => {
            let hay = eval_expr(ctx, &args[0])?.to_str();
            let needle = eval_expr(ctx, &args[1])?.to_str();
            if needle.is_empty() {
                return Ok(Value::Num(1.0));
            }
            let hay_chars: Vec<char> = hay.chars().collect();
            let needle_chars: Vec<char> = needle.chars().collect();
            for i in 0..=hay_chars.len().saturating_sub(needle_chars.len()) {
                if hay_chars[i..].starts_with(&needle_chars[..]) {
                    return Ok(Value::Num((i + 1) as f64));
                }
            }
            Ok(Value::Num(0.0))
        }
        "split" => {
            let s = eval_expr(ctx, &args[0])?.to_str();
            let array_name = match &args[1] {
                Expr::Var(n) => n.clone(),
                other => {
                    return Err(format!(
                        "split(): second argument must be an array name, got {other:?}"
                    ));
                }
            };
            let fs = if args.len() > 2 {
                regex_operand_text(ctx, &args[2])?.to_string()
            } else {
                ctx.fs.clone()
            };
            let parts = split_record(&s, &fs);
            let n = parts.len();
            let mut map = HashMap::new();
            for (i, p) in parts.into_iter().enumerate() {
                map.insert((i + 1).to_string(), Value::StrNum(p));
            }
            ctx.arrays.insert(array_name, map);
            Ok(Value::Num(n as f64))
        }
        "sub" | "gsub" => {
            let pat = regex_operand_text(ctx, &args[0])?;
            let repl = eval_expr(ctx, &args[1])?.to_str();
            let target = if args.len() > 2 {
                args[2].clone()
            } else {
                Expr::Field(Box::new(Expr::Num(0.0)))
            };
            let text = eval_expr(ctx, &target)?.to_str();
            let re = compile_regex(&pat)?;
            let global = name == "gsub";
            let (result, count) = regex_replace(&re, &text, &repl, global, None);
            if count > 0 {
                assign(ctx, &target, Value::Str(result))?;
            }
            Ok(Value::Num(count as f64))
        }
        "gensub" => {
            let pat = regex_operand_text(ctx, &args[0])?;
            let repl = eval_expr(ctx, &args[1])?.to_str();
            let how = if args.len() > 2 {
                eval_expr(ctx, &args[2])?.to_str()
            } else {
                "1".to_string()
            };
            let text = if args.len() > 3 {
                eval_expr(ctx, &args[3])?.to_str()
            } else {
                ctx.record.clone()
            };
            let re = compile_regex(&pat)?;
            let global = how.trim().eq_ignore_ascii_case("g");
            let nth = if global {
                None
            } else {
                Some((parse_leading_number(&how).max(1.0)) as usize)
            };
            let (result, _) = regex_replace(&re, &text, &repl, global, nth);
            Ok(Value::Str(result))
        }
        "match" => {
            let text = eval_expr(ctx, &args[0])?.to_str();
            let pat = regex_operand_text(ctx, &args[1])?;
            let re = compile_regex(&pat)?;
            let chars: Vec<char> = text.chars().collect();
            match re.find(&text) {
                Some(m) => {
                    let start_chars = text[..m.start()].chars().count();
                    let len_chars = text[m.start()..m.end()].chars().count();
                    let _ = chars;
                    ctx.rstart = (start_chars + 1) as i64;
                    ctx.rlength = len_chars as i64;
                    Ok(Value::Num(ctx.rstart as f64))
                }
                None => {
                    ctx.rstart = 0;
                    ctx.rlength = -1;
                    Ok(Value::Num(0.0))
                }
            }
        }
        "toupper" => Ok(Value::Str(
            eval_expr(ctx, &args[0])?.to_str().to_uppercase(),
        )),
        "tolower" => Ok(Value::Str(
            eval_expr(ctx, &args[0])?.to_str().to_lowercase(),
        )),
        "sprintf" => {
            let vals: Vec<Value> = args
                .iter()
                .skip(1)
                .map(|a| eval_expr(ctx, a))
                .collect::<Result<_, _>>()?;
            let fmt = eval_expr(ctx, &args[0])?.to_str();
            Ok(Value::Str(awk_sprintf(&fmt, &vals)?))
        }
        "sin" => Ok(Value::Num(eval_expr(ctx, &args[0])?.to_num().sin())),
        "cos" => Ok(Value::Num(eval_expr(ctx, &args[0])?.to_num().cos())),
        "atan2" => {
            let y = eval_expr(ctx, &args[0])?.to_num();
            let x = eval_expr(ctx, &args[1])?.to_num();
            Ok(Value::Num(y.atan2(x)))
        }
        "exp" => Ok(Value::Num(eval_expr(ctx, &args[0])?.to_num().exp())),
        "log" => Ok(Value::Num(eval_expr(ctx, &args[0])?.to_num().ln())),
        "sqrt" => Ok(Value::Num(eval_expr(ctx, &args[0])?.to_num().sqrt())),
        "int" => Ok(Value::Num(eval_expr(ctx, &args[0])?.to_num().trunc())),
        "rand" => Ok(Value::Num(ctx.next_rand())),
        "srand" => {
            let prev = ctx.rng;
            let seed = if args.is_empty() {
                1
            } else {
                eval_expr(ctx, &args[0])?.to_num() as i64 as u64
            };
            ctx.rng = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15).max(1);
            Ok(Value::Num(prev as f64))
        }
        _ => Err(format!("calling undefined function {name}")),
    }
}

/// Replaces matches of `re` in `text` with `repl`, supporting `&` (whole
/// match) / `\&` (literal ampersand) and `\1`..`\9` backreferences. `nth`
/// (1-based) replaces only that occurrence; `global` replaces all; the
/// default (both `None`) replaces the first. Returns `(result, count)`.
fn regex_replace(
    re: &Regex,
    text: &str,
    repl: &str,
    global: bool,
    nth: Option<usize>,
) -> (String, usize) {
    let mut out = String::new();
    let mut last_end = 0;
    let mut count = 0usize;
    let mut occurrence = 0usize;
    for caps in re.captures_iter(text) {
        let m = caps.get(0).unwrap();
        occurrence += 1;
        let should_replace = global || nth.map(|n| n == occurrence).unwrap_or(occurrence == 1);
        out.push_str(&text[last_end..m.start()]);
        if should_replace {
            out.push_str(&expand_replacement(repl, &caps));
            count += 1;
        } else {
            out.push_str(m.as_str());
        }
        last_end = m.end();
        if !global && count > 0 && nth.is_none() {
            break;
        }
        if let Some(n) = nth
            && occurrence >= n
        {
            break;
        }
    }
    out.push_str(&text[last_end..]);
    (out, count)
}

fn expand_replacement(repl: &str, caps: &regex::Captures) -> String {
    let chars: Vec<char> = repl.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '\\' && i + 1 < chars.len() {
            match chars[i + 1] {
                '&' => {
                    out.push('&');
                    i += 2;
                }
                '\\' => {
                    out.push('\\');
                    i += 2;
                }
                d if d.is_ascii_digit() => {
                    let n: usize = d.to_digit(10).unwrap() as usize;
                    if let Some(m) = caps.get(n) {
                        out.push_str(m.as_str());
                    }
                    i += 2;
                }
                other => {
                    out.push(other);
                    i += 2;
                }
            }
        } else if chars[i] == '&' {
            out.push_str(caps.get(0).unwrap().as_str());
            i += 1;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// A compact printf/sprintf formatter covering `%s %d %i %o %x %X %c %e %E
/// %f %F %g %G %%` with `-+0 #` flags and literal width/precision digits (no
/// `*`-from-args). Not a port of any upstream file (awk's own printf isn't
/// shared code upstream either); intentionally smaller than `text::printf`
/// since awk's conversions operate on `Value`, not shell argv strings.
fn awk_sprintf(fmt: &str, args: &[Value]) -> Result<String, String> {
    let chars: Vec<char> = fmt.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let mut arg_i = 0;
    let next_arg = |arg_i: &mut usize| -> Value {
        let v = args.get(*arg_i).cloned().unwrap_or(Value::Num(0.0));
        *arg_i += 1;
        v
    };
    while i < chars.len() {
        if chars[i] != '%' {
            out.push(chars[i]);
            i += 1;
            continue;
        }
        i += 1;
        if chars.get(i) == Some(&'%') {
            out.push('%');
            i += 1;
            continue;
        }
        let mut flags = String::new();
        while matches!(chars.get(i), Some(c) if "-+0 #".contains(*c)) {
            flags.push(chars[i]);
            i += 1;
        }
        let mut width = String::new();
        while matches!(chars.get(i), Some(c) if c.is_ascii_digit()) {
            width.push(chars[i]);
            i += 1;
        }
        let mut precision: Option<usize> = None;
        if chars.get(i) == Some(&'.') {
            i += 1;
            let mut p = String::new();
            while matches!(chars.get(i), Some(c) if c.is_ascii_digit()) {
                p.push(chars[i]);
                i += 1;
            }
            precision = Some(p.parse().unwrap_or(0));
        }
        let conv = *chars.get(i).ok_or("printf: dangling format spec")?;
        i += 1;
        let width: usize = width.parse().unwrap_or(0);
        let left = flags.contains('-');
        let zero = flags.contains('0') && !left;
        let plus = flags.contains('+');
        let space = flags.contains(' ');
        let pad = |s: String, width: usize, left: bool, zero_pad: bool| -> String {
            if s.chars().count() >= width {
                return s;
            }
            let fill = if zero_pad { '0' } else { ' ' };
            let padding: String = std::iter::repeat_n(fill, width - s.chars().count()).collect();
            if left {
                format!("{s}{padding}")
            } else if zero_pad && (s.starts_with('-') || s.starts_with('+')) {
                format!("{}{}{}", &s[..1], padding, &s[1..])
            } else {
                format!("{padding}{s}")
            }
        };
        let piece = match conv {
            's' => {
                let mut s = next_arg(&mut arg_i).to_str();
                if let Some(p) = precision {
                    s = s.chars().take(p).collect();
                }
                pad(s, width, left, false)
            }
            'd' | 'i' => {
                let n = next_arg(&mut arg_i).to_num().trunc() as i64;
                let mut s = n.unsigned_abs().to_string();
                if let Some(p) = precision {
                    while s.len() < p {
                        s.insert(0, '0');
                    }
                }
                let sign = if n < 0 {
                    "-"
                } else if plus {
                    "+"
                } else if space {
                    " "
                } else {
                    ""
                };
                pad(format!("{sign}{s}"), width, left, zero)
            }
            'o' => {
                let n = next_arg(&mut arg_i).to_num().trunc() as i64;
                pad(format!("{:o}", n as u64), width, left, zero)
            }
            'x' => {
                let n = next_arg(&mut arg_i).to_num().trunc() as i64;
                pad(format!("{:x}", n as u64), width, left, zero)
            }
            'X' => {
                let n = next_arg(&mut arg_i).to_num().trunc() as i64;
                pad(format!("{:X}", n as u64), width, left, zero)
            }
            'c' => {
                let v = next_arg(&mut arg_i);
                let ch = match &v {
                    Value::Num(n) => char::from_u32(*n as u32).unwrap_or('\0'),
                    Value::Str(s) | Value::StrNum(s) => s.chars().next().unwrap_or('\0'),
                };
                pad(ch.to_string(), width, left, false)
            }
            'e' | 'E' => {
                let n = next_arg(&mut arg_i).to_num();
                let s = format_exp(n, precision.unwrap_or(6), conv == 'E');
                pad(s, width, left, zero)
            }
            'f' | 'F' => {
                let n = next_arg(&mut arg_i).to_num();
                let s = format!("{:.*}", precision.unwrap_or(6), n);
                let s = if n >= 0.0 && plus { format!("+{s}") } else { s };
                pad(s, width, left, zero)
            }
            'g' | 'G' => {
                let n = next_arg(&mut arg_i).to_num();
                pad(format_awk_number(n), width, left, zero)
            }
            other => return Err(format!("printf: unsupported conversion %{other}")),
        };
        out.push_str(&piece);
    }
    Ok(out)
}

fn format_exp(f: f64, precision: usize, upper: bool) -> String {
    if f == 0.0 {
        let mant = format!("{:.*}", precision, 0.0);
        return format!("{mant}e+0");
    }
    let neg = f < 0.0;
    let af = f.abs();
    let mut exp = af.log10().floor() as i32;
    let mut mantissa = af / 10f64.powi(exp);
    let mut mant_str = format!("{mantissa:.precision$}");
    if mant_str.starts_with("10") {
        exp += 1;
        mantissa /= 10.0;
        mant_str = format!("{mantissa:.precision$}");
    }
    let e = if upper { 'E' } else { 'e' };
    let sign = if exp >= 0 { "+" } else { "-" };
    format!(
        "{}{}{}{}{}",
        if neg { "-" } else { "" },
        mant_str,
        e,
        sign,
        exp.abs()
    )
}

// ============================================================================
// Statement execution
// ============================================================================

fn exec_stmt(ctx: &mut Ctx, stmt: &Stmt) -> Result<Flow, String> {
    match stmt {
        Stmt::Block(stmts) => {
            for s in stmts {
                match exec_stmt(ctx, s)? {
                    Flow::Normal => {}
                    other => return Ok(other),
                }
            }
            Ok(Flow::Normal)
        }
        Stmt::Expr(e) => {
            eval_expr(ctx, e)?;
            Ok(Flow::Normal)
        }
        Stmt::Print(args) => {
            let line = if args.is_empty() {
                ctx.record.clone()
            } else {
                let parts: Vec<String> = args
                    .iter()
                    .map(|a| eval_expr(ctx, a).map(|v| v.to_str()))
                    .collect::<Result<_, _>>()?;
                parts.join(&ctx.ofs)
            };
            ctx.stdout.push_str(&line);
            let ors = ctx.ors.clone();
            ctx.stdout.push_str(&ors);
            Ok(Flow::Normal)
        }
        Stmt::Printf(args) => {
            if args.is_empty() {
                return Err("printf: missing format string".to_string());
            }
            let fmt = eval_expr(ctx, &args[0])?.to_str();
            let vals: Vec<Value> = args[1..]
                .iter()
                .map(|a| eval_expr(ctx, a))
                .collect::<Result<_, _>>()?;
            ctx.stdout.push_str(&awk_sprintf(&fmt, &vals)?);
            Ok(Flow::Normal)
        }
        Stmt::If(cond, then_b, else_b) => {
            if eval_expr(ctx, cond)?.truthy() {
                exec_stmt(ctx, then_b)
            } else if let Some(else_b) = else_b {
                exec_stmt(ctx, else_b)
            } else {
                Ok(Flow::Normal)
            }
        }
        Stmt::While(cond, body) => {
            while eval_expr(ctx, cond)?.truthy() {
                match exec_stmt(ctx, body)? {
                    Flow::Break => break,
                    Flow::Continue | Flow::Normal => {}
                    other => return Ok(other),
                }
            }
            Ok(Flow::Normal)
        }
        Stmt::DoWhile(body, cond) => {
            loop {
                match exec_stmt(ctx, body)? {
                    Flow::Break => break,
                    Flow::Continue | Flow::Normal => {}
                    other => return Ok(other),
                }
                if !eval_expr(ctx, cond)?.truthy() {
                    break;
                }
            }
            Ok(Flow::Normal)
        }
        Stmt::For(init, cond, incr, body) => {
            if let Some(init) = init {
                exec_stmt(ctx, init)?;
            }
            loop {
                if let Some(cond) = cond
                    && !eval_expr(ctx, cond)?.truthy()
                {
                    break;
                }
                match exec_stmt(ctx, body)? {
                    Flow::Break => break,
                    Flow::Continue | Flow::Normal => {}
                    other => return Ok(other),
                }
                if let Some(incr) = incr {
                    exec_stmt(ctx, incr)?;
                }
            }
            Ok(Flow::Normal)
        }
        Stmt::Break => Ok(Flow::Break),
        Stmt::Continue => Ok(Flow::Continue),
        Stmt::Next => Ok(Flow::Next),
        Stmt::Exit(code) => {
            if let Some(code) = code {
                ctx.exit_code = Some(eval_expr(ctx, code)?.to_num() as i32);
            }
            Ok(Flow::Exit)
        }
    }
}

// ============================================================================
// Command entry point
// ============================================================================

fn split_records(content: &str) -> Vec<String> {
    if content.is_empty() {
        return vec![];
    }
    let mut lines: Vec<String> = content.split('\n').map(|s| s.to_string()).collect();
    if lines.last().is_some_and(|s| s.is_empty()) {
        lines.pop();
    }
    lines
}

pub fn awk(interp: &mut Interpreter, args: &[String], stdin: String) -> CommandOutput {
    if args.iter().any(|a| a == "--help") {
        return ok("awk - pattern scanning and processing language\nusage: awk [-F fs] [-v var=val] 'program' [file...]\n".to_string());
    }

    let mut fs_override: Option<String> = None;
    let mut assignments: Vec<(String, String)> = Vec::new();
    let mut program_text: Option<String> = None;
    let mut files: Vec<String> = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "-F" {
            i += 1;
            fs_override = args.get(i).cloned();
        } else if let Some(rest) = a.strip_prefix("-F") {
            fs_override = Some(rest.to_string());
        } else if a == "-v" {
            i += 1;
            if let Some(kv) = args.get(i)
                && let Some(eq) = kv.find('=')
            {
                assignments.push((kv[..eq].to_string(), kv[eq + 1..].to_string()));
            }
        } else if program_text.is_none() {
            program_text = Some(a.clone());
        } else {
            files.push(a.clone());
        }
        i += 1;
    }

    let Some(program_text) = program_text else {
        return fail("awk: missing program\n".to_string(), 1);
    };

    let rules = match parse_program(&program_text) {
        Ok(r) => r,
        Err(e) => return fail(format!("awk: syntax error: {e}\n"), 1),
    };

    let mut ctx = Ctx::new();
    if let Some(fs) = fs_override {
        ctx.fs = interpret_fs_flag(&fs);
    }
    for (k, v) in assignments {
        ctx.set_var(&k, Value::StrNum(v));
    }

    // BEGIN
    for rule in &rules {
        if let Pattern::Begin = rule.pattern
            && let Some(action) = &rule.action
        {
            match exec_stmt(&mut ctx, action) {
                Ok(Flow::Exit) => {
                    return finish(&mut ctx, &rules, false);
                }
                Ok(_) => {}
                Err(e) => return fail(format!("awk: {e}\n"), 1),
            }
        }
    }

    let needs_input = rules.iter().any(|r| !matches!(r.pattern, Pattern::Begin));
    if needs_input {
        // Build the (filename, content) list, defaulting to stdin.
        let sources: Vec<(String, Result<String, String>)> = if files.is_empty() {
            vec![("".to_string(), Ok(stdin))]
        } else {
            files
                .iter()
                .map(|f| {
                    let path = normalize_path(&interp.cwd, f);
                    if interp.fs.is_dir(&path) {
                        (f.clone(), Err(format!("awk: {f}: Is a directory")))
                    } else {
                        match interp.fs.read_file(&path).as_deref() {
                            Some(bytes) => {
                                (f.clone(), Ok(String::from_utf8_lossy(bytes).into_owned()))
                            }
                            None => (
                                f.clone(),
                                Err(format!("awk: {f}: No such file or directory")),
                            ),
                        }
                    }
                })
                .collect()
        };

        'outer: for (filename, content) in sources {
            let content = match content {
                Ok(c) => c,
                Err(e) => return fail(format!("{e}\n"), 1),
            };
            ctx.filename = filename;
            ctx.fnr = 0;
            for record in split_records(&content) {
                ctx.nr += 1;
                ctx.fnr += 1;
                ctx.set_record(record);
                for rule in &rules {
                    let matched = match &rule.pattern {
                        Pattern::Begin | Pattern::End => false,
                        Pattern::Always => true,
                        Pattern::Expr(e) => match eval_expr(&mut ctx, e) {
                            Ok(v) => v.truthy(),
                            Err(err) => return fail(format!("awk: {err}\n"), 1),
                        },
                    };
                    if !matched {
                        continue;
                    }
                    let flow = match &rule.action {
                        Some(action) => exec_stmt(&mut ctx, action),
                        None => exec_stmt(&mut ctx, &Stmt::Print(vec![])),
                    };
                    match flow {
                        Ok(Flow::Next) => break,
                        Ok(Flow::Exit) => break 'outer,
                        Ok(_) => {}
                        Err(e) => return fail(format!("awk: {e}\n"), 1),
                    }
                }
            }
        }
    }

    finish(&mut ctx, &rules, true)
}

fn finish(ctx: &mut Ctx, rules: &[Rule], run_end: bool) -> CommandOutput {
    if run_end {
        for rule in rules {
            if let Pattern::End = rule.pattern
                && let Some(action) = &rule.action
            {
                match exec_stmt(ctx, action) {
                    Ok(_) => {}
                    Err(e) => return fail(format!("awk: {e}\n"), 1),
                }
            }
        }
    }
    let exit_code = ctx.exit_code.unwrap_or(0);
    if exit_code != 0 {
        CommandOutput {
            stdout: std::mem::take(&mut ctx.stdout),
            stderr: String::new(),
            exit_code,
        }
    } else {
        ok(std::mem::take(&mut ctx.stdout))
    }
}

/// `-F` treats a literal `\t` (as typed on the command line) as a tab, same
/// as upstream and real awk/gawk.
fn interpret_fs_flag(fs: &str) -> String {
    if fs == "\\t" {
        "\t".to_string()
    } else {
        fs.to_string()
    }
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

    fn with_file(path: &str, content: &str) -> Bash {
        let mut bash = fresh();
        bash.fs_mut().write_file(path, content.as_bytes()).unwrap();
        bash
    }

    // ---- awk.test.ts ----

    #[test]
    fn escape_sequences() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, r#"awk 'BEGIN { print "H\x49\x4a\x4BL" }'"#).stdout,
            "HIJKL\n"
        );
        assert_eq!(
            run(&mut bash, r#"awk 'BEGIN { print "0\061\62x\0645" }'"#).stdout,
            "012x45\n"
        );
    }

    #[test]
    fn nf_zero_for_empty_line() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "echo '' | awk '{ print NF }'").stdout, "0\n");
    }

    #[test]
    fn basic_field_access() {
        let mut bash = with_file("/data.txt", "hello world\nfoo bar\n");
        assert_eq!(
            run(&mut bash, "awk '{print $0}' /data.txt").stdout,
            "hello world\nfoo bar\n"
        );
        assert_eq!(
            run(&mut bash, "awk '{print $1}' /data.txt").stdout,
            "hello\nfoo\n"
        );
    }

    #[test]
    fn multiple_fields_and_missing() {
        let mut bash = with_file("/data.txt", "a b c\n1 2 3\n");
        assert_eq!(
            run(&mut bash, "awk '{print $1, $3}' /data.txt").stdout,
            "a c\n1 3\n"
        );
        let mut bash2 = with_file("/data.txt", "one\ntwo three\n");
        assert_eq!(
            run(&mut bash2, "awk '{ print $2 }' /data.txt").stdout,
            "\nthree\n"
        );
    }

    #[test]
    fn field_separator_flag() {
        let mut bash = with_file("/data.csv", "a,b,c\n1,2,3\n");
        assert_eq!(
            run(&mut bash, "awk -F',' '{print $2}' /data.csv").stdout,
            "b\n2\n"
        );
        let mut bash2 = with_file("/data.csv", "a:b:c\n");
        assert_eq!(
            run(&mut bash2, "awk -F: '{print $2}' /data.csv").stdout,
            "b\n"
        );
    }

    #[test]
    fn dash_v_assignment() {
        let mut bash = with_file("/data.txt", "test\n");
        let r = run(
            &mut bash,
            "awk -v name=World '{print \"Hello \" name}' /data.txt",
        );
        assert_eq!(r.stdout, "Hello World\n");
    }

    #[test]
    fn nr_and_nf() {
        let mut bash = with_file("/data.txt", "a\nb\nc\n");
        assert_eq!(
            run(&mut bash, "awk '{print NR, $0}' /data.txt").stdout,
            "1 a\n2 b\n3 c\n"
        );
        let mut bash2 = with_file("/data.txt", "one\ntwo three\na b c d\n");
        assert_eq!(
            run(&mut bash2, "awk '{print NF}' /data.txt").stdout,
            "1\n2\n4\n"
        );
    }

    #[test]
    fn begin_end_blocks() {
        let mut bash = with_file("/data.txt", "a\nb\n");
        assert_eq!(
            run(
                &mut bash,
                "awk 'BEGIN{print \"start\"}{print $0}' /data.txt"
            )
            .stdout,
            "start\na\nb\n"
        );
        let mut bash2 = with_file("/data.txt", "a\nb\n");
        assert_eq!(
            run(&mut bash2, "awk '{print $0}END{print \"done\"}' /data.txt").stdout,
            "a\nb\ndone\n"
        );
        let mut bash3 = with_file("/empty.txt", "");
        assert_eq!(
            run(&mut bash3, "awk 'BEGIN{print \"hello\"}' /empty.txt").stdout,
            "hello\n"
        );
    }

    #[test]
    fn pattern_matching() {
        let mut bash = with_file("/data.txt", "apple\nbanana\napricot\ncherry\n");
        assert_eq!(
            run(&mut bash, "awk '/^a/{print}' /data.txt").stdout,
            "apple\napricot\n"
        );
        let mut bash2 = with_file("/data.txt", "line1\nline2\nline3\n");
        assert_eq!(
            run(&mut bash2, "awk 'NR==2{print}' /data.txt").stdout,
            "line2\n"
        );
        assert_eq!(
            run(&mut bash2, "awk 'NR>1{print}' /data.txt").stdout,
            "line2\nline3\n"
        );
    }

    #[test]
    fn printf_basic() {
        let mut bash = with_file("/data.txt", "hello world\n");
        assert_eq!(
            run(&mut bash, "awk '{printf \"%s!\\n\", $1}' /data.txt").stdout,
            "hello!\n"
        );
        let mut bash2 = with_file("/data.txt", "42\n");
        assert_eq!(
            run(&mut bash2, "awk '{printf \"num: %d\\n\", $1}' /data.txt").stdout,
            "num: 42\n"
        );
    }

    #[test]
    fn stdin_input() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, "echo 'a b c' | awk '{print $2}'").stdout,
            "b\n"
        );
    }

    #[test]
    fn error_handling() {
        let mut bash = fresh();
        let r = run(&mut bash, "awk");
        assert_eq!(r.exit_code, 1);
        assert!(r.stderr.contains("missing program"));
        let r = run(&mut bash, "awk '{print}' /nonexistent.txt");
        assert_eq!(r.exit_code, 1);
        assert!(r.stderr.contains("No such file"));
        let r = run(&mut bash, "awk --help");
        assert!(r.stdout.contains("awk"));
        assert!(r.stdout.contains("pattern scanning"));
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    fn string_concatenation_and_arithmetic() {
        let mut bash = with_file("/data.txt", "hello world\n");
        assert_eq!(
            run(&mut bash, "awk '{print $1 \"-\" $2}' /data.txt").stdout,
            "hello-world\n"
        );
        let mut bash2 = with_file("/data.txt", "10 20\n5 15\n");
        assert_eq!(
            run(&mut bash2, "awk '{print $1 + $2}' /data.txt").stdout,
            "30\n20\n"
        );
    }

    #[test]
    fn compound_assignment() {
        let mut bash = with_file("/data.txt", "10\n20\n30\n");
        assert_eq!(
            run(
                &mut bash,
                "awk 'BEGIN{sum=0}{sum+=$1}END{print sum}' /data.txt"
            )
            .stdout,
            "60\n"
        );
        let mut bash2 = with_file("/data.txt", "2\n5\n");
        assert_eq!(
            run(
                &mut bash2,
                "awk 'BEGIN{val=100}{val/=$1}END{print val}' /data.txt"
            )
            .stdout,
            "10\n"
        );
    }

    #[test]
    fn increment_decrement() {
        let mut bash = with_file("/data.txt", "a\nb\nc\n");
        assert_eq!(
            run(&mut bash, "awk 'BEGIN{n=0}{n++}END{print n}' /data.txt").stdout,
            "3\n"
        );
        let mut bash2 = with_file("/data.txt", "x\ny\n");
        assert_eq!(
            run(&mut bash2, "awk 'BEGIN{n=0}{++n}END{print n}' /data.txt").stdout,
            "2\n"
        );
    }

    #[test]
    fn compound_conditions() {
        let mut bash = with_file("/data.txt", "1 10\n2 20\n3 30\n4 40\n5 50\n");
        assert_eq!(
            run(&mut bash, "awk '$1>=2 && $1<=4{print}' /data.txt").stdout,
            "2 20\n3 30\n4 40\n"
        );
        let mut bash2 = with_file("/data.txt", "1 a\n2 b\n3 c\n4 d\n5 e\n");
        assert_eq!(
            run(&mut bash2, "awk '$1==1 || $1==5{print}' /data.txt").stdout,
            "1 a\n5 e\n"
        );
    }

    #[test]
    fn variable_comparisons() {
        let mut bash = with_file("/data.txt", "10\n25\n15\n30\n5\n");
        let r = run(
            &mut bash,
            "awk -v threshold=20 '$1>threshold{print}' /data.txt",
        );
        assert_eq!(r.stdout, "25\n30\n");
        let mut bash2 = with_file("/data.txt", "10\n25\n15\n30\n5\n");
        assert_eq!(
            run(
                &mut bash2,
                "awk 'BEGIN{max=0}$1>max{max=$1}END{print max}' /data.txt"
            )
            .stdout,
            "30\n"
        );
    }

    #[test]
    fn match_rstart_rlength() {
        let mut bash = with_file("/data.txt", "hello foo world\n");
        let r = run(
            &mut bash,
            "awk '{print match($0, /foo/), RSTART, RLENGTH}' /data.txt",
        );
        assert_eq!(r.stdout, "7 7 3\n");
        let mut bash2 = with_file("/data.txt", "hello world\n");
        let r2 = run(
            &mut bash2,
            "awk '{print match($0, /foo/), RSTART, RLENGTH}' /data.txt",
        );
        assert_eq!(r2.stdout, "0 0 -1\n");
    }

    #[test]
    fn gensub_variants() {
        let mut bash = with_file("/data.txt", "hello world\n");
        assert_eq!(
            run(
                &mut bash,
                r#"awk '{print gensub(/o/, "0", "g")}' /data.txt"#
            )
            .stdout,
            "hell0 w0rld\n"
        );
        let mut bash2 = with_file("/data.txt", "foo bar foo baz foo\n");
        assert_eq!(
            run(
                &mut bash2,
                r#"awk '{print gensub(/foo/, "XXX", 2)}' /data.txt"#
            )
            .stdout,
            "foo bar XXX baz foo\n"
        );
    }

    #[test]
    fn power_operator() {
        let mut bash = with_file("/data.txt", "test\n");
        assert_eq!(run(&mut bash, "awk '{print 2^3}' /data.txt").stdout, "8\n");
        assert_eq!(run(&mut bash, "awk '{print 3**2}' /data.txt").stdout, "9\n");
    }

    #[test]
    fn filename_and_fnr() {
        let mut bash = with_file("/data.txt", "line1\nline2\n");
        assert_eq!(
            run(&mut bash, "awk '{print FILENAME, NR}' /data.txt").stdout,
            "/data.txt 1\n/data.txt 2\n"
        );
        let mut bash2 = fresh();
        bash2.fs_mut().write_file("/a.txt", b"a1\na2\n").unwrap();
        bash2.fs_mut().write_file("/b.txt", b"b1\nb2\n").unwrap();
        let r = run(&mut bash2, "awk '{print FILENAME, FNR, NR}' /a.txt /b.txt");
        assert_eq!(r.stdout, "/a.txt 1 1\n/a.txt 2 2\n/b.txt 1 3\n/b.txt 2 4\n");
    }

    #[test]
    fn exit_and_next() {
        let mut bash = with_file("/data.txt", "line1\nline2\nline3\n");
        assert_eq!(run(&mut bash, "awk 'NR==2{exit 5}' /data.txt").exit_code, 5);
        let mut bash2 = with_file("/data.txt", "a\nb\nc\n");
        assert_eq!(
            run(&mut bash2, "awk '/b/{next}{print}' /data.txt").stdout,
            "a\nc\n"
        );
    }

    #[test]
    fn do_while_and_loops() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, "awk 'BEGIN{i=0; do{i++}while(i<3); print i}'").stdout,
            "3\n"
        );
        let mut bash2 = fresh();
        assert_eq!(
            run(
                &mut bash2,
                "awk 'BEGIN{for(i=1;i<=10;i++){if(i==5)break; print i}}'"
            )
            .stdout,
            "1\n2\n3\n4\n"
        );
        let mut bash3 = fresh();
        assert_eq!(
            run(
                &mut bash3,
                "awk 'BEGIN{for(i=1;i<=5;i++){if(i==3)continue; print i}}'"
            )
            .stdout,
            "1\n2\n4\n5\n"
        );
    }

    #[test]
    fn printf_hex_octal_char_exp() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, "awk 'BEGIN{printf \"%x\\n\", 255}'").stdout,
            "ff\n"
        );
        assert_eq!(
            run(&mut bash, "awk 'BEGIN{printf \"%o\\n\", 8}'").stdout,
            "10\n"
        );
        assert_eq!(
            run(&mut bash, "awk 'BEGIN{printf \"%c\\n\", 65}'").stdout,
            "A\n"
        );
        assert_eq!(
            run(&mut bash, "awk 'BEGIN{printf \"%.2e\\n\", 1234}'").stdout,
            "1.23e+3\n"
        );
    }

    #[test]
    fn regex_field_separator() {
        let mut bash = with_file("/data.txt", "a1b2c\n");
        let r = run(&mut bash, "awk -F'[0-9]+' '{print $1, $2, $3}' /data.txt");
        assert_eq!(r.stdout, "a b c\n");
    }

    // ---- awk.fields.test.ts ----

    #[test]
    fn field_modification_and_extension() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, r#"echo "a b c" | awk '{ $2 = "X"; print }'"#).stdout,
            "a X c\n"
        );
        let mut bash2 = fresh();
        assert_eq!(
            run(
                &mut bash2,
                r#"echo "a b" | awk '{ $5 = "e"; print NF, $0 }'"#
            )
            .stdout,
            "5 a b   e\n"
        );
        let mut bash3 = fresh();
        assert_eq!(
            run(&mut bash3, r#"echo "a b c" | awk '{ $NF = "C"; print }'"#).stdout,
            "a b C\n"
        );
    }

    #[test]
    fn nf_truncation() {
        let mut bash = fresh();
        let r = run(
            &mut bash,
            r#"echo "a b c d e" | awk '{ NF = 2; print $0 }'"#,
        );
        assert_eq!(r.stdout, "a b\n");
    }

    #[test]
    fn ofs_and_ors() {
        let mut bash = fresh();
        assert_eq!(
            run(
                &mut bash,
                r#"echo "a b c" | awk 'BEGIN{OFS=","}{print $1,$2,$3}'"#
            )
            .stdout,
            "a,b,c\n"
        );
        let mut bash2 = with_file("/data.txt", "line1\nline2\nline3\n");
        assert_eq!(
            run(&mut bash2, r#"awk 'BEGIN{ORS=";"} { print }' /data.txt"#).stdout,
            "line1;line2;line3;"
        );
    }

    // ---- awk.strings.test.ts ----

    #[test]
    fn substr_variants() {
        let mut bash = fresh();
        assert_eq!(
            run(
                &mut bash,
                r#"echo "hello world" | awk '{ print substr($0, 7) }'"#
            )
            .stdout,
            "world\n"
        );
        assert_eq!(
            run(
                &mut bash,
                r#"echo "hello world" | awk '{ print substr($0, 1, 5) }'"#
            )
            .stdout,
            "hello\n"
        );
        assert_eq!(
            run(
                &mut bash,
                r#"echo "hello" | awk '{ print substr($0, 0, 3) }'"#
            )
            .stdout,
            "hel\n"
        );
        assert_eq!(
            run(
                &mut bash,
                r#"echo "" | awk 'BEGIN { print "[" substr("abc", 10) "]" }'"#
            )
            .stdout,
            "[]\n"
        );
        assert_eq!(
            run(
                &mut bash,
                r#"echo "" | awk 'BEGIN { print substr("abcdefgh", 3, 4) }'"#
            )
            .stdout,
            "cdef\n"
        );
    }

    #[test]
    fn index_function() {
        let mut bash = fresh();
        assert_eq!(
            run(
                &mut bash,
                r#"echo "" | awk 'BEGIN { print index("hello world", "world") }'"#
            )
            .stdout,
            "7\n"
        );
        assert_eq!(
            run(
                &mut bash,
                r#"echo "" | awk 'BEGIN { print index("hello", "xyz") }'"#
            )
            .stdout,
            "0\n"
        );
        assert_eq!(
            run(
                &mut bash,
                r#"echo "" | awk 'BEGIN { print index("abcdef", "c") }'"#
            )
            .stdout,
            "3\n"
        );
        assert_eq!(
            run(
                &mut bash,
                r#"echo "" | awk 'BEGIN { print index("abcabc", "bc") }'"#
            )
            .stdout,
            "2\n"
        );
        assert_eq!(
            run(
                &mut bash,
                r#"echo "" | awk 'BEGIN { print index("hello", "") }'"#
            )
            .stdout,
            "1\n"
        );
    }

    #[test]
    fn case_conversion() {
        let mut bash = fresh();
        assert_eq!(
            run(
                &mut bash,
                r#"echo "HELLO WORLD" | awk '{ print tolower($0) }'"#
            )
            .stdout,
            "hello world\n"
        );
        assert_eq!(
            run(
                &mut bash,
                r#"echo "hello world" | awk '{ print toupper($0) }'"#
            )
            .stdout,
            "HELLO WORLD\n"
        );
    }

    #[test]
    fn sub_and_gsub() {
        let mut bash = fresh();
        assert_eq!(
            run(
                &mut bash,
                r#"echo "hello hello" | awk '{ sub(/hello/, "hi"); print }'"#
            )
            .stdout,
            "hi hello\n"
        );
        let mut bash2 = fresh();
        assert_eq!(
            run(
                &mut bash2,
                r#"echo "hello" | awk '{ n = sub(/l/, "L"); print n, $0 }'"#
            )
            .stdout,
            "1 heLlo\n"
        );
        let mut bash3 = fresh();
        assert_eq!(
            run(
                &mut bash3,
                r#"echo "test" | awk '{ x = "foo bar foo"; sub(/foo/, "baz", x); print x }'"#
            )
            .stdout,
            "baz bar foo\n"
        );
        let mut bash4 = fresh();
        assert_eq!(
            run(
                &mut bash4,
                r#"echo "hello" | awk '{ sub(/ll/, "[&]"); print }'"#
            )
            .stdout,
            "he[ll]o\n"
        );
        let mut bash5 = fresh();
        assert_eq!(
            run(
                &mut bash5,
                r#"echo "hello hello hello" | awk '{ gsub(/hello/, "hi"); print }'"#
            )
            .stdout,
            "hi hi hi\n"
        );
        let mut bash6 = fresh();
        assert_eq!(
            run(
                &mut bash6,
                r#"echo "ababa" | awk '{ n = gsub(/a/, "X"); print n, $0 }'"#
            )
            .stdout,
            "3 XbXbX\n"
        );
        let mut bash7 = fresh();
        assert_eq!(
            run(
                &mut bash7,
                r#"echo "aaa bbb aaa" | awk '{ gsub(/a/, "X", $1); print }'"#
            )
            .stdout,
            "XXX bbb aaa\n"
        );
    }

    #[test]
    fn sprintf_and_concat_and_compare() {
        let mut bash = fresh();
        assert_eq!(
            run(
                &mut bash,
                r#"awk 'BEGIN{ print sprintf("%s = %d", "x", 42) }'"#
            )
            .stdout,
            "x = 42\n"
        );
    }

    // ---- awk.ternary.test.ts ----

    #[test]
    fn ternary_operator() {
        let mut bash = fresh();
        assert_eq!(
            run(
                &mut bash,
                r#"echo "" | awk 'BEGIN { print 1 ? "yes" : "no" }'"#
            )
            .stdout,
            "yes\n"
        );
        assert_eq!(
            run(
                &mut bash,
                r#"echo "" | awk 'BEGIN { print 0 ? "yes" : "no" }'"#
            )
            .stdout,
            "no\n"
        );
        assert_eq!(
            run(&mut bash, r#"echo "" | awk 'BEGIN { x = 0; print x > 0 ? "positive" : x < 0 ? "negative" : "zero" }'"#)
                .stdout,
            "zero\n"
        );
    }

    // ---- awk.operators.test.ts ----

    #[test]
    fn regex_match_operators() {
        let mut bash = with_file("/data.txt", "apple\nbanana\ncherry\n");
        assert_eq!(
            run(&mut bash, "awk '$0 ~ /^a/ { print }' /data.txt").stdout,
            "apple\n"
        );
        assert_eq!(
            run(&mut bash, "awk '$0 !~ /^a/ { print }' /data.txt").stdout,
            "banana\ncherry\n"
        );
    }

    #[test]
    fn modulo_and_negative_modulo() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, "echo \"\" | awk 'BEGIN { print 17 % 5 }'").stdout,
            "2\n"
        );
        assert_eq!(
            run(&mut bash, "echo \"\" | awk 'BEGIN { print -17 % 5 }'").stdout,
            "-2\n"
        );
    }

    // ---- split() ----

    #[test]
    fn split_builtin() {
        let mut bash = fresh();
        let r = run(
            &mut bash,
            r#"echo "a,b,c" | awk '{ n = split($0, arr, ","); print n, arr[1], arr[2], arr[3] }'"#,
        );
        assert_eq!(r.stdout, "3 a b c\n");
    }
}
