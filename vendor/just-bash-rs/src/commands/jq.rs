//! PORT (partial): vendor/just-bash/src/commands/jq/*.ts +
//! vendor/just-bash/src/commands/query-engine/*.ts
//!
//! A practical subset of jq, not full upstream fidelity: upstream's query
//! engine is ~3300 LOC across parser/evaluator/a dozen builtin modules with
//! resource-limit bookkeeping this port doesn't need (the agent shell isn't
//! adversarial). This is a from-scratch hand-rolled scanner-parser (not a
//! line-by-line port of `query-engine/parser.ts` + `evaluator.ts`) producing
//! a `Filter` AST evaluated directly over `serde_json::Value`.
//!
//! Supported: identity `.`, field access `.foo`/`.foo.bar` (with `?` after
//! any postfix step), `.[0]`/`.foo[0]` indexing (negative indices), `.[]`
//! iteration, `.[a:b]` slicing (arrays and strings), `|` and `,`, object
//! construction `{a: .b, c, (.k): .v}`, array construction `[...]`, string
//! interpolation `"\(expr)"`, `if/then/elif/else/end`, the `//` alternative
//! operator, `and`/`or`, comparisons `== != < <= > >=` (full jq typed
//! ordering: null < bool < number < string < array < object), arithmetic
//! `+ - * / %` with jq's per-type rules (string/array concat, shallow object
//! merge on `+`, deep merge on `*` of two objects, string split on `/`),
//! literals, the `@tsv` formatter, and the builtins `length keys keys_unsorted has empty not type
//! select map add range floor ceil round sqrt abs tostring tonumber fromjson tojson split
//! join`. CLI flags: `-r`/`-R`/`-c`/`-n`/`-s`/`-e`/`--tab`/`-S`.
//!
//! Explicitly out of scope (skipped, not started): `reduce`/`foreach`,
//! custom `def`, `try`/`catch` (bare `?` is supported, full `try` is not),
//! `path()`/`paths`, variables (`... as $x |`), `@base64`/`@csv`-style format
//! strings, module imports, `input`/`inputs` streaming,
//! regex builtins (`test`/`match`/`sub`/`gsub`/`capture`), and resource
//! other `@` format strings, and resource limits (upstream's
//! `ExecutionLimitError` machinery).

use serde_json::{Map, Number, Value};

use super::{fail, ok};
use crate::interpreter::CommandOutput;

// ============================================================================
// AST
// ============================================================================

#[derive(Debug, Clone)]
enum Filter {
    Identity,
    Field(Box<Filter>, String),
    Index(Box<Filter>, Box<Filter>),
    Iterate(Box<Filter>),
    Slice(Box<Filter>, Option<Box<Filter>>, Option<Box<Filter>>),
    Optional(Box<Filter>),
    Pipe(Box<Filter>, Box<Filter>),
    Comma(Box<Filter>, Box<Filter>),
    Literal(Value),
    StringInterp(Vec<StrPart>),
    Format(String),
    ArrayConstruct(Option<Box<Filter>>),
    ObjectConstruct(Vec<(ObjKey, Filter)>),
    Call(String, Vec<Filter>),
    Neg(Box<Filter>),
    BinOp(&'static str, Box<Filter>, Box<Filter>),
    And(Box<Filter>, Box<Filter>),
    Or(Box<Filter>, Box<Filter>),
    Alt(Box<Filter>, Box<Filter>),
    If(Box<Filter>, Box<Filter>, Box<Filter>),
}

#[derive(Debug, Clone)]
enum ObjKey {
    Literal(String),
    Dynamic(Filter),
}

#[derive(Debug, Clone)]
enum StrPart {
    Lit(String),
    Expr(Filter),
}

// ============================================================================
// Parser (combined scanner + recursive descent, no separate token pass so
// string interpolation can recurse into the same char cursor)
// ============================================================================

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

type PResult<T> = Result<T, String>;

impl Parser {
    fn new(src: &str) -> Self {
        Parser {
            chars: src.chars().collect(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.pos + offset).copied()
    }

    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_whitespace()) {
            self.pos += 1;
        }
    }

    fn eof(&self) -> bool {
        self.pos >= self.chars.len()
    }

    fn starts_with(&self, s: &str) -> bool {
        s.chars()
            .enumerate()
            .all(|(i, c)| self.peek_at(i) == Some(c))
    }

    /// Consume `s` if it's next (after skipping leading whitespace already
    /// done by the caller), also requiring the following char isn't an
    /// identifier char for keyword-like tokens (`and`, `or`, ...).
    fn eat_keyword(&mut self, kw: &str) -> bool {
        self.skip_ws();
        if self.starts_with(kw) {
            let after = self.peek_at(kw.len());
            if !matches!(after, Some(c) if c.is_alphanumeric() || c == '_') {
                self.pos += kw.len();
                return true;
            }
        }
        false
    }

    fn eat_char(&mut self, c: char) -> bool {
        self.skip_ws();
        if self.peek() == Some(c) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn expect_char(&mut self, c: char) -> PResult<()> {
        if self.eat_char(c) {
            Ok(())
        } else {
            Err(format!("jq: expected '{c}' near position {}", self.pos))
        }
    }

    // ---- top-level entry ----

    fn parse_program(&mut self) -> PResult<Filter> {
        let f = self.parse_pipe()?;
        self.skip_ws();
        if !self.eof() {
            return Err(format!(
                "unexpected trailing input at position {}",
                self.pos
            ));
        }
        Ok(f)
    }

    fn parse_pipe(&mut self) -> PResult<Filter> {
        let mut left = self.parse_comma()?;
        loop {
            if self.eat_char('|') {
                // Don't consume `//` or `||`-style two-char operators here;
                // `|` alone is unambiguous in this grammar.
                let right = self.parse_comma()?;
                left = Filter::Pipe(Box::new(left), Box::new(right));
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn parse_comma(&mut self) -> PResult<Filter> {
        let mut left = self.parse_alt()?;
        loop {
            self.skip_ws();
            if self.peek() == Some(',') {
                self.pos += 1;
                let right = self.parse_alt()?;
                left = Filter::Comma(Box::new(left), Box::new(right));
            } else {
                break;
            }
        }
        Ok(left)
    }

    /// Object-value grammar: pipe-chained but comma terminates the pair.
    fn parse_obj_value(&mut self) -> PResult<Filter> {
        let mut left = self.parse_alt()?;
        loop {
            self.skip_ws();
            if self.peek() == Some('|') {
                self.pos += 1;
                let right = self.parse_alt()?;
                left = Filter::Pipe(Box::new(left), Box::new(right));
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn parse_alt(&mut self) -> PResult<Filter> {
        let mut left = self.parse_or()?;
        loop {
            self.skip_ws();
            if self.starts_with("//") {
                self.pos += 2;
                let right = self.parse_or()?;
                left = Filter::Alt(Box::new(left), Box::new(right));
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn parse_or(&mut self) -> PResult<Filter> {
        let mut left = self.parse_and()?;
        loop {
            if self.eat_keyword("or") {
                let right = self.parse_and()?;
                left = Filter::Or(Box::new(left), Box::new(right));
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> PResult<Filter> {
        let mut left = self.parse_cmp()?;
        loop {
            if self.eat_keyword("and") {
                let right = self.parse_cmp()?;
                left = Filter::And(Box::new(left), Box::new(right));
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn parse_cmp(&mut self) -> PResult<Filter> {
        let left = self.parse_add()?;
        self.skip_ws();
        let op = if self.starts_with("==") {
            Some("==")
        } else if self.starts_with("!=") {
            Some("!=")
        } else if self.starts_with("<=") {
            Some("<=")
        } else if self.starts_with(">=") {
            Some(">=")
        } else if self.peek() == Some('<') {
            Some("<")
        } else if self.peek() == Some('>') {
            Some(">")
        } else {
            None
        };
        if let Some(op) = op {
            self.pos += op.len();
            let right = self.parse_add()?;
            return Ok(Filter::BinOp(op, Box::new(left), Box::new(right)));
        }
        Ok(left)
    }

    fn parse_add(&mut self) -> PResult<Filter> {
        let mut left = self.parse_mul()?;
        loop {
            self.skip_ws();
            match self.peek() {
                Some('+') => {
                    self.pos += 1;
                    let right = self.parse_mul()?;
                    left = Filter::BinOp("+", Box::new(left), Box::new(right));
                }
                Some('-') => {
                    self.pos += 1;
                    let right = self.parse_mul()?;
                    left = Filter::BinOp("-", Box::new(left), Box::new(right));
                }
                _ => break,
            }
        }
        Ok(left)
    }

    fn parse_mul(&mut self) -> PResult<Filter> {
        let mut left = self.parse_unary()?;
        loop {
            self.skip_ws();
            match self.peek() {
                Some('*') => {
                    self.pos += 1;
                    let right = self.parse_unary()?;
                    left = Filter::BinOp("*", Box::new(left), Box::new(right));
                }
                Some('/') if self.peek_at(1) != Some('/') => {
                    self.pos += 1;
                    let right = self.parse_unary()?;
                    left = Filter::BinOp("/", Box::new(left), Box::new(right));
                }
                Some('%') => {
                    self.pos += 1;
                    let right = self.parse_unary()?;
                    left = Filter::BinOp("%", Box::new(left), Box::new(right));
                }
                _ => break,
            }
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> PResult<Filter> {
        self.skip_ws();
        if self.peek() == Some('-') && !self.starts_with("--") {
            self.pos += 1;
            let inner = self.parse_postfix()?;
            return Ok(Filter::Neg(Box::new(inner)));
        }
        self.parse_postfix()
    }

    fn parse_postfix(&mut self) -> PResult<Filter> {
        let mut base = self.parse_primary()?;
        base = self.maybe_optional(base);
        loop {
            self.skip_ws();
            if self.peek() == Some('.')
                && matches!(self.peek_at(1), Some(c) if c.is_alphabetic() || c == '_')
            {
                self.pos += 1;
                let name = self.read_ident();
                base = Filter::Field(Box::new(base), name);
            } else if self.peek() == Some('.') && self.peek_at(1) == Some('[') {
                self.pos += 1;
                base = self.parse_bracket_suffix(base)?;
            } else if self.peek() == Some('[') {
                base = self.parse_bracket_suffix(base)?;
            } else {
                break;
            }
            // `?` binds to the nearest preceding postfix step.
            base = self.maybe_optional(base);
        }
        Ok(base)
    }

    /// Consumes a trailing `?` (but not `?//` alternative-destructuring or
    /// `?=`, neither of which this subset supports) and wraps `base`.
    fn maybe_optional(&mut self, base: Filter) -> Filter {
        self.skip_ws();
        if self.peek() == Some('?') && self.peek_at(1) != Some('/') && self.peek_at(1) != Some('=')
        {
            self.pos += 1;
            Filter::Optional(Box::new(base))
        } else {
            base
        }
    }

    /// Parses `[ ... ]` (index / slice / iterate) after `base`.
    fn parse_bracket_suffix(&mut self, base: Filter) -> PResult<Filter> {
        self.expect_char('[')?;
        self.skip_ws();
        if self.peek() == Some(']') {
            self.pos += 1;
            return Ok(Filter::Iterate(Box::new(base)));
        }
        if self.peek() == Some(':') {
            self.pos += 1;
            let hi = self.parse_pipe()?;
            self.expect_char(']')?;
            return Ok(Filter::Slice(Box::new(base), None, Some(Box::new(hi))));
        }
        let first = self.parse_pipe()?;
        self.skip_ws();
        if self.peek() == Some(':') {
            self.pos += 1;
            self.skip_ws();
            if self.peek() == Some(']') {
                self.pos += 1;
                return Ok(Filter::Slice(Box::new(base), Some(Box::new(first)), None));
            }
            let hi = self.parse_pipe()?;
            self.expect_char(']')?;
            return Ok(Filter::Slice(
                Box::new(base),
                Some(Box::new(first)),
                Some(Box::new(hi)),
            ));
        }
        self.expect_char(']')?;
        Ok(Filter::Index(Box::new(base), Box::new(first)))
    }

    fn read_ident(&mut self) -> String {
        let start = self.pos;
        while matches!(self.peek(), Some(c) if c.is_alphanumeric() || c == '_') {
            self.pos += 1;
        }
        self.chars[start..self.pos].iter().collect()
    }

    fn parse_primary(&mut self) -> PResult<Filter> {
        self.skip_ws();
        match self.peek() {
            None => Err("unexpected end of filter".to_string()),
            Some('.') => {
                self.pos += 1;
                if matches!(self.peek(), Some(c) if c.is_alphabetic() || c == '_') {
                    let name = self.read_ident();
                    Ok(Filter::Field(Box::new(Filter::Identity), name))
                } else if self.peek() == Some('[') {
                    self.parse_bracket_suffix(Filter::Identity)
                } else {
                    Ok(Filter::Identity)
                }
            }
            Some('(') => {
                self.pos += 1;
                let inner = self.parse_pipe()?;
                self.expect_char(')')?;
                Ok(inner)
            }
            Some('[') => {
                self.pos += 1;
                self.skip_ws();
                if self.peek() == Some(']') {
                    self.pos += 1;
                    return Ok(Filter::ArrayConstruct(None));
                }
                let inner = self.parse_pipe()?;
                self.expect_char(']')?;
                Ok(Filter::ArrayConstruct(Some(Box::new(inner))))
            }
            Some('{') => self.parse_object(),
            Some('"') => {
                let parts = self.parse_string_parts()?;
                Ok(string_parts_to_filter(parts))
            }
            Some('@') => {
                self.pos += 1;
                let name = self.read_ident();
                if name == "tsv" {
                    Ok(Filter::Format(name))
                } else {
                    Err(format!("unsupported format '@{name}'"))
                }
            }
            Some(c) if c.is_ascii_digit() => self.parse_number(),
            Some(c) if c.is_alphabetic() || c == '_' => {
                let name = self.read_ident();
                match name.as_str() {
                    "true" => Ok(Filter::Literal(Value::Bool(true))),
                    "false" => Ok(Filter::Literal(Value::Bool(false))),
                    "null" => Ok(Filter::Literal(Value::Null)),
                    "if" => self.parse_if(),
                    _ => {
                        self.skip_ws();
                        let mut args = Vec::new();
                        if self.peek() == Some('(') {
                            self.pos += 1;
                            loop {
                                args.push(self.parse_alt()?);
                                self.skip_ws();
                                if self.peek() == Some(';') || self.peek() == Some(',') {
                                    self.pos += 1;
                                } else {
                                    break;
                                }
                            }
                            self.expect_char(')')?;
                        }
                        Ok(Filter::Call(name, args))
                    }
                }
            }
            Some(c) => Err(format!(
                "unexpected character '{c}' at position {}",
                self.pos
            )),
        }
    }

    fn parse_if(&mut self) -> PResult<Filter> {
        let cond = self.parse_pipe()?;
        if !self.eat_keyword("then") {
            return Err("expected 'then'".to_string());
        }
        let then_branch = self.parse_pipe()?;
        self.skip_ws();
        if self.eat_keyword("elif") {
            // Recurse: treat `elif ... ` like a nested `if ...` that ends in
            // the same `end`, matching upstream's elif-as-if desugaring.
            let else_branch = self.parse_if_tail()?;
            return Ok(Filter::If(
                Box::new(cond),
                Box::new(then_branch),
                Box::new(else_branch),
            ));
        }
        if self.eat_keyword("else") {
            let else_branch = self.parse_pipe()?;
            if !self.eat_keyword("end") {
                return Err("expected 'end'".to_string());
            }
            return Ok(Filter::If(
                Box::new(cond),
                Box::new(then_branch),
                Box::new(else_branch),
            ));
        }
        if !self.eat_keyword("end") {
            return Err("expected 'else', 'elif' or 'end'".to_string());
        }
        Ok(Filter::If(
            Box::new(cond),
            Box::new(then_branch),
            Box::new(Filter::Identity),
        ))
    }

    /// Called right after consuming an `elif` keyword: parses its
    /// condition/then and recurses for further `elif`/`else`/`end`, without
    /// expecting a leading `if`.
    fn parse_if_tail(&mut self) -> PResult<Filter> {
        let cond = self.parse_pipe()?;
        if !self.eat_keyword("then") {
            return Err("expected 'then'".to_string());
        }
        let then_branch = self.parse_pipe()?;
        self.skip_ws();
        if self.eat_keyword("elif") {
            let else_branch = self.parse_if_tail()?;
            return Ok(Filter::If(
                Box::new(cond),
                Box::new(then_branch),
                Box::new(else_branch),
            ));
        }
        if self.eat_keyword("else") {
            let else_branch = self.parse_pipe()?;
            if !self.eat_keyword("end") {
                return Err("expected 'end'".to_string());
            }
            return Ok(Filter::If(
                Box::new(cond),
                Box::new(then_branch),
                Box::new(else_branch),
            ));
        }
        if !self.eat_keyword("end") {
            return Err("expected 'else', 'elif' or 'end'".to_string());
        }
        Ok(Filter::If(
            Box::new(cond),
            Box::new(then_branch),
            Box::new(Filter::Identity),
        ))
    }

    fn parse_number(&mut self) -> PResult<Filter> {
        let start = self.pos;
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            self.pos += 1;
        }
        if self.peek() == Some('.') && matches!(self.peek_at(1), Some(c) if c.is_ascii_digit()) {
            self.pos += 1;
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some('e') | Some('E')) {
            let save = self.pos;
            self.pos += 1;
            if matches!(self.peek(), Some('+') | Some('-')) {
                self.pos += 1;
            }
            if matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                    self.pos += 1;
                }
            } else {
                self.pos = save;
            }
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        let n: f64 = text
            .parse()
            .map_err(|_| format!("invalid number '{text}'"))?;
        Ok(Filter::Literal(Value::Number(
            Number::from_f64(n).unwrap_or_else(|| Number::from(0)),
        )))
    }

    fn parse_object(&mut self) -> PResult<Filter> {
        self.expect_char('{')?;
        let mut pairs = Vec::new();
        self.skip_ws();
        if self.peek() == Some('}') {
            self.pos += 1;
            return Ok(Filter::ObjectConstruct(pairs));
        }
        loop {
            self.skip_ws();
            let (key, explicit_value) = if self.peek() == Some('(') {
                self.pos += 1;
                let key_filter = self.parse_pipe()?;
                self.expect_char(')')?;
                (ObjKey::Dynamic(key_filter), true)
            } else if self.peek() == Some('"') {
                let parts = self.parse_string_parts()?;
                match &parts[..] {
                    [StrPart::Lit(s)] => (ObjKey::Literal(s.clone()), false),
                    _ => (ObjKey::Dynamic(string_parts_to_filter(parts)), true),
                }
            } else if matches!(self.peek(), Some(c) if c.is_alphabetic() || c == '_') {
                let name = self.read_ident();
                (ObjKey::Literal(name), false)
            } else {
                return Err(format!("invalid object key at position {}", self.pos));
            };
            self.skip_ws();
            let value = if self.eat_char(':') {
                self.parse_obj_value()?
            } else if explicit_value {
                return Err("expected ':' after dynamic object key".to_string());
            } else {
                // Shorthand `{name}` == `{name: .name}`.
                let ObjKey::Literal(ref name) = key else {
                    unreachable!()
                };
                Filter::Field(Box::new(Filter::Identity), name.clone())
            };
            pairs.push((key, value));
            self.skip_ws();
            if self.eat_char(',') {
                continue;
            }
            break;
        }
        self.expect_char('}')?;
        Ok(Filter::ObjectConstruct(pairs))
    }

    /// Scans a `"..."` string literal, splitting into literal/interpolated
    /// parts. `\(...)` recurses into `parse_pipe` on the same cursor.
    fn parse_string_parts(&mut self) -> PResult<Vec<StrPart>> {
        self.expect_char('"')?;
        let mut parts = Vec::new();
        let mut lit = String::new();
        loop {
            match self.peek() {
                None => return Err("unterminated string literal".to_string()),
                Some('"') => {
                    self.pos += 1;
                    break;
                }
                Some('\\') if self.peek_at(1) == Some('(') => {
                    self.pos += 2;
                    let inner = self.parse_pipe()?;
                    self.expect_char(')')?;
                    if !lit.is_empty() {
                        parts.push(StrPart::Lit(std::mem::take(&mut lit)));
                    }
                    parts.push(StrPart::Expr(inner));
                }
                Some('\\') => {
                    self.pos += 1;
                    match self.peek() {
                        Some('n') => lit.push('\n'),
                        Some('t') => lit.push('\t'),
                        Some('r') => lit.push('\r'),
                        Some('"') => lit.push('"'),
                        Some('\\') => lit.push('\\'),
                        Some('/') => lit.push('/'),
                        Some(other) => lit.push(other),
                        None => return Err("unterminated string literal".to_string()),
                    }
                    self.pos += 1;
                }
                Some(c) => {
                    lit.push(c);
                    self.pos += 1;
                }
            }
        }
        if parts.is_empty() || !lit.is_empty() {
            parts.push(StrPart::Lit(lit));
        }
        Ok(parts)
    }
}

fn string_parts_to_filter(parts: Vec<StrPart>) -> Filter {
    if let [StrPart::Lit(s)] = &parts[..] {
        return Filter::Literal(Value::String(s.clone()));
    }
    Filter::StringInterp(parts)
}

fn parse_filter(src: &str) -> Result<Filter, String> {
    Parser::new(src).parse_program()
}

// ============================================================================
// Evaluator
// ============================================================================

type EResult = Result<Vec<Value>, String>;

fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn is_truthy(v: &Value) -> bool {
    !matches!(v, Value::Bool(false) | Value::Null)
}

fn as_f64(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

/// Structural equality with jq's number semantics: `5` and `5.0` are equal
/// regardless of serde_json's internal int/float representation, which
/// `Value`'s derived `PartialEq` does not consider equal.
fn values_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(_), Value::Number(_)) => as_f64(a) == as_f64(b),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y.iter()).all(|(xi, yi)| values_equal(xi, yi))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, v)| y.get(k).is_some_and(|yv| values_equal(v, yv)))
        }
        _ => a == b,
    }
}

/// jq's typed ordering: null < bool < number < string < array < object.
fn compare_jq(a: &Value, b: &Value) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    fn rank(v: &Value) -> u8 {
        match v {
            Value::Null => 0,
            Value::Bool(_) => 1,
            Value::Number(_) => 2,
            Value::String(_) => 3,
            Value::Array(_) => 4,
            Value::Object(_) => 5,
        }
    }
    let (ra, rb) = (rank(a), rank(b));
    if ra != rb {
        return ra.cmp(&rb);
    }
    match (a, b) {
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        (Value::Number(_), Value::Number(_)) => {
            as_f64(a).partial_cmp(&as_f64(b)).unwrap_or(Ordering::Equal)
        }
        (Value::String(x), Value::String(y)) => x.cmp(y),
        (Value::Array(x), Value::Array(y)) => {
            for (xi, yi) in x.iter().zip(y.iter()) {
                let c = compare_jq(xi, yi);
                if c != Ordering::Equal {
                    return c;
                }
            }
            x.len().cmp(&y.len())
        }
        (Value::Object(x), Value::Object(y)) => {
            let mut xk: Vec<&String> = x.keys().collect();
            let mut yk: Vec<&String> = y.keys().collect();
            xk.sort();
            yk.sort();
            for (xi, yi) in xk.iter().zip(yk.iter()) {
                let c = xi.cmp(yi);
                if c != Ordering::Equal {
                    return c;
                }
            }
            if xk.len() != yk.len() {
                return xk.len().cmp(&yk.len());
            }
            for k in xk {
                let c = compare_jq(&x[k], &y[k]);
                if c != Ordering::Equal {
                    return c;
                }
            }
            Ordering::Equal
        }
        _ => Ordering::Equal,
    }
}

fn shallow_merge(a: &Map<String, Value>, b: &Map<String, Value>) -> Map<String, Value> {
    let mut out = a.clone();
    for (k, v) in b {
        out.insert(k.clone(), v.clone());
    }
    out
}

fn deep_merge(a: &Map<String, Value>, b: &Map<String, Value>) -> Map<String, Value> {
    let mut out = a.clone();
    for (k, v) in b {
        if let (Some(Value::Object(av)), Value::Object(bv)) = (out.get(k), v) {
            out.insert(k.clone(), Value::Object(deep_merge(av, bv)));
        } else {
            out.insert(k.clone(), v.clone());
        }
    }
    out
}

fn binop(op: &str, l: &Value, r: &Value) -> Result<Value, String> {
    match op {
        "+" => match (l, r) {
            (Value::Null, x) => Ok(x.clone()),
            (x, Value::Null) => Ok(x.clone()),
            (Value::Number(_), Value::Number(_)) => Ok(num(as_f64(l) + as_f64(r))),
            (Value::String(a), Value::String(b)) => Ok(Value::String(format!("{a}{b}"))),
            (Value::Array(a), Value::Array(b)) => {
                Ok(Value::Array(a.iter().chain(b.iter()).cloned().collect()))
            }
            (Value::Object(a), Value::Object(b)) => Ok(Value::Object(shallow_merge(a, b))),
            _ => Err(format!(
                "{} and {} cannot be added",
                type_name(l),
                type_name(r)
            )),
        },
        "-" => match (l, r) {
            (Value::Number(_), Value::Number(_)) => Ok(num(as_f64(l) - as_f64(r))),
            (Value::Array(a), Value::Array(b)) => Ok(Value::Array(
                a.iter()
                    .filter(|x| !b.iter().any(|y| values_equal(x, y)))
                    .cloned()
                    .collect(),
            )),
            _ => Err(format!(
                "{} and {} cannot be subtracted",
                type_name(l),
                type_name(r)
            )),
        },
        "*" => match (l, r) {
            (Value::Number(_), Value::Number(_)) => Ok(num(as_f64(l) * as_f64(r))),
            (Value::String(s), Value::Number(_)) => {
                let n = as_f64(r).trunc();
                if n <= 0.0 {
                    Ok(Value::Null)
                } else {
                    Ok(Value::String(s.repeat(n as usize)))
                }
            }
            (Value::Object(a), Value::Object(b)) => Ok(Value::Object(deep_merge(a, b))),
            _ => Err(format!(
                "{} and {} cannot be multiplied",
                type_name(l),
                type_name(r)
            )),
        },
        "/" => match (l, r) {
            (Value::Number(_), Value::Number(_)) => {
                let rv = as_f64(r);
                if rv == 0.0 {
                    return Err("cannot divide by zero".to_string());
                }
                Ok(num(as_f64(l) / rv))
            }
            (Value::String(a), Value::String(b)) => Ok(Value::Array(
                a.split(b.as_str())
                    .map(|s| Value::String(s.to_string()))
                    .collect(),
            )),
            _ => Err(format!(
                "{} and {} cannot be divided",
                type_name(l),
                type_name(r)
            )),
        },
        "%" => match (l, r) {
            (Value::Number(_), Value::Number(_)) => {
                let rv = as_f64(r);
                if rv == 0.0 {
                    return Err("cannot mod by zero".to_string());
                }
                Ok(num(as_f64(l) % rv))
            }
            _ => Err(format!(
                "{} and {} cannot be divided (remainder)",
                type_name(l),
                type_name(r)
            )),
        },
        "==" => Ok(Value::Bool(values_equal(l, r))),
        "!=" => Ok(Value::Bool(!values_equal(l, r))),
        "<" => Ok(Value::Bool(compare_jq(l, r).is_lt())),
        "<=" => Ok(Value::Bool(compare_jq(l, r).is_le())),
        ">" => Ok(Value::Bool(compare_jq(l, r).is_gt())),
        ">=" => Ok(Value::Bool(compare_jq(l, r).is_ge())),
        _ => unreachable!("unknown binary operator {op}"),
    }
}

fn num(f: f64) -> Value {
    Value::Number(Number::from_f64(f).unwrap_or_else(|| Number::from(0)))
}

/// Index a container by a runtime-typed index value (`.[expr]`).
fn index_value(base: &Value, idx: &Value) -> Result<Value, String> {
    match (base, idx) {
        (Value::Null, Value::Number(_) | Value::String(_)) => Ok(Value::Null),
        (Value::Array(arr), Value::Number(_)) => {
            let n = as_f64(idx).trunc() as i64;
            let len = arr.len() as i64;
            let real = if n < 0 { n + len } else { n };
            if real < 0 || real >= len {
                Ok(Value::Null)
            } else {
                Ok(arr[real as usize].clone())
            }
        }
        (Value::Object(map), Value::String(key)) => {
            Ok(map.get(key).cloned().unwrap_or(Value::Null))
        }
        _ => Err(format!(
            "Cannot index {} with {}",
            type_name(base),
            type_name(idx)
        )),
    }
}

fn slice_value(base: &Value, lo: Option<f64>, hi: Option<f64>) -> Result<Value, String> {
    fn bounds(len: usize, lo: Option<f64>, hi: Option<f64>) -> (usize, usize) {
        let len_i = len as i64;
        let clamp = |v: i64| -> i64 { v.clamp(0, len_i) };
        let lo = lo.map(|v| v.trunc() as i64).unwrap_or(0);
        let hi = hi.map(|v| v.trunc() as i64).unwrap_or(len_i);
        let lo = clamp(if lo < 0 { lo + len_i } else { lo });
        let hi = clamp(if hi < 0 { hi + len_i } else { hi });
        if hi < lo {
            (lo as usize, lo as usize)
        } else {
            (lo as usize, hi as usize)
        }
    }
    match base {
        Value::Null => Ok(Value::Null),
        Value::Array(arr) => {
            let (s, e) = bounds(arr.len(), lo, hi);
            Ok(Value::Array(arr[s..e].to_vec()))
        }
        Value::String(s) => {
            let chars: Vec<char> = s.chars().collect();
            let (start, end) = bounds(chars.len(), lo, hi);
            Ok(Value::String(chars[start..end].iter().collect()))
        }
        _ => Err(format!("Cannot slice {}", type_name(base))),
    }
}

/// Renders a value the way jq's `\(...)` interpolation and `tostring` do:
/// strings pass through raw, everything else is compact JSON.
fn interp_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        _ => format_json(v, true, false, 0),
    }
}

fn format_tsv(value: &Value) -> Result<String, String> {
    let Value::Array(values) = value else {
        return Err(format!(
            "{} cannot be tsv-formatted, only an array",
            type_name(value)
        ));
    };
    values
        .iter()
        .map(|value| match value {
            Value::Null => Ok(String::new()),
            Value::Bool(_) | Value::Number(_) => Ok(format_json(value, true, false, 0)),
            Value::String(s) => Ok(s
                .replace('\\', "\\\\")
                .replace('\t', "\\t")
                .replace('\r', "\\r")
                .replace('\n', "\\n")),
            Value::Array(_) | Value::Object(_) => {
                Err(format!("{} is not valid in a tsv row", type_name(value)))
            }
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|fields| fields.join("\t"))
}

fn evaluate(filter: &Filter, value: &Value) -> EResult {
    match filter {
        Filter::Identity => Ok(vec![value.clone()]),
        Filter::Field(base, name) => {
            let bases = evaluate(base, value)?;
            let mut out = Vec::with_capacity(bases.len());
            for b in bases {
                match &b {
                    Value::Null => out.push(Value::Null),
                    Value::Object(map) => out.push(map.get(name).cloned().unwrap_or(Value::Null)),
                    other => {
                        return Err(format!("Cannot index {} with \"{name}\"", type_name(other)));
                    }
                }
            }
            Ok(out)
        }
        Filter::Index(base, idx) => {
            let bases = evaluate(base, value)?;
            let idxs = evaluate(idx, value)?;
            let mut out = Vec::with_capacity(bases.len() * idxs.len().max(1));
            for b in &bases {
                for i in &idxs {
                    out.push(index_value(b, i)?);
                }
            }
            Ok(out)
        }
        Filter::Iterate(base) => {
            let bases = evaluate(base, value)?;
            let mut out = Vec::new();
            for b in bases {
                match b {
                    Value::Array(arr) => out.extend(arr),
                    Value::Object(map) => out.extend(map.into_values()),
                    other => return Err(format!("Cannot iterate over {}", type_name(&other))),
                }
            }
            Ok(out)
        }
        Filter::Slice(base, lo, hi) => {
            let bases = evaluate(base, value)?;
            let los = match lo {
                Some(f) => evaluate(f, value)?
                    .into_iter()
                    .map(|v| Some(as_f64(&v)))
                    .collect(),
                None => vec![None],
            };
            let his = match hi {
                Some(f) => evaluate(f, value)?
                    .into_iter()
                    .map(|v| Some(as_f64(&v)))
                    .collect(),
                None => vec![None],
            };
            let mut out = Vec::new();
            for b in &bases {
                for l in &los {
                    for h in &his {
                        out.push(slice_value(b, *l, *h)?);
                    }
                }
            }
            Ok(out)
        }
        Filter::Optional(inner) => Ok(evaluate(inner, value).unwrap_or_default()),
        Filter::Pipe(l, r) => {
            let lvals = evaluate(l, value)?;
            let mut out = Vec::new();
            for v in lvals {
                out.extend(evaluate(r, &v)?);
            }
            Ok(out)
        }
        Filter::Comma(l, r) => {
            let mut out = evaluate(l, value)?;
            out.extend(evaluate(r, value)?);
            Ok(out)
        }
        Filter::Literal(v) => Ok(vec![v.clone()]),
        Filter::StringInterp(parts) => {
            let mut acc = vec![String::new()];
            for part in parts {
                match part {
                    StrPart::Lit(s) => {
                        for a in &mut acc {
                            a.push_str(s);
                        }
                    }
                    StrPart::Expr(f) => {
                        let vals = evaluate(f, value)?;
                        let mut next = Vec::with_capacity(acc.len() * vals.len().max(1));
                        for a in &acc {
                            for v in &vals {
                                next.push(format!("{a}{}", interp_to_string(v)));
                            }
                        }
                        acc = next;
                    }
                }
            }
            Ok(acc.into_iter().map(Value::String).collect())
        }
        Filter::Format(name) => match name.as_str() {
            "tsv" => Ok(vec![Value::String(format_tsv(value)?)]),
            _ => unreachable!("unsupported jq format {name}"),
        },
        Filter::ArrayConstruct(inner) => match inner {
            None => Ok(vec![Value::Array(vec![])]),
            Some(f) => Ok(vec![Value::Array(evaluate(f, value)?)]),
        },
        Filter::ObjectConstruct(pairs) => {
            // Cartesian product across all pairs' (possibly multi-valued) keys/values.
            let mut objs = vec![Map::new()];
            for (key, value_filter) in pairs {
                let keys: Vec<String> = match key {
                    ObjKey::Literal(s) => vec![s.clone()],
                    ObjKey::Dynamic(kf) => evaluate(kf, value)?
                        .into_iter()
                        .map(|v| match v {
                            Value::String(s) => Ok(s),
                            other => Err(format!("Cannot use {} as object key", type_name(&other))),
                        })
                        .collect::<Result<Vec<_>, String>>()?,
                };
                let vals = evaluate(value_filter, value)?;
                let mut next =
                    Vec::with_capacity(objs.len() * keys.len().max(1) * vals.len().max(1));
                for obj in &objs {
                    for k in &keys {
                        for v in &vals {
                            let mut o = obj.clone();
                            o.insert(k.clone(), v.clone());
                            next.push(o);
                        }
                    }
                }
                objs = next;
            }
            Ok(objs.into_iter().map(Value::Object).collect())
        }
        Filter::Call(name, args) => eval_call(name, args, value),
        Filter::Neg(inner) => {
            let vals = evaluate(inner, value)?;
            vals.into_iter()
                .map(|v| match v {
                    Value::Number(_) => Ok(num(-as_f64(&v))),
                    other => Err(format!("{} cannot be negated", type_name(&other))),
                })
                .collect()
        }
        Filter::BinOp(op, l, r) => {
            let lvals = evaluate(l, value)?;
            let rvals = evaluate(r, value)?;
            let mut out = Vec::with_capacity(lvals.len() * rvals.len().max(1));
            for lv in &lvals {
                for rv in &rvals {
                    out.push(binop(op, lv, rv)?);
                }
            }
            Ok(out)
        }
        Filter::And(l, r) => {
            let lvals = evaluate(l, value)?;
            let mut out = Vec::new();
            for lv in lvals {
                if !is_truthy(&lv) {
                    out.push(Value::Bool(false));
                    continue;
                }
                for rv in evaluate(r, value)? {
                    out.push(Value::Bool(is_truthy(&rv)));
                }
            }
            Ok(out)
        }
        Filter::Or(l, r) => {
            let lvals = evaluate(l, value)?;
            let mut out = Vec::new();
            for lv in lvals {
                if is_truthy(&lv) {
                    out.push(Value::Bool(true));
                    continue;
                }
                for rv in evaluate(r, value)? {
                    out.push(Value::Bool(is_truthy(&rv)));
                }
            }
            Ok(out)
        }
        Filter::Alt(l, r) => {
            let lvals = evaluate(l, value).unwrap_or_default();
            let nonnull: Vec<Value> = lvals.into_iter().filter(is_truthy).collect();
            if !nonnull.is_empty() {
                Ok(nonnull)
            } else {
                evaluate(r, value)
            }
        }
        Filter::If(cond, then_b, else_b) => {
            let conds = evaluate(cond, value)?;
            let mut out = Vec::new();
            for c in conds {
                if is_truthy(&c) {
                    out.extend(evaluate(then_b, value)?);
                } else {
                    out.extend(evaluate(else_b, value)?);
                }
            }
            Ok(out)
        }
    }
}

fn one_arg(args: &[Filter], value: &Value) -> Result<Vec<Value>, String> {
    evaluate(&args[0], value)
}

fn eval_call(name: &str, args: &[Filter], value: &Value) -> EResult {
    match name {
        "empty" => Ok(vec![]),
        "not" => Ok(vec![Value::Bool(!is_truthy(value))]),
        "length" => Ok(vec![match value {
            Value::Null => num(0.0),
            Value::String(s) => num(s.chars().count() as f64),
            Value::Array(a) => num(a.len() as f64),
            Value::Object(m) => num(m.len() as f64),
            Value::Number(_) => num(as_f64(value).abs()),
            Value::Bool(_) => return Err("boolean has no length".to_string()),
        }]),
        "type" => Ok(vec![Value::String(type_name(value).to_string())]),
        "keys" | "keys_unsorted" => match value {
            Value::Object(m) => {
                let mut ks: Vec<String> = m.keys().cloned().collect();
                if name == "keys" {
                    ks.sort();
                }
                Ok(vec![Value::Array(
                    ks.into_iter().map(Value::String).collect(),
                )])
            }
            Value::Array(a) => Ok(vec![Value::Array(
                (0..a.len()).map(|i| num(i as f64)).collect(),
            )]),
            other => Err(format!("{} has no keys", type_name(other))),
        },
        "has" => {
            let keys = one_arg(args, value)?;
            keys.into_iter()
                .map(|k| match (value, &k) {
                    (Value::Object(m), Value::String(s)) => Ok(Value::Bool(m.contains_key(s))),
                    (Value::Array(a), Value::Number(_)) => {
                        let i = as_f64(&k) as usize;
                        Ok(Value::Bool(i < a.len()))
                    }
                    _ => Err("has() needs an object/string or array/number".to_string()),
                })
                .collect()
        }
        "select" => {
            let conds = evaluate(&args[0], value)?;
            let mut out = Vec::new();
            for c in conds {
                if is_truthy(&c) {
                    out.push(value.clone());
                }
            }
            Ok(out)
        }
        "map" => match value {
            Value::Array(a) => {
                let mut out = Vec::new();
                for item in a {
                    out.extend(evaluate(&args[0], item)?);
                }
                Ok(vec![Value::Array(out)])
            }
            other => Err(format!("Cannot map over {}", type_name(other))),
        },
        "add" => match value {
            Value::Array(a) => {
                let mut acc = Value::Null;
                for item in a {
                    acc = binop("+", &acc, item)?;
                }
                Ok(vec![acc])
            }
            other => Err(format!("Cannot add over {}", type_name(other))),
        },
        "range" => {
            let (from, to, by) = match args.len() {
                1 => (0.0, as_f64(&one_arg(args, value)?.remove(0)), 1.0),
                2 => {
                    let a = evaluate(&args[0], value)?;
                    let b = evaluate(&args[1], value)?;
                    (as_f64(&a[0]), as_f64(&b[0]), 1.0)
                }
                _ => {
                    let a = evaluate(&args[0], value)?;
                    let b = evaluate(&args[1], value)?;
                    let c = evaluate(&args[2], value)?;
                    (as_f64(&a[0]), as_f64(&b[0]), as_f64(&c[0]))
                }
            };
            let mut out = Vec::new();
            if by > 0.0 {
                let mut x = from;
                while x < to {
                    out.push(num(x));
                    x += by;
                }
            } else if by < 0.0 {
                let mut x = from;
                while x > to {
                    out.push(num(x));
                    x += by;
                }
            }
            Ok(out)
        }
        "floor" => Ok(vec![num(as_f64(value).floor())]),
        "ceil" => Ok(vec![num(as_f64(value).ceil())]),
        "round" => Ok(vec![num(as_f64(value).round())]),
        "sqrt" => Ok(vec![num(as_f64(value).sqrt())]),
        "abs" => Ok(vec![num(as_f64(value).abs())]),
        "tostring" => Ok(vec![Value::String(interp_to_string(value))]),
        "tonumber" => match value {
            Value::Number(_) => Ok(vec![value.clone()]),
            Value::String(s) => s
                .trim()
                .parse::<f64>()
                .map(num)
                .map(|v| vec![v])
                .map_err(|_| format!("Cannot parse '{s}' as number")),
            other => Err(format!("Cannot parse {} as number", type_name(other))),
        },
        // jq's fromjson: parse the input string as JSON (any value, not just
        // objects). tojson: serialize the input value to a compact JSON string.
        "fromjson" => match value {
            Value::String(s) => serde_json::from_str(s.trim())
                .map(|v: Value| vec![v])
                .map_err(|e| format!("{name}: {e}")),
            other => Err(format!("{name} requires a string, got {}", type_name(other))),
        },
        "tojson" if args.is_empty() => Ok(vec![Value::String(serde_json::to_string(value)
            .unwrap_or_else(|_| "null".to_string()))]),
        "split" => match value {
            Value::String(s) => {
                let sep = one_arg(args, value)?;
                let sep = match sep.first() {
                    Some(Value::String(s)) => s.clone(),
                    _ => return Err("split() separator must be a string".to_string()),
                };
                if sep.is_empty() {
                    Ok(vec![Value::Array(
                        s.chars().map(|c| Value::String(c.to_string())).collect(),
                    )])
                } else {
                    Ok(vec![Value::Array(
                        s.split(sep.as_str())
                            .map(|p| Value::String(p.to_string()))
                            .collect(),
                    )])
                }
            }
            other => Err(format!("Cannot split {}", type_name(other))),
        },
        "join" => match value {
            Value::Array(a) => {
                let sep = one_arg(args, value)?;
                let sep = match sep.first() {
                    Some(Value::String(s)) => s.clone(),
                    _ => return Err("join() separator must be a string".to_string()),
                };
                let parts: Vec<String> = a
                    .iter()
                    .map(|v| match v {
                        Value::Null => String::new(),
                        Value::String(s) => s.clone(),
                        other => interp_to_string(other),
                    })
                    .collect();
                Ok(vec![Value::String(parts.join(&sep))])
            }
            other => Err(format!("Cannot join {}", type_name(other))),
        },
        _ => Err(format!("{name}/{} is not defined", args.len())),
    }
}

// ============================================================================
// JSON output (custom printer: 2-space pretty by default, matching jq)
// ============================================================================

fn format_number(f: f64) -> String {
    if f.is_finite() {
        format!("{f}")
    } else {
        "null".to_string()
    }
}

fn escape_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn format_json(value: &Value, compact: bool, sort_keys: bool, depth: usize) -> String {
    let mut out = String::new();
    append_json(&mut out, value, compact, sort_keys, depth);
    out
}

fn append_json(out: &mut String, value: &Value, compact: bool, sort_keys: bool, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(_) => out.push_str(&format_number(as_f64(value))),
        Value::String(s) => escape_json_string(s, out),
        Value::Array(arr) => {
            out.push('[');
            for (i, item) in arr.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if !compact {
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth + 1));
                }
                append_json(out, item, compact, sort_keys, depth + 1);
            }
            if !compact && !arr.is_empty() {
                out.push('\n');
                out.push_str(&"  ".repeat(depth));
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            if sort_keys {
                keys.sort();
            }
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                if !compact {
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth + 1));
                }
                escape_json_string(k, out);
                out.push_str(if compact { ":" } else { ": " });
                append_json(out, &map[*k], compact, sort_keys, depth + 1);
            }
            if !compact && !keys.is_empty() {
                out.push('\n');
                out.push_str(&"  ".repeat(depth));
            }
            out.push('}');
        }
    }
}

// ============================================================================
// Command entry point
// ============================================================================

struct JqOptions {
    raw: bool,
    raw_input: bool,
    compact: bool,
    null_input: bool,
    slurp: bool,
    exit_status: bool,
    sort_keys: bool,
}

pub fn jq(args: &[String], stdin: String) -> CommandOutput {
    let mut opts = JqOptions {
        raw: false,
        raw_input: false,
        compact: false,
        null_input: false,
        slurp: false,
        exit_status: false,
        sort_keys: false,
    };
    let mut filter_text: Option<String> = None;
    for arg in args {
        match arg.as_str() {
            "-r" | "--raw-output" => opts.raw = true,
            "-R" | "--raw-input" => opts.raw_input = true,
            "-c" | "--compact-output" => opts.compact = true,
            "-n" | "--null-input" => opts.null_input = true,
            "-s" | "--slurp" => opts.slurp = true,
            "-e" | "--exit-status" => opts.exit_status = true,
            "-S" | "--sort-keys" => opts.sort_keys = true,
            _ if arg.starts_with('-') && arg.len() > 1 && !arg.starts_with("--") => {
                for c in arg[1..].chars() {
                    match c {
                        'r' => opts.raw = true,
                        'R' => opts.raw_input = true,
                        'c' => opts.compact = true,
                        'n' => opts.null_input = true,
                        's' => opts.slurp = true,
                        'e' => opts.exit_status = true,
                        'S' => opts.sort_keys = true,
                        _ => return fail(format!("jq: unknown option -{c}\n"), 2),
                    }
                }
            }
            _ if filter_text.is_none() => filter_text = Some(arg.clone()),
            _ => return fail(format!("jq: unexpected argument '{arg}'\n"), 2),
        }
    }
    // No positional filter defaults to identity `.`, matching upstream jq.
    let filter_text = filter_text.unwrap_or_else(|| ".".to_string());

    let filter = match parse_filter(&filter_text) {
        Ok(f) => f,
        Err(e) => return fail(format!("jq: parse error: {e}\n"), 3),
    };

    let mut inputs: Vec<Value> = Vec::new();
    if opts.null_input {
        inputs = vec![Value::Null];
    } else if opts.raw_input {
        // Raw input: treat stdin as text, not JSON. With --slurp the whole input
        // (trailing newline included) is one string; otherwise each line becomes
        // a string and a single trailing newline does not yield an empty element,
        // matching upstream `jq -R`.
        if opts.slurp {
            inputs = vec![Value::String(stdin.clone())];
        } else if !stdin.is_empty() {
            let body = stdin.strip_suffix('\n').unwrap_or(&stdin);
            for line in body.split('\n') {
                inputs.push(Value::String(line.to_string()));
            }
        }
    } else {
        let mut stream = serde_json::Deserializer::from_str(&stdin).into_iter::<Value>();
        for item in &mut stream {
            match item {
                Ok(v) => inputs.push(v),
                Err(e) => return fail(format!("jq: parse error: {e}\n"), 2),
            }
        }
        if opts.slurp {
            inputs = vec![Value::Array(inputs)];
        }
    }

    let mut outputs = Vec::new();
    for input in &inputs {
        match evaluate(&filter, input) {
            Ok(vs) => outputs.extend(vs),
            Err(e) => return fail(format!("jq: error: {e}\n"), 5),
        }
    }

    let mut stdout = String::new();
    for v in &outputs {
        if opts.raw
            && let Value::String(s) = v
        {
            stdout.push_str(s);
            stdout.push('\n');
            continue;
        }
        stdout.push_str(&format_json(v, opts.compact, opts.sort_keys, 0));
        stdout.push('\n');
    }

    let exit_code = if opts.exit_status
        && (outputs.is_empty()
            || outputs
                .iter()
                .all(|v| matches!(v, Value::Null | Value::Bool(false))))
    {
        1
    } else {
        0
    };
    if exit_code != 0 {
        CommandOutput {
            stdout,
            stderr: String::new(),
            exit_code,
        }
    } else {
        ok(stdout)
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

    // ---- jq.basic.test.ts ----

    #[test]
    fn fromjson_and_tojson_round_trip() {
        let mut bash = fresh();
        // The motivating case: a JSON-encoded string field decoded in-pipe.
        assert_eq!(
            run(
                &mut bash,
                r#"echo '{"a":{"b":2}}' | jq -c '.a | tojson | fromjson | .b'"#
            )
            .stdout,
            "2\n"
        );
        assert_eq!(
            run(&mut bash, r#"echo '"[1,2]"' | jq -c 'fromjson'"#).stdout,
            "[1,2]\n"
        );
        assert_eq!(
            run(&mut bash, r#"echo '"42"' | jq -r 'fromjson'"#).stdout,
            "42\n"
        );
        // Invalid JSON is a runtime error (exit 5), not a parse error.
        assert_eq!(
            run(&mut bash, r#"echo '"x"' | jq 'fromjson | fromjson'"#).exit_code,
            5
        );
        // Non-string input is rejected like upstream.
        assert_eq!(
            run(&mut bash, "echo 42 | jq 'fromjson'").exit_code,
            5
        );
    }

    #[test]
    fn identity_pretty_prints() {
        let mut bash = fresh();
        let r = run(&mut bash, r#"echo '{"a":1}' | jq '.'"#);
        assert_eq!(r.stdout, "{\n  \"a\": 1\n}\n");
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    fn pretty_prints_arrays() {
        let mut bash = fresh();
        let r = run(&mut bash, "echo '[1,2,3]' | jq '.'");
        assert_eq!(r.stdout, "[\n  1,\n  2,\n  3\n]\n");
    }

    #[test]
    fn object_field_access() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, r#"echo '{"name":"test"}' | jq '.name'"#).stdout,
            "\"test\"\n"
        );
        assert_eq!(
            run(&mut bash, r#"echo '{"a":{"b":"nested"}}' | jq '.a.b'"#).stdout,
            "\"nested\"\n"
        );
        assert_eq!(
            run(&mut bash, r#"echo '{"a":1}' | jq '.missing'"#).stdout,
            "null\n"
        );
    }

    #[test]
    fn array_index_and_negative() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, r#"echo '["a","b","c"]' | jq '.[0]'"#).stdout,
            "\"a\"\n"
        );
        assert_eq!(
            run(&mut bash, r#"echo '["a","b","c"]' | jq '.[-1]'"#).stdout,
            "\"c\"\n"
        );
        assert_eq!(run(&mut bash, "echo '[1,2]' | jq '.[99]'").stdout, "null\n");
    }

    #[test]
    fn iteration() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, "echo '[1,2,3]' | jq '.[]'").stdout,
            "1\n2\n3\n"
        );
        assert_eq!(
            run(&mut bash, r#"echo '{"a":1,"b":2}' | jq '.[]'"#).stdout,
            "1\n2\n"
        );
        assert_eq!(
            run(&mut bash, r#"echo '{"items":[1,2,3]}' | jq '.items[]'"#).stdout,
            "1\n2\n3\n"
        );
    }

    #[test]
    fn pipes_chain() {
        let mut bash = fresh();
        let r = run(
            &mut bash,
            r#"echo '{"data":{"value":42}}' | jq '.data | .value'"#,
        );
        assert_eq!(r.stdout, "42\n");
    }

    #[test]
    fn slicing() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, "echo '[0,1,2,3,4,5]' | jq '.[2:4]'").stdout,
            "[\n  2,\n  3\n]\n"
        );
        assert_eq!(
            run(&mut bash, "echo '[0,1,2,3,4]' | jq '.[:3]'").stdout,
            "[\n  0,\n  1,\n  2\n]\n"
        );
        assert_eq!(
            run(&mut bash, "echo '[0,1,2,3,4]' | jq '.[3:]'").stdout,
            "[\n  3,\n  4\n]\n"
        );
        assert_eq!(
            run(&mut bash, "echo '\"hello\"' | jq '.[1:4]'").stdout,
            "\"ell\"\n"
        );
        assert_eq!(
            run(&mut bash, "echo '[0,1,2,3,4]' | jq '.[-2:]'").stdout,
            "[\n  3,\n  4\n]\n"
        );
    }

    #[test]
    fn comma_multiple_outputs() {
        let mut bash = fresh();
        let r = run(&mut bash, r#"echo '{"a":1,"b":2}' | jq '.a, .b'"#);
        assert_eq!(r.stdout, "1\n2\n");
    }

    // ---- jq.filters.test.ts ----

    #[test]
    fn select_and_map() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, "echo '[1,2,3,4,5]' | jq '[.[] | select(. > 3)]'").stdout,
            "[\n  4,\n  5\n]\n"
        );
        assert_eq!(
            run(&mut bash, "echo '[1,2,3]' | jq 'map(. * 2)'").stdout,
            "[\n  2,\n  4,\n  6\n]\n"
        );
        assert_eq!(
            run(
                &mut bash,
                "echo '[1,2,3,4,5]' | jq '[.[] | select(. > 2) | . * 10]'"
            )
            .stdout,
            "[\n  30,\n  40,\n  50\n]\n"
        );
    }

    #[test]
    fn has_checks() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, r#"echo '{"foo":42}' | jq 'has("foo")'"#).stdout,
            "true\n"
        );
        assert_eq!(
            run(&mut bash, r#"echo '{"foo":42}' | jq 'has("bar")'"#).stdout,
            "false\n"
        );
        assert_eq!(
            run(&mut bash, "echo '[1,2,3]' | jq 'has(1)'").stdout,
            "true\n"
        );
    }

    #[test]
    fn conditionals() {
        let mut bash = fresh();
        assert_eq!(
            run(
                &mut bash,
                r#"echo '5' | jq 'if . > 3 then "big" else "small" end'"#
            )
            .stdout,
            "\"big\"\n"
        );
        assert_eq!(
            run(
                &mut bash,
                r#"echo '2' | jq 'if . > 3 then "big" else "small" end'"#
            )
            .stdout,
            "\"small\"\n"
        );
        assert_eq!(
            run(
                &mut bash,
                r#"echo '5' | jq 'if . > 10 then "big" elif . > 3 then "medium" else "small" end'"#
            )
            .stdout,
            "\"medium\"\n"
        );
    }

    #[test]
    fn optional_operator() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "echo 'null' | jq '.foo?'").stdout, "null\n");
        assert_eq!(
            run(&mut bash, r#"echo '{"foo":42}' | jq '.foo?'"#).stdout,
            "42\n"
        );
    }

    // ---- jq.construction.test.ts ----

    #[test]
    fn object_construction_static_and_shorthand() {
        let mut bash = fresh();
        assert_eq!(
            run(
                &mut bash,
                r#"echo '{"name":"test","value":42}' | jq -c '{n: .name, v: .value}'"#
            )
            .stdout,
            "{\"n\":\"test\",\"v\":42}\n"
        );
        assert_eq!(
            run(
                &mut bash,
                r#"echo '{"name":"test","value":42}' | jq -c '{name, value}'"#
            )
            .stdout,
            "{\"name\":\"test\",\"value\":42}\n"
        );
    }

    #[test]
    fn object_construction_dynamic_key_and_pipe_value() {
        let mut bash = fresh();
        assert_eq!(
            run(
                &mut bash,
                r#"echo '{"key":"foo","val":42}' | jq -c '{(.key): .val}'"#
            )
            .stdout,
            "{\"foo\":42}\n"
        );
        assert_eq!(
            run(
                &mut bash,
                "echo '[[1,2],[3,4]]' | jq -c '{a: .[0] | add, b: .[1] | add}'"
            )
            .stdout,
            "{\"a\":3,\"b\":7}\n"
        );
    }

    #[test]
    fn array_construction() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, r#"echo '{"a":1,"b":2}' | jq '[.a, .b]'"#).stdout,
            "[\n  1,\n  2\n]\n"
        );
        assert_eq!(
            run(&mut bash, r#"echo '{"a":1,"b":2,"c":3}' | jq '[.[]]'"#).stdout,
            "[\n  1,\n  2,\n  3\n]\n"
        );
    }

    // ---- jq.operators.test.ts ----

    #[test]
    fn arithmetic_operators() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "echo '5' | jq '. + 3'").stdout, "8\n");
        assert_eq!(run(&mut bash, "echo '10' | jq '. - 4'").stdout, "6\n");
        assert_eq!(run(&mut bash, "echo '6' | jq '. * 7'").stdout, "42\n");
        assert_eq!(run(&mut bash, "echo '20' | jq '. / 4'").stdout, "5\n");
        assert_eq!(run(&mut bash, "echo '17' | jq '. % 5'").stdout, "2\n");
        assert_eq!(
            run(&mut bash, r#"echo '{"a":"foo","b":"bar"}' | jq '.a + .b'"#).stdout,
            "\"foobar\"\n"
        );
        assert_eq!(
            run(&mut bash, "echo '[[1,2],[3,4]]' | jq '.[0] + .[1]'").stdout,
            "[\n  1,\n  2,\n  3,\n  4\n]\n"
        );
        assert_eq!(
            run(
                &mut bash,
                "echo '[{\"a\":1},{\"b\":2}]' | jq -c '.[0] + .[1]'"
            )
            .stdout,
            "{\"a\":1,\"b\":2}\n"
        );
    }

    #[test]
    fn comparison_and_logical_operators() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "echo '5' | jq '. == 5'").stdout, "true\n");
        assert_eq!(run(&mut bash, "echo '5' | jq '. != 3'").stdout, "true\n");
        assert_eq!(run(&mut bash, "echo '3' | jq '. < 5'").stdout, "true\n");
        assert_eq!(run(&mut bash, "echo '10' | jq '. > 5'").stdout, "true\n");
        assert_eq!(run(&mut bash, "echo '5' | jq '. <= 5'").stdout, "true\n");
        assert_eq!(run(&mut bash, "echo '5' | jq '. >= 5'").stdout, "true\n");
        assert_eq!(
            run(&mut bash, "echo 'true' | jq '. and true'").stdout,
            "true\n"
        );
        assert_eq!(
            run(&mut bash, "echo 'false' | jq '. or true'").stdout,
            "true\n"
        );
        assert_eq!(run(&mut bash, "echo 'true' | jq 'not'").stdout, "false\n");
        assert_eq!(
            run(&mut bash, r#"echo '{"a":null}' | jq '.a // "default"'"#).stdout,
            "\"default\"\n"
        );
        assert_eq!(
            run(&mut bash, r#"echo '{"a":42}' | jq '.a // "default"'"#).stdout,
            "42\n"
        );
    }

    #[test]
    fn math_functions() {
        let mut bash = fresh();
        assert_eq!(run(&mut bash, "echo '3.7' | jq 'floor'").stdout, "3\n");
        assert_eq!(run(&mut bash, "echo '3.2' | jq 'ceil'").stdout, "4\n");
        assert_eq!(run(&mut bash, "echo '3.5' | jq 'round'").stdout, "4\n");
        assert_eq!(run(&mut bash, "echo '16' | jq 'sqrt'").stdout, "4\n");
        assert_eq!(run(&mut bash, "echo '-5' | jq 'abs'").stdout, "5\n");
    }

    #[test]
    fn type_conversion() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, "echo '42' | jq 'tostring'").stdout,
            "\"42\"\n"
        );
        assert_eq!(
            run(&mut bash, "echo '\"42\"' | jq 'tonumber'").stdout,
            "42\n"
        );
    }

    // ---- jq.strings.test.ts (split/join subset) ----

    #[test]
    fn split_and_join() {
        let mut bash = fresh();
        assert_eq!(
            run(&mut bash, r#"echo '"a,b,c"' | jq 'split(",")'"#).stdout,
            "[\n  \"a\",\n  \"b\",\n  \"c\"\n]\n"
        );
        assert_eq!(
            run(&mut bash, r#"echo '["a","b","c"]' | jq 'join("-")'"#).stdout,
            "\"a-b-c\"\n"
        );
    }

    // ---- CLI flags ----

    #[test]
    fn raw_output_flag() {
        let mut bash = fresh();
        let r = run(&mut bash, r#"echo '"hello"' | jq -r '.'"#);
        assert_eq!(r.stdout, "hello\n");
    }

    #[test]
    fn compact_output_flag() {
        let mut bash = fresh();
        let r = run(&mut bash, r#"echo '{"a":1,"b":2}' | jq -c '.'"#);
        assert_eq!(r.stdout, "{\"a\":1,\"b\":2}\n");
    }

    #[test]
    fn null_input_flag() {
        let mut bash = fresh();
        let r = run(&mut bash, "jq -n '1 + 1'");
        assert_eq!(r.stdout, "2\n");
    }

    #[test]
    fn slurp_flag() {
        let mut bash = fresh();
        let r = run(&mut bash, "printf '1\\n2\\n3\\n' | jq -s 'add'");
        assert_eq!(r.stdout, "6\n");
    }

    #[test]
    fn raw_input_slurp_encodes_whole_input_as_json_string() {
        // The redeploy path needs to JSON-encode a file's contents; `jq -Rs .`
        // is the primitive for it. Trailing newline is preserved.
        let mut bash = fresh();
        let r = run(&mut bash, r#"printf 'a\nb"c\n' | jq -Rs '.'"#);
        assert_eq!(r.stdout, "\"a\\nb\\\"c\\n\"\n");
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    fn raw_input_emits_one_string_per_line() {
        let mut bash = fresh();
        let r = run(&mut bash, r#"printf 'a\nb\n' | jq -R '.'"#);
        assert_eq!(r.stdout, "\"a\"\n\"b\"\n");
    }

    #[test]
    fn raw_input_slurp_on_empty_is_empty_string() {
        let mut bash = fresh();
        let r = run(&mut bash, r#"printf '' | jq -Rs '.'"#);
        assert_eq!(r.stdout, "\"\"\n");
    }

    #[test]
    fn no_filter_defaults_to_identity() {
        let mut bash = fresh();
        let r = run(&mut bash, r#"echo '{"a":1}' | jq"#);
        assert_eq!(r.stdout, "{\n  \"a\": 1\n}\n");
        assert_eq!(r.exit_code, 0);
    }

    // ---- string interpolation ----

    #[test]
    fn string_interpolation() {
        let mut bash = fresh();
        let r = run(
            &mut bash,
            r#"echo '{"name":"world"}' | jq -r '"hello \(.name)!"'"#,
        );
        assert_eq!(r.stdout, "hello world!\n");
    }
}
