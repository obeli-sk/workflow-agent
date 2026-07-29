//! PORT: vendor/just-bash/src/parser/{lexer.ts, parser.ts}
//!
//! A recursive-descent parser for the supported grammar:
//!
//! ```text
//! script    := (statement (sep statement)*)?   sep := ';' | '&' | newline
//! statement := pipeline (('&&' | '||') pipeline)*
//! pipeline  := '!'? command ('|' command)*
//! command   := simple | if_clause | for_clause | while_clause
//! simple    := assignment* (word | redirect)*
//! if_clause   := 'if' list 'then' list ('elif' list 'then' list)* ('else' list)? 'fi'
//! for_clause  := 'for' NAME ('in' word*)? sep 'do' list 'done'
//! while_clause:= ('while' | 'until') list 'do' list 'done'
//! ```
//!
//! Words carry literal text, single/double quotes, `$VAR` / `${VAR}` / `$?`
//! expansions, and `$(...)` / `` `...` `` command substitution.

use crate::ast::{
    Assignment, Command, CompoundCommand, LogicalOp, Pipeline, Redirect, RedirectKind,
    RedirectTarget, Script, SimpleCommand, Statement, Word, WordPart,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub message: String,
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "bash: syntax error: {}", self.message)
    }
}

impl std::error::Error for ParseError {}

fn err<T>(message: impl Into<String>) -> Result<T, ParseError> {
    Err(ParseError {
        message: message.into(),
    })
}

// ----- tokens -----------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Word(Word),
    AndAnd,
    OrOr,
    Pipe,
    Semi,
    Amp,
    Newline,
    Bang,
    /// `<`
    Less,
    /// `>`
    Great,
    /// `>>`
    DGreat,
    /// `>&` (stdout fd-duplication, e.g. `>&2`).
    GreatAnd,
    /// `<&` (stdin fd-duplication, e.g. `<&3`).
    LessAnd,
    /// A leading descriptor number immediately before a redirection operator
    /// (`2>`, `1>&2`), bash's IO_NUMBER lexer rule.
    IoNumber(u32),
    /// `(( ... ))`: the raw text between the parens. Parsed lazily by the AST
    /// parser so a C-style `for (( init; cond; update ))` header, whose body
    /// holds three `;`-separated expressions, isn't rejected by the
    /// single-expression arithmetic parser at lex time.
    DParen(String),
}

struct Lexer {
    chars: Vec<char>,
    pos: usize,
}

impl Lexer {
    fn new(src: &str) -> Self {
        Self {
            chars: src.chars().collect(),
            pos: 0,
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek2(&self) -> Option<char> {
        self.chars.get(self.pos + 1).copied()
    }

    fn peek3(&self) -> Option<char> {
        self.chars.get(self.pos + 2).copied()
    }

    fn bump(&mut self) -> Option<char> {
        let c = self.chars.get(self.pos).copied();
        if c.is_some() {
            self.pos += 1;
        }
        c
    }

    fn tokenize(mut self) -> Result<Vec<Token>, ParseError> {
        let mut tokens = Vec::new();
        loop {
            match self.peek() {
                None => break,
                Some(' ' | '\t') => {
                    self.bump();
                }
                Some('#') => {
                    // Comment to end of line.
                    while let Some(c) = self.peek() {
                        if c == '\n' {
                            break;
                        }
                        self.bump();
                    }
                }
                Some('\n') => {
                    self.bump();
                    tokens.push(Token::Newline);
                }
                Some(';') => {
                    self.bump();
                    tokens.push(Token::Semi);
                }
                Some('&') => {
                    self.bump();
                    if self.peek() == Some('&') {
                        self.bump();
                        tokens.push(Token::AndAnd);
                    } else {
                        tokens.push(Token::Amp);
                    }
                }
                Some('|') => {
                    self.bump();
                    if self.peek() == Some('|') {
                        self.bump();
                        tokens.push(Token::OrOr);
                    } else {
                        tokens.push(Token::Pipe);
                    }
                }
                Some('!') if self.at_word_boundary_bang() => {
                    self.bump();
                    tokens.push(Token::Bang);
                }
                Some('(') if self.peek2() == Some('(') => {
                    self.bump();
                    self.bump();
                    let body = self.read_double_paren_body()?;
                    tokens.push(Token::DParen(body));
                }
                Some('<') => {
                    self.bump();
                    if self.peek() == Some('&') {
                        self.bump();
                        tokens.push(Token::LessAnd);
                    } else {
                        tokens.push(Token::Less);
                    }
                }
                Some('>') => {
                    self.bump();
                    if self.peek() == Some('>') {
                        self.bump();
                        tokens.push(Token::DGreat);
                    } else if self.peek() == Some('&') {
                        self.bump();
                        tokens.push(Token::GreatAnd);
                    } else {
                        tokens.push(Token::Great);
                    }
                }
                // IO_NUMBER: a run of digits immediately before a redirection
                // operator (no space), e.g. the `2` in `2>&1`. A digit run not
                // followed by `<`/`>` is an ordinary word (read below).
                Some(c) if c.is_ascii_digit() && self.io_number_len().is_some() => {
                    let len = self.io_number_len().unwrap();
                    let digits: String = self.chars[self.pos..self.pos + len].iter().collect();
                    self.pos += len;
                    match digits.parse::<u32>() {
                        Ok(n) => tokens.push(Token::IoNumber(n)),
                        // Absurdly long fd number: fall back to a literal word.
                        Err(_) => tokens.push(Token::Word(vec![WordPart::Literal(digits)])),
                    }
                }
                Some(_) => {
                    let word = self.read_word()?;
                    tokens.push(Token::Word(word));
                }
            }
        }
        Ok(tokens)
    }

    /// A standalone `!` (pipeline negation) is a `!` followed by whitespace or
    /// end; otherwise it is an ordinary word character (e.g. `foo!bar`).
    fn at_word_boundary_bang(&self) -> bool {
        matches!(self.peek2(), None | Some(' ' | '\t' | '\n'))
    }

    /// If the current position starts a pure-digit run immediately followed by
    /// a redirection operator (`<`/`>`), return the run's length (bash's
    /// IO_NUMBER rule). `foo2>` is not an IO number (the run isn't at a word
    /// boundary), so this is only consulted from a fresh token position.
    fn io_number_len(&self) -> Option<usize> {
        let mut len = 0;
        while matches!(self.chars.get(self.pos + len), Some(c) if c.is_ascii_digit()) {
            len += 1;
        }
        if len == 0 {
            return None;
        }
        match self.chars.get(self.pos + len) {
            Some('<' | '>') => Some(len),
            _ => None,
        }
    }

    fn read_word(&mut self) -> Result<Word, ParseError> {
        let mut parts: Vec<WordPart> = Vec::new();
        let mut literal = String::new();

        macro_rules! flush {
            () => {
                if !literal.is_empty() {
                    parts.push(WordPart::Literal(std::mem::take(&mut literal)));
                }
            };
        }

        loop {
            match self.peek() {
                None | Some(' ' | '\t' | '\n' | ';' | '&' | '|' | '<' | '>') => break,
                Some('\'') => {
                    flush!();
                    self.bump();
                    let mut quoted = String::new();
                    loop {
                        match self.bump() {
                            None => return err("unterminated single quote"),
                            Some('\'') => break,
                            Some(c) => quoted.push(c),
                        }
                    }
                    parts.push(WordPart::QuotedLiteral(quoted));
                }
                Some('"') => {
                    flush!();
                    self.bump();
                    self.read_double_quoted(&mut parts)?;
                }
                Some('$') => {
                    flush!();
                    parts.push(self.read_dollar(false)?);
                }
                Some('`') => {
                    flush!();
                    parts.push(self.read_backtick(false)?);
                }
                Some('\\') => {
                    flush!();
                    self.bump();
                    match self.bump() {
                        None => return err("trailing backslash"),
                        Some('\n') => {} // line continuation
                        // A backslash-escaped char is quoted: never a glob
                        // wildcard even when the surrounding word is unquoted.
                        Some(c) => parts.push(WordPart::QuotedLiteral(c.to_string())),
                    }
                }
                Some(c) => {
                    self.bump();
                    literal.push(c);
                }
            }
        }
        flush!();
        Ok(parts)
    }

    /// Read the body of a `"..."` double-quoted span (the opening quote is
    /// already consumed). Always pushes at least one part, even for an empty
    /// `""`, so an explicitly-quoted empty string still anchors one field
    /// during expansion (see `expansion.rs`).
    fn read_double_quoted(&mut self, parts: &mut Vec<WordPart>) -> Result<(), ParseError> {
        let mut literal = String::new();
        let mut pushed_any = false;

        macro_rules! flush {
            () => {
                if !literal.is_empty() {
                    parts.push(WordPart::QuotedLiteral(std::mem::take(&mut literal)));
                }
            };
        }

        loop {
            match self.bump() {
                None => return err("unterminated double quote"),
                Some('"') => break,
                Some('\\') => match self.bump() {
                    None => return err("unterminated double quote"),
                    // Only these are special after a backslash inside "...".
                    Some(c @ ('"' | '\\' | '$' | '`')) => literal.push(c),
                    Some('\n') => {} // line continuation
                    Some(c) => {
                        literal.push('\\');
                        literal.push(c);
                    }
                },
                Some('$') => {
                    flush!();
                    pushed_any = true;
                    self.pos -= 1; // reparse the '$' as a variable / command sub
                    parts.push(self.read_dollar(true)?);
                }
                Some('`') => {
                    flush!();
                    pushed_any = true;
                    self.pos -= 1; // reparse the '`' as command sub
                    parts.push(self.read_backtick(true)?);
                }
                Some(c) => literal.push(c),
            }
        }
        if !literal.is_empty() {
            pushed_any = true;
        }
        flush!();
        if !pushed_any {
            parts.push(WordPart::QuotedLiteral(String::new()));
        }
        Ok(())
    }

    /// Parse a `$`-expansion: `$((expr))` arithmetic expansion, `$(script)`
    /// command substitution, or a `$VAR`/`${VAR}`/`$?` variable reference.
    /// Assumes the cursor is on `$`. `quoted` is true inside double quotes.
    fn read_dollar(&mut self, quoted: bool) -> Result<WordPart, ParseError> {
        debug_assert_eq!(self.peek(), Some('$'));
        if self.peek2() == Some('(') {
            if self.peek3() == Some('(') {
                self.bump(); // $
                self.bump(); // (
                self.bump(); // (
                let body = self.read_double_paren_body()?;
                let expr = crate::arithmetic::parse(&body)
                    .map_err(|e| ParseError { message: e.message })?;
                return Ok(WordPart::Arith { expr, quoted });
            }
            self.bump(); // $
            self.bump(); // (
            let body = self.read_paren_body()?;
            return Ok(WordPart::CommandSub {
                script: parse(&body)?,
                quoted,
            });
        }
        Ok(WordPart::Variable {
            name: self.read_variable()?,
            quoted,
        })
    }

    /// Collect the raw source inside a double-paren span (`$((...))` with the
    /// `$((` already consumed, or `((...))` with the `((` already consumed)
    /// up to the matching `))`. `depth` here tracks only *inner* nesting
    /// (e.g. the grouping parens in `(1 + 2) * 3`); the terminator is the
    /// first `))` seen while depth is back to 0, so a lone `)` that closes an
    /// inner group doesn't get confused with the two closing parens the
    /// construct itself needs.
    fn read_double_paren_body(&mut self) -> Result<String, ParseError> {
        let mut depth = 0u32;
        let mut body = String::new();
        loop {
            match self.peek() {
                None => return err("unterminated `((`"),
                Some('(') => {
                    self.bump();
                    depth += 1;
                    body.push('(');
                }
                Some(')') => {
                    if depth > 0 {
                        self.bump();
                        depth -= 1;
                        body.push(')');
                    } else if self.peek2() == Some(')') {
                        self.bump();
                        self.bump();
                        break;
                    } else {
                        self.bump();
                        body.push(')');
                    }
                }
                Some(c) => {
                    self.bump();
                    body.push(c);
                }
            }
        }
        Ok(body)
    }

    /// Collect the raw source inside `$( ... )` up to the matching close paren,
    /// tracking nesting and skipping quoted spans so a `)` inside quotes or a
    /// nested command does not close early. The opening `$(` is already consumed.
    fn read_paren_body(&mut self) -> Result<String, ParseError> {
        let mut depth = 1;
        let mut body = String::new();
        loop {
            match self.bump() {
                None => return err("unterminated $("),
                Some('(') => {
                    depth += 1;
                    body.push('(');
                }
                Some(')') => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    body.push(')');
                }
                Some('\'') => {
                    body.push('\'');
                    loop {
                        match self.bump() {
                            None => return err("unterminated single quote"),
                            Some('\'') => {
                                body.push('\'');
                                break;
                            }
                            Some(c) => body.push(c),
                        }
                    }
                }
                Some('"') => {
                    body.push('"');
                    loop {
                        match self.bump() {
                            None => return err("unterminated double quote"),
                            Some('\\') => {
                                body.push('\\');
                                if let Some(c) = self.bump() {
                                    body.push(c);
                                }
                            }
                            Some('"') => {
                                body.push('"');
                                break;
                            }
                            Some(c) => body.push(c),
                        }
                    }
                }
                Some(c) => body.push(c),
            }
        }
        Ok(body)
    }

    /// Parse `` `script` `` command substitution. Assumes the cursor is on the
    /// opening backtick. `quoted` is true inside double quotes.
    fn read_backtick(&mut self, quoted: bool) -> Result<WordPart, ParseError> {
        debug_assert_eq!(self.peek(), Some('`'));
        self.bump(); // opening `
        let mut body = String::new();
        loop {
            match self.bump() {
                None => return err("unterminated backtick"),
                Some('`') => break,
                Some('\\') => match self.bump() {
                    None => return err("unterminated backtick"),
                    Some(c @ ('`' | '\\' | '$')) => body.push(c),
                    Some(c) => {
                        body.push('\\');
                        body.push(c);
                    }
                },
                Some(c) => body.push(c),
            }
        }
        Ok(WordPart::CommandSub {
            script: parse(&body)?,
            quoted,
        })
    }

    fn read_variable(&mut self) -> Result<String, ParseError> {
        debug_assert_eq!(self.peek(), Some('$'));
        self.bump();
        match self.peek() {
            Some('{') => {
                self.bump();
                let mut name = String::new();
                loop {
                    match self.bump() {
                        None => return err("unterminated ${"),
                        Some('}') => break,
                        Some(c) => name.push(c),
                    }
                }
                Ok(name)
            }
            Some('?') => {
                self.bump();
                Ok("?".to_string())
            }
            // Special params `$@`/`$*`/`$#` and a single-digit positional param
            // `$1`..`$9` (multi-digit needs braces: `${10}`). `$0` is the name.
            Some(c @ ('@' | '*' | '#')) => {
                self.bump();
                Ok(c.to_string())
            }
            Some(c) if c.is_ascii_digit() => {
                self.bump();
                Ok(c.to_string())
            }
            Some(c) if c == '_' || c.is_ascii_alphabetic() => {
                let mut name = String::new();
                while let Some(c) = self.peek() {
                    if c == '_' || c.is_ascii_alphanumeric() {
                        name.push(c);
                        self.bump();
                    } else {
                        break;
                    }
                }
                Ok(name)
            }
            // A lone `$` is a literal dollar sign.
            _ => Ok(String::new()),
        }
    }
}

// ----- parser -----------------------------------------------------------------

struct Parser {
    tokens: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.pos)
    }

    fn bump(&mut self) -> Option<Token> {
        let t = self.tokens.get(self.pos).cloned();
        if t.is_some() {
            self.pos += 1;
        }
        t
    }

    fn parse_script(&mut self) -> Result<Script, ParseError> {
        let statements = self.parse_statement_list(&[])?;
        if let Some(other) = self.peek() {
            return err(format!("unexpected token {other:?}"));
        }
        Ok(Script { statements })
    }

    /// Parse a `;`/newline-separated statement list, stopping at EOF or a
    /// reserved terminator keyword named in `terminators` (left unconsumed). A
    /// trailing `&` marks a statement as background.
    fn parse_statement_list(&mut self, terminators: &[&str]) -> Result<Vec<Statement>, ParseError> {
        let mut statements = Vec::new();
        loop {
            // Skip leading separators / blank lines.
            while matches!(self.peek(), Some(Token::Newline | Token::Semi)) {
                self.bump();
            }
            if self.peek().is_none() || self.at_keyword(terminators) {
                break;
            }
            let mut statement = self.parse_statement()?;
            if matches!(self.peek(), Some(Token::Amp)) {
                self.bump();
                statement.background = true;
            }
            statements.push(statement);
            // Consume the separator between statements.
            match self.peek() {
                Some(Token::Semi | Token::Newline) => {
                    self.bump();
                }
                Some(Token::Amp) => {} // handled above for the next statement
                None => {}
                _ if self.at_keyword(terminators) => {}
                Some(other) => {
                    return err(format!("unexpected token {other:?}"));
                }
            }
        }
        Ok(statements)
    }

    /// True if the current token is a `Word` matching one of `keywords`.
    fn at_keyword(&self, keywords: &[&str]) -> bool {
        match self.peek() {
            Some(Token::Word(w)) => word_literal(w).is_some_and(|k| keywords.contains(&k)),
            _ => false,
        }
    }

    /// The reserved keyword the current token names, if any.
    fn peek_keyword(&self) -> Option<&'static str> {
        match self.peek() {
            Some(Token::Word(w)) => compound_keyword(w),
            _ => None,
        }
    }

    /// Consume a `Word` token equal to `kw`, or error.
    fn expect_keyword(&mut self, kw: &str) -> Result<(), ParseError> {
        let matched = matches!(self.peek(), Some(Token::Word(w)) if word_literal(w) == Some(kw));
        if matched {
            self.bump();
            Ok(())
        } else {
            err(format!("expected `{kw}`"))
        }
    }

    /// Skip `;`/newline separators.
    fn skip_separators(&mut self) {
        while matches!(self.peek(), Some(Token::Newline | Token::Semi)) {
            self.bump();
        }
    }

    fn parse_statement(&mut self) -> Result<crate::ast::Statement, ParseError> {
        let mut pipelines = vec![self.parse_pipeline()?];
        let mut operators = Vec::new();
        loop {
            match self.peek() {
                Some(Token::AndAnd) => {
                    self.bump();
                    operators.push(LogicalOp::And);
                }
                Some(Token::OrOr) => {
                    self.bump();
                    operators.push(LogicalOp::Or);
                }
                _ => break,
            }
            self.skip_newlines();
            pipelines.push(self.parse_pipeline()?);
        }
        Ok(crate::ast::Statement {
            pipelines,
            operators,
            background: false,
        })
    }

    fn skip_newlines(&mut self) {
        while matches!(self.peek(), Some(Token::Newline)) {
            self.bump();
        }
    }

    fn parse_pipeline(&mut self) -> Result<Pipeline, ParseError> {
        let mut negated = false;
        while matches!(self.peek(), Some(Token::Bang)) {
            self.bump();
            negated = !negated;
        }
        let mut commands = vec![self.parse_command()?];
        while matches!(self.peek(), Some(Token::Pipe)) {
            self.bump();
            self.skip_newlines();
            commands.push(self.parse_command()?);
        }
        Ok(Pipeline { commands, negated })
    }

    fn parse_command(&mut self) -> Result<Command, ParseError> {
        if matches!(self.peek(), Some(Token::DParen(_))) {
            let Some(Token::DParen(body)) = self.bump() else {
                unreachable!()
            };
            let expr =
                crate::arithmetic::parse(&body).map_err(|e| ParseError { message: e.message })?;
            return Ok(Command::Arith(expr));
        }
        // A reserved word in command position starts a compound command.
        let compound = match self.peek() {
            Some(Token::Word(w)) => compound_keyword(w),
            _ => None,
        };
        if let Some(kw) = compound {
            return match kw {
                "if" => self.parse_if(),
                "for" => self.parse_for(),
                "while" => self.parse_while(false),
                "until" => self.parse_while(true),
                // A terminator keyword here has no opening construct.
                _ => err(format!("syntax error near unexpected token `{kw}`")),
            };
        }

        let mut assignments = Vec::new();
        let mut words: Vec<Word> = Vec::new();
        let mut redirects: Vec<Redirect> = Vec::new();
        // Words, assignments, and redirections may interleave. A leading
        // `NAME=value` word is an assignment until the first real word.
        loop {
            match self.peek() {
                Some(Token::Word(_)) => {
                    let Some(Token::Word(word)) = self.bump() else {
                        unreachable!()
                    };
                    if words.is_empty()
                        && let Some(assignment) = as_assignment(&word)
                    {
                        assignments.push(assignment);
                        continue;
                    }
                    words.push(word);
                }
                Some(Token::IoNumber(_)) => {
                    let Some(Token::IoNumber(fd)) = self.bump() else {
                        unreachable!()
                    };
                    redirects.push(self.parse_redirect(Some(fd))?);
                }
                Some(
                    Token::Less | Token::Great | Token::DGreat | Token::GreatAnd | Token::LessAnd,
                ) => {
                    redirects.push(self.parse_redirect(None)?);
                }
                _ => break,
            }
        }
        if assignments.is_empty() && words.is_empty() && redirects.is_empty() {
            return err("expected a command");
        }
        Ok(Command::Simple(SimpleCommand {
            assignments,
            words,
            redirects,
        }))
    }

    /// Parse one redirection whose operator is next. `fd` is an explicit
    /// leading IO_NUMBER (`2>`), else the operator's default descriptor (0 for
    /// `<`, 1 for `>`/`>>`). The `>&`/`<&` forms take a descriptor number
    /// target (`2>&1`) rather than a filename.
    fn parse_redirect(&mut self, fd: Option<u32>) -> Result<Redirect, ParseError> {
        let (kind, default_fd, dup) = match self.bump() {
            Some(Token::Less) => (RedirectKind::Read, 0, false),
            Some(Token::Great) => (RedirectKind::Write, 1, false),
            Some(Token::DGreat) => (RedirectKind::Append, 1, false),
            Some(Token::GreatAnd) => (RedirectKind::Write, 1, true),
            Some(Token::LessAnd) => (RedirectKind::Read, 0, true),
            _ => return err("expected a redirection operator"),
        };
        let fd = fd.unwrap_or(default_fd);
        if dup {
            // The digit run after `>&`/`<&` lexes as a Word normally, or as an
            // IoNumber when another redirect immediately follows (`2>&1>f`).
            let n = match self.bump() {
                Some(Token::IoNumber(n)) => n,
                Some(Token::Word(w)) => word_literal(&w)
                    .and_then(|t| t.parse::<u32>().ok())
                    .ok_or_else(|| ParseError {
                        message: "expected a file descriptor after `>&`".to_string(),
                    })?,
                _ => return err("expected a file descriptor after `>&`"),
            };
            return Ok(Redirect {
                fd,
                kind,
                target: RedirectTarget::Dup(n),
            });
        }
        match self.bump() {
            Some(Token::Word(target)) => Ok(Redirect {
                fd,
                kind,
                target: RedirectTarget::File(target),
            }),
            _ => err("expected a filename after a redirection"),
        }
    }

    fn parse_if(&mut self) -> Result<Command, ParseError> {
        self.expect_keyword("if")?;
        let cond = self.parse_statement_list(&["then"])?;
        self.expect_keyword("then")?;
        let body = self.parse_statement_list(&["elif", "else", "fi"])?;
        let mut elifs = Vec::new();
        let mut else_body = None;
        loop {
            match self.peek_keyword() {
                Some("elif") => {
                    self.bump();
                    let cond = self.parse_statement_list(&["then"])?;
                    self.expect_keyword("then")?;
                    let body = self.parse_statement_list(&["elif", "else", "fi"])?;
                    elifs.push((cond, body));
                }
                Some("else") => {
                    self.bump();
                    else_body = Some(self.parse_statement_list(&["fi"])?);
                    break;
                }
                Some("fi") => break,
                _ => return err("expected `elif`, `else`, or `fi`"),
            }
        }
        self.expect_keyword("fi")?;
        Ok(Command::Compound(CompoundCommand::If {
            cond,
            body,
            elifs,
            else_body,
        }))
    }

    fn parse_for(&mut self) -> Result<Command, ParseError> {
        self.expect_keyword("for")?;
        // C-style header: `for (( init; cond; update ))`.
        if let Some(Token::DParen(_)) = self.peek() {
            return self.parse_cstyle_for();
        }
        let name = match self.bump() {
            Some(Token::Word(w)) => match word_literal(&w) {
                Some(n) if is_valid_name(n) => n.to_string(),
                _ => return err("expected a variable name after `for`"),
            },
            _ => return err("expected a variable name after `for`"),
        };
        // Optional `in word...`; without it the loop iterates over nothing (bash
        // uses the positional parameters, which the workflow shell has none of).
        let mut items = Vec::new();
        if matches!(self.peek(), Some(Token::Word(w)) if word_literal(w) == Some("in")) {
            self.bump();
            while let Some(Token::Word(_)) = self.peek() {
                if let Some(Token::Word(w)) = self.bump() {
                    items.push(w);
                }
            }
        }
        self.skip_separators();
        self.expect_keyword("do")?;
        let body = self.parse_statement_list(&["done"])?;
        self.expect_keyword("done")?;
        Ok(Command::Compound(CompoundCommand::For {
            name,
            items,
            body,
        }))
    }

    /// `for (( init; cond; update )); do body; done`. The `for` keyword is
    /// already consumed and the next token is the `(( ... ))` header.
    fn parse_cstyle_for(&mut self) -> Result<Command, ParseError> {
        let Some(Token::DParen(body)) = self.bump() else {
            unreachable!()
        };
        let parts = split_top_level_semis(&body);
        if parts.len() != 3 {
            return err("expected `(( init; cond; update ))` in C-style for loop");
        }
        let parse_part = |src: &str| -> Result<Option<crate::arithmetic::ArithExpr>, ParseError> {
            if src.trim().is_empty() {
                return Ok(None);
            }
            crate::arithmetic::parse(src)
                .map(Some)
                .map_err(|e| ParseError { message: e.message })
        };
        let init = parse_part(&parts[0])?;
        let cond = parse_part(&parts[1])?;
        let update = parse_part(&parts[2])?;
        self.skip_separators();
        self.expect_keyword("do")?;
        let body = self.parse_statement_list(&["done"])?;
        self.expect_keyword("done")?;
        Ok(Command::Compound(CompoundCommand::CStyleFor {
            init,
            cond,
            update,
            body,
        }))
    }

    fn parse_while(&mut self, until: bool) -> Result<Command, ParseError> {
        self.expect_keyword(if until { "until" } else { "while" })?;
        let cond = self.parse_statement_list(&["do"])?;
        self.expect_keyword("do")?;
        let body = self.parse_statement_list(&["done"])?;
        self.expect_keyword("done")?;
        Ok(Command::Compound(CompoundCommand::While {
            cond,
            body,
            until,
        }))
    }
}

/// Split a C-style `for` header body on `;` that sit outside any parentheses,
/// so a grouped sub-expression like `(a; b)` (not valid arithmetic, but kept
/// intact for a faithful error) or a nested `for (( (i=0); ...; ... ))` does
/// not split mid-expression. Arithmetic expressions never contain a bare `;`,
/// so top-level `;` always delimits the init/cond/update parts.
fn split_top_level_semis(body: &str) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut depth = 0i32;
    for c in body.chars() {
        match c {
            '(' => {
                depth += 1;
                parts.last_mut().unwrap().push(c);
            }
            ')' => {
                depth -= 1;
                parts.last_mut().unwrap().push(c);
            }
            ';' if depth == 0 => parts.push(String::new()),
            _ => parts.last_mut().unwrap().push(c),
        }
    }
    parts
}

/// The literal text of a word if it is exactly one literal part. Used for
/// reserved-word and `NAME` recognition. Quoted words collapse to a single
/// literal too, so a quoted keyword is (rarely, harmlessly) also recognized.
fn word_literal(word: &Word) -> Option<&str> {
    match word.as_slice() {
        [WordPart::Literal(s)] | [WordPart::QuotedLiteral(s)] => Some(s.as_str()),
        _ => None,
    }
}

/// The reserved keyword a word names, if any (`in` is handled contextually and
/// is deliberately excluded).
fn compound_keyword(word: &Word) -> Option<&'static str> {
    match word_literal(word)? {
        "if" => Some("if"),
        "for" => Some("for"),
        "while" => Some("while"),
        "until" => Some("until"),
        "then" => Some("then"),
        "elif" => Some("elif"),
        "else" => Some("else"),
        "fi" => Some("fi"),
        "do" => Some("do"),
        "done" => Some("done"),
        _ => None,
    }
}

fn is_valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c == '_' || c.is_ascii_alphabetic() => {
            chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
        }
        _ => false,
    }
}

/// Recognise `NAME=value` where the value may include further word parts.
fn as_assignment(word: &Word) -> Option<Assignment> {
    let WordPart::Literal(first) = word.first()? else {
        return None;
    };
    let eq = first.find('=')?;
    let name = &first[..eq];
    if name.is_empty() {
        return None;
    }
    let mut chars = name.chars();
    let head = chars.next()?;
    if !(head == '_' || head.is_ascii_alphabetic())
        || !chars.all(|c| c == '_' || c.is_ascii_alphanumeric())
    {
        return None;
    }
    let mut value: Word = Vec::new();
    let rest = &first[eq + 1..];
    if !rest.is_empty() {
        value.push(WordPart::Literal(rest.to_string()));
    }
    value.extend(word.iter().skip(1).cloned());
    Some(Assignment {
        name: name.to_string(),
        value,
    })
}

/// Parse a bash script into an AST.
pub fn parse(source: &str) -> Result<Script, ParseError> {
    let (source, here_docs) = extract_here_docs(source)?;
    let tokens = Lexer::new(&source).tokenize()?;
    let mut parser = Parser { tokens, pos: 0 };
    let mut script = parser.parse_script()?;
    replace_here_docs(&mut script, &here_docs);
    Ok(script)
}

#[derive(Debug)]
struct HereDoc {
    placeholder: String,
    body: Word,
}

#[derive(Debug)]
struct HereDocSpec {
    start: usize,
    end: usize,
    delimiter: String,
    expand: bool,
    strip_tabs: bool,
}

/// Remove here-document bodies before normal lexing and temporarily turn each
/// `<<word` into an ordinary input redirect. This keeps body text completely
/// opaque to the shell grammar while preserving the normal ordering of other
/// redirects on the command line.
fn extract_here_docs(source: &str) -> Result<(String, Vec<HereDoc>), ParseError> {
    let lines: Vec<&str> = source.split_inclusive('\n').collect();
    let mut output = String::new();
    let mut here_docs = Vec::new();
    let mut line_index = 0;

    while line_index < lines.len() {
        let line = lines[line_index];
        let specs = find_here_doc_specs(line)?;
        if specs.is_empty() {
            output.push_str(line);
            line_index += 1;
            continue;
        }

        let mut cursor = 0;
        line_index += 1;
        for spec in &specs {
            let placeholder = format!("/__just_bash_heredoc_{}__", here_docs.len());
            output.push_str(&line[cursor..spec.start]);
            output.push_str("< ");
            output.push_str(&placeholder);
            cursor = spec.end;

            let mut body = String::new();
            let mut terminated = false;
            while line_index < lines.len() {
                let candidate = lines[line_index];
                let without_newline = candidate
                    .strip_suffix('\n')
                    .unwrap_or(candidate)
                    .strip_suffix('\r')
                    .unwrap_or_else(|| candidate.strip_suffix('\n').unwrap_or(candidate));
                let comparable = if spec.strip_tabs {
                    without_newline.trim_start_matches('\t')
                } else {
                    without_newline
                };
                if comparable == spec.delimiter {
                    terminated = true;
                    line_index += 1;
                    break;
                }
                if spec.strip_tabs {
                    body.push_str(candidate.trim_start_matches('\t'));
                } else {
                    body.push_str(candidate);
                }
                line_index += 1;
            }
            if !terminated {
                return err(format!(
                    "here-document delimited by end-of-file (wanted `{}`)",
                    spec.delimiter
                ));
            }
            let body = if spec.expand {
                parse_here_doc_body(&body)?
            } else {
                vec![WordPart::QuotedLiteral(body)]
            };
            here_docs.push(HereDoc { placeholder, body });
        }
        output.push_str(&line[cursor..]);
    }

    Ok((output, here_docs))
}

fn find_here_doc_specs(line: &str) -> Result<Vec<HereDocSpec>, ParseError> {
    let bytes = line.as_bytes();
    let mut specs = Vec::new();
    let mut i = 0;
    let mut single_quoted = false;
    let mut double_quoted = false;

    while i < bytes.len() {
        match bytes[i] {
            b'\\' if !single_quoted => i += 2,
            b'\'' if !double_quoted => {
                single_quoted = !single_quoted;
                i += 1;
            }
            b'"' if !single_quoted => {
                double_quoted = !double_quoted;
                i += 1;
            }
            b'#' if !single_quoted && !double_quoted => break,
            b'$' if !single_quoted
                && !double_quoted
                && bytes.get(i + 1) == Some(&b'(')
                && bytes.get(i + 2) == Some(&b'(') =>
            {
                i = double_paren_end(bytes, i + 3);
            }
            b'(' if !single_quoted && !double_quoted && bytes.get(i + 1) == Some(&b'(') => {
                i = double_paren_end(bytes, i + 2);
            }
            b'<' if !single_quoted
                && !double_quoted
                && bytes.get(i + 1) == Some(&b'<')
                && bytes.get(i + 2) != Some(&b'<') =>
            {
                let start = i;
                i += 2;
                let strip_tabs = bytes.get(i) == Some(&b'-');
                if strip_tabs {
                    i += 1;
                }
                while matches!(bytes.get(i), Some(b' ' | b'\t')) {
                    i += 1;
                }
                let mut delimiter = String::new();
                let mut quoted = false;
                let mut word_started = false;
                while i < bytes.len() {
                    match bytes[i] {
                        b' ' | b'\t' | b'\r' | b'\n' | b';' | b'&' | b'|' | b'<' | b'>'
                            if !single_quoted && !double_quoted =>
                        {
                            break;
                        }
                        b'\'' if !double_quoted => {
                            quoted = true;
                            word_started = true;
                            single_quoted = !single_quoted;
                            i += 1;
                        }
                        b'"' if !single_quoted => {
                            quoted = true;
                            word_started = true;
                            double_quoted = !double_quoted;
                            i += 1;
                        }
                        b'\\' if !single_quoted => {
                            quoted = true;
                            word_started = true;
                            i += 1;
                            let Some(&escaped) = bytes.get(i) else {
                                return err("trailing backslash in here-document delimiter");
                            };
                            delimiter.push(escaped as char);
                            i += 1;
                        }
                        byte => {
                            word_started = true;
                            delimiter.push(byte as char);
                            i += 1;
                        }
                    }
                }
                if single_quoted || double_quoted {
                    return err("unterminated quote in here-document delimiter");
                }
                if !word_started {
                    return err("expected a delimiter after `<<`");
                }
                specs.push(HereDocSpec {
                    start,
                    end: i,
                    delimiter,
                    expand: !quoted,
                    strip_tabs,
                });
            }
            _ => i += 1,
        }
    }
    Ok(specs)
}

fn double_paren_end(bytes: &[u8], mut i: usize) -> usize {
    let mut depth = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' if depth > 0 => {
                depth -= 1;
                i += 1;
            }
            b')' if bytes.get(i + 1) == Some(&b')') => return i + 2,
            _ => i += 1,
        }
    }
    i
}

fn parse_here_doc_body(body: &str) -> Result<Word, ParseError> {
    let mut lexer = Lexer::new(body);
    let mut parts = Vec::new();
    let mut literal = String::new();

    macro_rules! flush {
        () => {
            if !literal.is_empty() {
                parts.push(WordPart::QuotedLiteral(std::mem::take(&mut literal)));
            }
        };
    }

    while let Some(c) = lexer.peek() {
        match c {
            '$' => {
                flush!();
                parts.push(lexer.read_dollar(true)?);
            }
            '`' => {
                flush!();
                parts.push(lexer.read_backtick(true)?);
            }
            '\\' => {
                lexer.bump();
                match lexer.bump() {
                    Some('\n') => {}
                    Some(c @ ('\\' | '$' | '`')) => literal.push(c),
                    Some(c) => {
                        literal.push('\\');
                        literal.push(c);
                    }
                    None => literal.push('\\'),
                }
            }
            _ => {
                lexer.bump();
                literal.push(c);
            }
        }
    }
    flush!();
    Ok(parts)
}

fn replace_here_docs(script: &mut Script, here_docs: &[HereDoc]) {
    for statement in &mut script.statements {
        for pipeline in &mut statement.pipelines {
            for command in &mut pipeline.commands {
                replace_here_docs_in_command(command, here_docs);
            }
        }
    }
}

fn replace_here_docs_in_command(command: &mut Command, here_docs: &[HereDoc]) {
    match command {
        Command::Simple(command) => {
            for redirect in &mut command.redirects {
                let RedirectTarget::File(word) = &redirect.target else {
                    continue;
                };
                let Some(path) = word_literal(word) else {
                    continue;
                };
                if let Some(here_doc) = here_docs.iter().find(|doc| doc.placeholder == path) {
                    redirect.target = RedirectTarget::HereDoc(here_doc.body.clone());
                }
            }
            for word in command
                .words
                .iter_mut()
                .chain(command.assignments.iter_mut().map(|a| &mut a.value))
            {
                replace_here_docs_in_word(word, here_docs);
            }
        }
        Command::Compound(CompoundCommand::If {
            cond,
            body,
            elifs,
            else_body,
        }) => {
            replace_here_docs_in_statements(cond, here_docs);
            replace_here_docs_in_statements(body, here_docs);
            for (cond, body) in elifs {
                replace_here_docs_in_statements(cond, here_docs);
                replace_here_docs_in_statements(body, here_docs);
            }
            if let Some(body) = else_body {
                replace_here_docs_in_statements(body, here_docs);
            }
        }
        Command::Compound(CompoundCommand::For { items, body, .. }) => {
            for word in items {
                replace_here_docs_in_word(word, here_docs);
            }
            replace_here_docs_in_statements(body, here_docs);
        }
        Command::Compound(CompoundCommand::CStyleFor { body, .. }) => {
            replace_here_docs_in_statements(body, here_docs);
        }
        Command::Compound(CompoundCommand::While { cond, body, .. }) => {
            replace_here_docs_in_statements(cond, here_docs);
            replace_here_docs_in_statements(body, here_docs);
        }
        Command::Arith(_) => {}
    }
}

fn replace_here_docs_in_statements(statements: &mut [Statement], here_docs: &[HereDoc]) {
    for statement in statements {
        for pipeline in &mut statement.pipelines {
            for command in &mut pipeline.commands {
                replace_here_docs_in_command(command, here_docs);
            }
        }
    }
}

fn replace_here_docs_in_word(word: &mut Word, here_docs: &[HereDoc]) {
    for part in word {
        if let WordPart::CommandSub { script, .. } = part {
            replace_here_docs(script, here_docs);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lit(s: &str) -> WordPart {
        WordPart::Literal(s.to_string())
    }

    fn qlit(s: &str) -> WordPart {
        WordPart::QuotedLiteral(s.to_string())
    }

    fn var(name: &str, quoted: bool) -> WordPart {
        WordPart::Variable {
            name: name.to_string(),
            quoted,
        }
    }

    fn simple(command: &Command) -> &SimpleCommand {
        match command {
            Command::Simple(cmd) => cmd,
            other => panic!("expected a simple command, got {other:?}"),
        }
    }

    #[test]
    fn simple_command() {
        let script = parse("echo hello world").unwrap();
        assert_eq!(script.statements.len(), 1);
        let cmd = simple(&script.statements[0].pipelines[0].commands[0]);
        assert_eq!(
            cmd.words,
            vec![vec![lit("echo")], vec![lit("hello")], vec![lit("world")]]
        );
    }

    #[test]
    fn assignment_prefix_and_separate() {
        let script = parse("X=5").unwrap();
        let cmd = simple(&script.statements[0].pipelines[0].commands[0]);
        assert_eq!(cmd.assignments[0].name, "X");
        assert_eq!(cmd.assignments[0].value, vec![lit("5")]);
        assert!(cmd.words.is_empty());
    }

    #[test]
    fn background_flag() {
        let script = parse("sleep 1 &").unwrap();
        assert!(script.has_background());
        let fg = parse("sleep 1").unwrap();
        assert!(!fg.has_background());
    }

    #[test]
    fn quotes_and_variables() {
        let script = parse(r#"echo "a $X"b '$Y'"#).unwrap();
        let cmd = simple(&script.statements[0].pipelines[0].commands[0]);
        assert_eq!(cmd.words[1], vec![qlit("a "), var("X", true), lit("b")]);
        assert_eq!(cmd.words[2], vec![qlit("$Y")]);
    }

    #[test]
    fn empty_double_quotes_still_produce_a_part() {
        let script = parse(r#"echo """#).unwrap();
        let cmd = simple(&script.statements[0].pipelines[0].commands[0]);
        assert_eq!(cmd.words[1], vec![qlit("")]);
    }

    #[test]
    fn backslash_escaped_glob_char_is_quoted() {
        let script = parse(r"echo \*").unwrap();
        let cmd = simple(&script.statements[0].pipelines[0].commands[0]);
        assert_eq!(cmd.words[1], vec![qlit("*")]);
    }

    #[test]
    fn command_substitution_parses_nested_script() {
        let script = parse("echo $(echo hi)").unwrap();
        let cmd = simple(&script.statements[0].pipelines[0].commands[0]);
        let WordPart::CommandSub {
            script: inner,
            quoted,
        } = &cmd.words[1][0]
        else {
            panic!("expected command substitution, got {:?}", cmd.words[1]);
        };
        assert!(!quoted);
        let inner_cmd = simple(&inner.statements[0].pipelines[0].commands[0]);
        assert_eq!(inner_cmd.words, vec![vec![lit("echo")], vec![lit("hi")]]);
    }

    #[test]
    fn if_parses_condition_and_branches() {
        let script = parse("if true; then echo yes; else echo no; fi").unwrap();
        let Command::Compound(CompoundCommand::If {
            cond,
            body,
            elifs,
            else_body,
        }) = &script.statements[0].pipelines[0].commands[0]
        else {
            panic!("expected an if command");
        };
        assert_eq!(cond.len(), 1);
        assert_eq!(body.len(), 1);
        assert!(elifs.is_empty());
        assert!(else_body.is_some());
    }

    #[test]
    fn for_collects_items() {
        let script = parse("for i in a b c; do echo $i; done").unwrap();
        let Command::Compound(CompoundCommand::For { name, items, body }) =
            &script.statements[0].pipelines[0].commands[0]
        else {
            panic!("expected a for command");
        };
        assert_eq!(name, "i");
        assert_eq!(items.len(), 3);
        assert_eq!(body.len(), 1);
    }

    #[test]
    fn stray_terminator_is_a_syntax_error() {
        assert!(parse("then echo hi").is_err());
        assert!(parse("if true; then echo hi").is_err());
    }

    #[test]
    fn pipeline_and_operators() {
        let script = parse("a | b && c").unwrap();
        let stmt = &script.statements[0];
        assert_eq!(stmt.pipelines[0].commands.len(), 2);
        assert_eq!(stmt.operators, vec![LogicalOp::And]);
    }

    #[test]
    fn arithmetic_expansion_parses_as_word_part() {
        let script = parse("echo $((1 + 2))").unwrap();
        let cmd = simple(&script.statements[0].pipelines[0].commands[0]);
        let WordPart::Arith { expr, quoted } = &cmd.words[1][0] else {
            panic!("expected arithmetic expansion, got {:?}", cmd.words[1]);
        };
        assert!(!quoted);
        assert_eq!(
            *expr,
            crate::arithmetic::ArithExpr::Binary(
                crate::arithmetic::BinOp::Add,
                Box::new(crate::arithmetic::ArithExpr::Num(1)),
                Box::new(crate::arithmetic::ArithExpr::Num(2)),
            )
        );
    }

    #[test]
    fn arithmetic_command_parses_as_its_own_command() {
        let script = parse("(( x = 5 + 3 ))").unwrap();
        assert!(matches!(
            script.statements[0].pipelines[0].commands[0],
            Command::Arith(_)
        ));
    }
}
