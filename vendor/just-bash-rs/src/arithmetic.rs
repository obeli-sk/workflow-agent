//! PORT: vendor/just-bash/src/parser/{arithmetic-parser.ts, arithmetic-primaries.ts},
//! vendor/just-bash/src/interpreter/arithmetic.ts
//!
//! `$((expr))` / `((expr))` arithmetic: a hand-written recursive-descent
//! expression parser plus an evaluator that reads/writes shell variables as
//! plain-integer strings. Values are `i64`; all binary ops use wrapping
//! arithmetic so a stray overflow (from e.g. a huge `**`) never panics.
//!
//! Supported: `+ - * / % ** << >> < <= > >= == != & ^ | && || ! ~ ?: , =` and
//! the compound-assignment forms (`+= -= *= /= %= <<= >>= &= |= ^=`), prefix
//! and postfix `++`/`--`, parenthesized grouping, decimal/octal/hex/`base#n`
//! numeric literals, and variables (with optional `$` prefix). A variable
//! whose value is not itself a plain integer is recursively evaluated as an
//! arithmetic expression (bash's "variables can hold expressions" behavior),
//! capped at a recursion depth so a self-referential variable errors instead
//! of looping forever; the upstream cycle-detection/DoS hardening
//! (arithmetic-cycle.security.test.ts) is intentionally not ported.
//!
//! Not ported (out of scope, see design doc): array element subscripts
//! (`arr[i]`), dynamic/indirect variable names, and `$(...)`/`` ` ` `` command
//! substitution nested inside an arithmetic expression.

use std::collections::BTreeMap;

pub use crate::parser::ParseError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnOp {
    Neg,
    Plus,
    Not,
    BitNot,
    PreInc,
    PreDec,
    PostInc,
    PostDec,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinOp {
    Add,
    Sub,
    Mul,
    Div,
    Mod,
    Pow,
    Shl,
    Shr,
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
    BitAnd,
    BitXor,
    BitOr,
    And,
    Or,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ArithExpr {
    Num(i64),
    Var(String),
    Unary(UnOp, Box<ArithExpr>),
    Binary(BinOp, Box<ArithExpr>, Box<ArithExpr>),
    Assign(String, Box<ArithExpr>),
    CompoundAssign(BinOp, String, Box<ArithExpr>),
    Ternary(Box<ArithExpr>, Box<ArithExpr>, Box<ArithExpr>),
    Comma(Box<ArithExpr>, Box<ArithExpr>),
}

fn err<T>(message: impl Into<String>) -> Result<T, ParseError> {
    Err(ParseError {
        message: message.into(),
    })
}

/// Parse a bash arithmetic expression (the text inside `$(( ))` / `(( ))`,
/// without the surrounding parens).
pub fn parse(source: &str) -> Result<ArithExpr, ParseError> {
    let mut p = AParser {
        chars: source.chars().collect(),
        pos: 0,
    };
    let expr = p.parse_comma()?;
    p.skip_ws();
    if p.pos != p.chars.len() {
        let rest: String = p.chars[p.pos..].iter().collect();
        return err(format!("syntax error near `{}`", rest.trim()));
    }
    Ok(expr)
}

struct AParser {
    chars: Vec<char>,
    pos: usize,
}

impl AParser {
    fn skip_ws(&mut self) {
        while matches!(self.peek(), Some(c) if c.is_whitespace()) {
            self.pos += 1;
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn starts_with(&self, s: &str) -> bool {
        s.chars()
            .enumerate()
            .all(|(i, c)| self.chars.get(self.pos + i) == Some(&c))
    }

    /// Consume `s` if it matches at the current position.
    fn eat_str(&mut self, s: &str) -> bool {
        if self.starts_with(s) {
            self.pos += s.chars().count();
            true
        } else {
            false
        }
    }

    fn eat_ch(&mut self, c: char) -> bool {
        if self.peek() == Some(c) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    // ----- precedence chain, lowest to highest -----------------------------

    fn parse_comma(&mut self) -> Result<ArithExpr, ParseError> {
        let mut left = self.parse_ternary()?;
        loop {
            self.skip_ws();
            if self.eat_ch(',') {
                let right = self.parse_ternary()?;
                left = ArithExpr::Comma(Box::new(left), Box::new(right));
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn parse_ternary(&mut self) -> Result<ArithExpr, ParseError> {
        let cond = self.parse_logical_or()?;
        self.skip_ws();
        if self.eat_ch('?') {
            let then_branch = self.parse_comma()?;
            self.skip_ws();
            if !self.eat_ch(':') {
                return err("expected `:` in ternary expression");
            }
            let else_branch = self.parse_comma()?;
            return Ok(ArithExpr::Ternary(
                Box::new(cond),
                Box::new(then_branch),
                Box::new(else_branch),
            ));
        }
        Ok(cond)
    }

    fn parse_logical_or(&mut self) -> Result<ArithExpr, ParseError> {
        let mut left = self.parse_logical_and()?;
        loop {
            self.skip_ws();
            if self.eat_str("||") {
                let right = self.parse_logical_and()?;
                left = ArithExpr::Binary(BinOp::Or, Box::new(left), Box::new(right));
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn parse_logical_and(&mut self) -> Result<ArithExpr, ParseError> {
        let mut left = self.parse_bitwise_or()?;
        loop {
            self.skip_ws();
            if self.eat_str("&&") {
                let right = self.parse_bitwise_or()?;
                left = ArithExpr::Binary(BinOp::And, Box::new(left), Box::new(right));
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn parse_bitwise_or(&mut self) -> Result<ArithExpr, ParseError> {
        let mut left = self.parse_bitwise_xor()?;
        loop {
            self.skip_ws();
            if self.peek() == Some('|') && self.chars.get(self.pos + 1) != Some(&'|') {
                self.pos += 1;
                let right = self.parse_bitwise_xor()?;
                left = ArithExpr::Binary(BinOp::BitOr, Box::new(left), Box::new(right));
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn parse_bitwise_xor(&mut self) -> Result<ArithExpr, ParseError> {
        let mut left = self.parse_bitwise_and()?;
        loop {
            self.skip_ws();
            if self.eat_ch('^') {
                let right = self.parse_bitwise_and()?;
                left = ArithExpr::Binary(BinOp::BitXor, Box::new(left), Box::new(right));
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn parse_bitwise_and(&mut self) -> Result<ArithExpr, ParseError> {
        let mut left = self.parse_equality()?;
        loop {
            self.skip_ws();
            if self.peek() == Some('&') && self.chars.get(self.pos + 1) != Some(&'&') {
                self.pos += 1;
                let right = self.parse_equality()?;
                left = ArithExpr::Binary(BinOp::BitAnd, Box::new(left), Box::new(right));
            } else {
                break;
            }
        }
        Ok(left)
    }

    fn parse_equality(&mut self) -> Result<ArithExpr, ParseError> {
        let mut left = self.parse_relational()?;
        loop {
            self.skip_ws();
            let op = if self.eat_str("==") {
                Some(BinOp::Eq)
            } else if self.eat_str("!=") {
                Some(BinOp::Ne)
            } else {
                None
            };
            match op {
                Some(op) => {
                    let right = self.parse_relational()?;
                    left = ArithExpr::Binary(op, Box::new(left), Box::new(right));
                }
                None => break,
            }
        }
        Ok(left)
    }

    fn parse_relational(&mut self) -> Result<ArithExpr, ParseError> {
        let mut left = self.parse_shift()?;
        loop {
            self.skip_ws();
            let op = if self.eat_str("<=") {
                Some(BinOp::Le)
            } else if self.eat_str(">=") {
                Some(BinOp::Ge)
            } else if self.starts_with("<<") || self.starts_with(">>") {
                None
            } else if self.eat_ch('<') {
                Some(BinOp::Lt)
            } else if self.eat_ch('>') {
                Some(BinOp::Gt)
            } else {
                None
            };
            match op {
                Some(op) => {
                    let right = self.parse_shift()?;
                    left = ArithExpr::Binary(op, Box::new(left), Box::new(right));
                }
                None => break,
            }
        }
        Ok(left)
    }

    fn parse_shift(&mut self) -> Result<ArithExpr, ParseError> {
        let mut left = self.parse_additive()?;
        loop {
            self.skip_ws();
            let op = if self.eat_str("<<") {
                Some(BinOp::Shl)
            } else if self.eat_str(">>") {
                Some(BinOp::Shr)
            } else {
                None
            };
            match op {
                Some(op) => {
                    let right = self.parse_additive()?;
                    left = ArithExpr::Binary(op, Box::new(left), Box::new(right));
                }
                None => break,
            }
        }
        Ok(left)
    }

    fn parse_additive(&mut self) -> Result<ArithExpr, ParseError> {
        let mut left = self.parse_multiplicative()?;
        loop {
            self.skip_ws();
            let op = match self.peek() {
                Some('+') if self.chars.get(self.pos + 1) != Some(&'+') => Some(BinOp::Add),
                Some('-') if self.chars.get(self.pos + 1) != Some(&'-') => Some(BinOp::Sub),
                _ => None,
            };
            match op {
                Some(op) => {
                    self.pos += 1;
                    let right = self.parse_multiplicative()?;
                    left = ArithExpr::Binary(op, Box::new(left), Box::new(right));
                }
                None => break,
            }
        }
        Ok(left)
    }

    fn parse_multiplicative(&mut self) -> Result<ArithExpr, ParseError> {
        let mut left = self.parse_power()?;
        loop {
            self.skip_ws();
            let op = if self.peek() == Some('*') && self.chars.get(self.pos + 1) != Some(&'*') {
                self.pos += 1;
                Some(BinOp::Mul)
            } else if self.eat_ch('/') {
                Some(BinOp::Div)
            } else if self.eat_ch('%') {
                Some(BinOp::Mod)
            } else {
                None
            };
            match op {
                Some(op) => {
                    let right = self.parse_power()?;
                    left = ArithExpr::Binary(op, Box::new(left), Box::new(right));
                }
                None => break,
            }
        }
        Ok(left)
    }

    /// Right-associative.
    fn parse_power(&mut self) -> Result<ArithExpr, ParseError> {
        let base = self.parse_unary()?;
        self.skip_ws();
        if self.eat_str("**") {
            let exponent = self.parse_power()?;
            return Ok(ArithExpr::Binary(
                BinOp::Pow,
                Box::new(base),
                Box::new(exponent),
            ));
        }
        Ok(base)
    }

    fn parse_unary(&mut self) -> Result<ArithExpr, ParseError> {
        self.skip_ws();
        if self.eat_str("++") {
            let operand = self.parse_unary()?;
            return Ok(ArithExpr::Unary(UnOp::PreInc, Box::new(operand)));
        }
        if self.eat_str("--") {
            let operand = self.parse_unary()?;
            return Ok(ArithExpr::Unary(UnOp::PreDec, Box::new(operand)));
        }
        let op = match self.peek() {
            Some('+') => Some(UnOp::Plus),
            Some('-') => Some(UnOp::Neg),
            Some('!') => Some(UnOp::Not),
            Some('~') => Some(UnOp::BitNot),
            _ => None,
        };
        if let Some(op) = op {
            self.pos += 1;
            let operand = self.parse_unary()?;
            return Ok(ArithExpr::Unary(op, Box::new(operand)));
        }
        self.parse_postfix()
    }

    /// Assignment operators (`ARITH_ASSIGN_OPS` upstream), longest first so
    /// e.g. `<<=` isn't cut short at `<<`.
    const COMPOUND_ASSIGN_OPS: &'static [(&'static str, BinOp)] = &[
        ("<<=", BinOp::Shl),
        (">>=", BinOp::Shr),
        ("+=", BinOp::Add),
        ("-=", BinOp::Sub),
        ("*=", BinOp::Mul),
        ("/=", BinOp::Div),
        ("%=", BinOp::Mod),
        ("&=", BinOp::BitAnd),
        ("^=", BinOp::BitXor),
        ("|=", BinOp::BitOr),
    ];

    /// Binds tighter than every binary operator level above it: this mirrors
    /// upstream, which detects assignment right after parsing the bare
    /// identifier primary (in `parseArithPostfix`), before the additive etc.
    /// levels ever see the input. Detecting it later (e.g. as its own
    /// precedence rung above ternary, the more conventional C-parser shape)
    /// would let the additive level misparse the `+` of `x += 1` as a binary
    /// `+` first, since a lone `+`/`-` there only excludes a doubled `++`/`--`.
    fn parse_postfix(&mut self) -> Result<ArithExpr, ParseError> {
        let expr = self.parse_primary()?;
        self.skip_ws();
        let ArithExpr::Var(name) = &expr else {
            return Ok(expr);
        };
        if self.starts_with("++") {
            self.pos += 2;
            return Ok(ArithExpr::Unary(UnOp::PostInc, Box::new(expr)));
        }
        if self.starts_with("--") {
            self.pos += 2;
            return Ok(ArithExpr::Unary(UnOp::PostDec, Box::new(expr)));
        }
        for (op, bin) in Self::COMPOUND_ASSIGN_OPS {
            if self.starts_with(op) {
                self.pos += op.len();
                let value = self.parse_ternary()?;
                return Ok(ArithExpr::CompoundAssign(
                    *bin,
                    name.clone(),
                    Box::new(value),
                ));
            }
        }
        // Plain `=`, but not `==`.
        if self.peek() == Some('=') && self.chars.get(self.pos + 1) != Some(&'=') {
            self.pos += 1;
            let value = self.parse_ternary()?;
            return Ok(ArithExpr::Assign(name.clone(), Box::new(value)));
        }
        Ok(expr)
    }

    fn parse_primary(&mut self) -> Result<ArithExpr, ParseError> {
        self.skip_ws();
        if self.eat_ch('(') {
            let inner = self.parse_comma()?;
            self.skip_ws();
            if !self.eat_ch(')') {
                return err("expected `)`");
            }
            return Ok(inner);
        }
        // `$name` is sugar for `name` inside arithmetic.
        self.eat_ch('$');
        if let Some(n) = self.read_number() {
            return Ok(ArithExpr::Num(n));
        }
        if let Some(name) = self.read_ident() {
            return Ok(ArithExpr::Var(name));
        }
        match self.peek() {
            Some(c) => err(format!("syntax error (unexpected `{c}`)")),
            None => err("syntax error: unexpected end of expression"),
        }
    }

    fn read_number(&mut self) -> Option<i64> {
        if !matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            return None;
        }
        let start = self.pos;
        while matches!(self.peek(), Some(c) if c.is_ascii_alphanumeric() || c == '#' || c == '_' || c == '@')
        {
            self.pos += 1;
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        Some(parse_arith_number(&text).unwrap_or(0))
    }

    fn read_ident(&mut self) -> Option<String> {
        if !matches!(self.peek(), Some(c) if c == '_' || c.is_ascii_alphabetic()) {
            return None;
        }
        let start = self.pos;
        while matches!(self.peek(), Some(c) if c == '_' || c.is_ascii_alphanumeric()) {
            self.pos += 1;
        }
        Some(self.chars[start..self.pos].iter().collect())
    }
}

/// Parse a bash-arithmetic numeric literal: decimal, `0x`/`0X` hex, a leading-
/// `0` octal, or `base#digits` (base 2-64, digits `0-9a-zA-Z@_`). Returns
/// `None` for malformed input (callers default to `0`, matching the shell's
/// "don't panic on a weird literal" stance rather than upstream's precise
/// error text, which is not exercised by the ported test suite).
pub fn parse_arith_number(s: &str) -> Option<i64> {
    if let Some(idx) = s.find('#') {
        let (base_str, digits) = (&s[..idx], &s[idx + 1..]);
        if base_str.is_empty() || !base_str.bytes().all(|b| b.is_ascii_digit()) || digits.is_empty()
        {
            return None;
        }
        let base: i64 = base_str.parse().ok()?;
        if !(2..=64).contains(&base) {
            return None;
        }
        let mut result: i64 = 0;
        for ch in digits.chars() {
            let digit = match ch {
                '0'..='9' => ch as i64 - '0' as i64,
                'a'..='z' => ch as i64 - 'a' as i64 + 10,
                'A'..='Z' => ch as i64 - 'A' as i64 + if base <= 36 { 10 } else { 36 },
                '@' => 62,
                '_' => 63,
                _ => return None,
            };
            if digit >= base {
                return None;
            }
            result = result.wrapping_mul(base).wrapping_add(digit);
        }
        return Some(result);
    }
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).ok();
    }
    if s.len() > 1 && s.starts_with('0') && s.bytes().all(|b| b.is_ascii_digit()) {
        if s.contains('8') || s.contains('9') {
            return None;
        }
        return i64::from_str_radix(s, 8).ok();
    }
    s.parse::<i64>().ok()
}

/// Evaluate an already-parsed arithmetic expression against the shell
/// environment (variables are read/written as plain-integer strings). `Err`
/// carries the bare message; callers format it as `bash: {msg}\n`.
pub fn eval(expr: &ArithExpr, env: &mut BTreeMap<String, String>) -> Result<i64, String> {
    eval_depth(expr, env, 0)
}

const MAX_DEPTH: u32 = 200;

fn eval_depth(
    expr: &ArithExpr,
    env: &mut BTreeMap<String, String>,
    depth: u32,
) -> Result<i64, String> {
    if depth > MAX_DEPTH {
        return Err("expression recursion level exceeded".to_string());
    }
    match expr {
        ArithExpr::Num(n) => Ok(*n),
        ArithExpr::Var(name) => eval_var(name, env, depth),
        ArithExpr::Unary(op, operand) => eval_unary(*op, operand, env, depth),
        ArithExpr::Binary(op, l, r) => eval_binary(*op, l, r, env, depth),
        ArithExpr::Assign(name, value) => {
            let v = eval_depth(value, env, depth + 1)?;
            env.insert(name.clone(), v.to_string());
            Ok(v)
        }
        ArithExpr::CompoundAssign(op, name, value) => {
            let cur = eval_var(name, env, depth + 1)?;
            let rhs = eval_depth(value, env, depth + 1)?;
            let result = apply_binop(*op, cur, rhs)?;
            env.insert(name.clone(), result.to_string());
            Ok(result)
        }
        ArithExpr::Ternary(cond, then_branch, else_branch) => {
            if eval_depth(cond, env, depth + 1)? != 0 {
                eval_depth(then_branch, env, depth + 1)
            } else {
                eval_depth(else_branch, env, depth + 1)
            }
        }
        ArithExpr::Comma(l, r) => {
            eval_depth(l, env, depth + 1)?;
            eval_depth(r, env, depth + 1)
        }
    }
}

fn eval_unary(
    op: UnOp,
    operand: &ArithExpr,
    env: &mut BTreeMap<String, String>,
    depth: u32,
) -> Result<i64, String> {
    match op {
        UnOp::Neg => Ok(eval_depth(operand, env, depth + 1)?.wrapping_neg()),
        UnOp::Plus => eval_depth(operand, env, depth + 1),
        UnOp::Not => Ok(bool_to_i(eval_depth(operand, env, depth + 1)? == 0)),
        UnOp::BitNot => Ok(!eval_depth(operand, env, depth + 1)?),
        UnOp::PreInc | UnOp::PreDec | UnOp::PostInc | UnOp::PostDec => {
            let name = lvalue_name(operand)?;
            let cur = eval_var(&name, env, depth + 1)?;
            let next = if matches!(op, UnOp::PreInc | UnOp::PostInc) {
                cur.wrapping_add(1)
            } else {
                cur.wrapping_sub(1)
            };
            env.insert(name, next.to_string());
            Ok(if matches!(op, UnOp::PreInc | UnOp::PreDec) {
                next
            } else {
                cur
            })
        }
    }
}

fn lvalue_name(expr: &ArithExpr) -> Result<String, String> {
    match expr {
        ArithExpr::Var(name) => Ok(name.clone()),
        _ => Err("not a valid arithmetic lvalue".to_string()),
    }
}

fn eval_binary(
    op: BinOp,
    l: &ArithExpr,
    r: &ArithExpr,
    env: &mut BTreeMap<String, String>,
    depth: u32,
) -> Result<i64, String> {
    // Short-circuit: the right side must not be evaluated (it may assign).
    if op == BinOp::And {
        if eval_depth(l, env, depth + 1)? == 0 {
            return Ok(0);
        }
        return Ok(bool_to_i(eval_depth(r, env, depth + 1)? != 0));
    }
    if op == BinOp::Or {
        if eval_depth(l, env, depth + 1)? != 0 {
            return Ok(1);
        }
        return Ok(bool_to_i(eval_depth(r, env, depth + 1)? != 0));
    }
    let lv = eval_depth(l, env, depth + 1)?;
    let rv = eval_depth(r, env, depth + 1)?;
    apply_binop(op, lv, rv)
}

fn bool_to_i(b: bool) -> i64 {
    if b { 1 } else { 0 }
}

fn apply_binop(op: BinOp, l: i64, r: i64) -> Result<i64, String> {
    use BinOp::*;
    Ok(match op {
        Add => l.wrapping_add(r),
        Sub => l.wrapping_sub(r),
        Mul => l.wrapping_mul(r),
        Div => {
            if r == 0 {
                return Err("division by 0".to_string());
            }
            l.wrapping_div(r)
        }
        Mod => {
            if r == 0 {
                return Err("division by 0".to_string());
            }
            l.wrapping_rem(r)
        }
        Pow => {
            if r < 0 {
                return Err("exponent less than 0".to_string());
            }
            let mut result: i64 = 1;
            let mut base = l;
            let mut exp = r as u64;
            while exp > 0 {
                if exp & 1 == 1 {
                    result = result.wrapping_mul(base);
                }
                base = base.wrapping_mul(base);
                exp >>= 1;
            }
            result
        }
        Shl => l.wrapping_shl(r as u32),
        Shr => l.wrapping_shr(r as u32),
        Lt => bool_to_i(l < r),
        Le => bool_to_i(l <= r),
        Gt => bool_to_i(l > r),
        Ge => bool_to_i(l >= r),
        Eq => bool_to_i(l == r),
        Ne => bool_to_i(l != r),
        BitAnd => l & r,
        BitXor => l ^ r,
        BitOr => l | r,
        And | Or => unreachable!("short-circuited above"),
    })
}

/// Resolve a variable's arithmetic value: an unset/empty variable is `0`; a
/// value that parses as a plain integer literal is that integer; otherwise
/// the value is itself parsed and evaluated as an arithmetic expression
/// (bash's "a variable can hold an expression" behavior), recursing with a
/// depth cap so a self-referential variable errors instead of looping.
fn eval_var(name: &str, env: &mut BTreeMap<String, String>, depth: u32) -> Result<i64, String> {
    if depth > MAX_DEPTH {
        return Err("expression recursion level exceeded".to_string());
    }
    let raw = env.get(name).cloned().unwrap_or_default();
    if raw.is_empty() {
        return Ok(0);
    }
    if let Some(n) = parse_arith_number(&raw) {
        return Ok(n);
    }
    let inner = parse(&raw).map_err(|e| e.message)?;
    eval_depth(&inner, env, depth + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(env: &mut BTreeMap<String, String>, expr: &str) -> Result<i64, String> {
        eval(&parse(expr).unwrap(), env)
    }

    #[test]
    fn number_bases() {
        assert_eq!(parse_arith_number("010"), Some(8));
        assert_eq!(parse_arith_number("0xFF"), Some(255));
        assert_eq!(parse_arith_number("2#1010"), Some(10));
        assert_eq!(parse_arith_number("16#ff"), Some(255));
        assert_eq!(parse_arith_number("0"), Some(0));
    }

    #[test]
    fn precedence_and_grouping() {
        let mut env = BTreeMap::new();
        assert_eq!(ev(&mut env, "2 + 3 * 4"), Ok(14));
        assert_eq!(ev(&mut env, "(2 + 3) * 4"), Ok(20));
        assert_eq!(ev(&mut env, "2 ** 10"), Ok(1024));
    }

    #[test]
    fn assignment_and_variables() {
        let mut env = BTreeMap::new();
        assert_eq!(ev(&mut env, "x = 5"), Ok(5));
        assert_eq!(env.get("x").map(String::as_str), Some("5"));
        assert_eq!(ev(&mut env, "x += 3"), Ok(8));
    }

    #[test]
    fn division_by_zero_errors() {
        let mut env = BTreeMap::new();
        assert_eq!(ev(&mut env, "5 / 0"), Err("division by 0".to_string()));
    }

    #[test]
    fn self_referential_variable_does_not_hang() {
        let mut env = BTreeMap::new();
        env.insert("x".to_string(), "x".to_string());
        assert!(ev(&mut env, "x").is_err());
    }
}
