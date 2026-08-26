//! PORT: vendor/just-bash/src/ast/types.ts
//!
//! AST covering the subset the parser and interpreter currently support:
//! statements joined by `&&`/`||`/`;`, pipelines, simple commands with prefix
//! assignments and redirections, compound commands (if/for/while/case), and
//! words built from literal, variable, and command-substitution parts. Functions and
//! arithmetic are added in later phases (see
//! meta/designs/workflow-agent-rust-port.md).

/// Root node: a complete script.
#[derive(Debug, Clone, PartialEq)]
pub struct Script {
    pub statements: Vec<Statement>,
}

/// A list of pipelines joined by `&&` / `||`. `operators[i]` connects
/// `pipelines[i]` to `pipelines[i + 1]`.
#[derive(Debug, Clone, PartialEq)]
pub struct Statement {
    pub pipelines: Vec<Pipeline>,
    pub operators: Vec<LogicalOp>,
    /// Run detached with a trailing `&`. The session loop rejects these.
    pub background: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogicalOp {
    And,
    Or,
}

/// A pipeline: `cmd1 | cmd2 | cmd3`, optionally negated with a leading `!`.
#[derive(Debug, Clone, PartialEq)]
pub struct Pipeline {
    pub commands: Vec<Command>,
    pub negated: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Simple(SimpleCommand),
    Compound(CompoundCommand),
    /// `(( expr ))`: the arithmetic command. Exit status is 0 if the result is
    /// non-zero, 1 otherwise (the same value `$((expr))` would expand to).
    Arith(crate::arithmetic::ArithExpr),
}

/// A control-flow construct. Each body is a statement list (an `&&`/`||`/`;`
/// sequence), matching bash's `list` non-terminal.
#[derive(Debug, Clone, PartialEq)]
pub enum CompoundCommand {
    /// `if cond; then body; (elif cond; then body;)* (else body;)? fi`.
    If {
        cond: Vec<Statement>,
        body: Vec<Statement>,
        /// Zero or more `elif` (condition, body) pairs, in source order.
        elifs: Vec<(Vec<Statement>, Vec<Statement>)>,
        else_body: Option<Vec<Statement>>,
    },
    /// `for name in items; do body; done`. With no `in`, `items` is empty.
    For {
        name: String,
        items: Vec<Word>,
        body: Vec<Statement>,
    },
    /// `for (( init; cond; update )); do body; done`, the C-style arithmetic
    /// for loop. Any of the three header clauses may be absent (`for ((;;))`).
    CStyleFor {
        init: Option<crate::arithmetic::ArithExpr>,
        cond: Option<crate::arithmetic::ArithExpr>,
        update: Option<crate::arithmetic::ArithExpr>,
        body: Vec<Statement>,
    },
    /// `while cond; do body; done`, or `until` when `until` is true.
    While {
        cond: Vec<Statement>,
        body: Vec<Statement>,
        until: bool,
    },
    /// `case subject in pat|pat) body;; ... esac`. First matching arm wins;
    /// no fallthrough (`;&` / `;;&` are not modelled).
    Case {
        subject: Word,
        arms: Vec<CaseArm>,
    },
}

/// One `case` arm: any-of patterns plus the body run on the first match.
#[derive(Debug, Clone, PartialEq)]
pub struct CaseArm {
    pub patterns: Vec<Word>,
    pub body: Vec<Statement>,
}

/// `NAME=value ... name arg arg [redirects]`.
#[derive(Debug, Clone, PartialEq)]
pub struct SimpleCommand {
    pub assignments: Vec<Assignment>,
    /// Command name plus arguments. Empty when the command is assignment-only.
    pub words: Vec<Word>,
    /// I/O redirections applied to this command, in source order.
    pub redirects: Vec<Redirect>,
}

/// A single redirection such as `> file`, `>> file`, `< file`, a here-document,
/// or an fd-duplication like `2>&1` / `1>&2`.
#[derive(Debug, Clone, PartialEq)]
pub struct Redirect {
    /// The descriptor being redirected. Defaults to 0 for `<` and 1 for
    /// `>`/`>>`, overridden by an explicit leading number (`2>`, `1>&2`).
    pub fd: u32,
    pub kind: RedirectKind,
    pub target: RedirectTarget,
}

/// Where a redirection points: a filename word, or another descriptor for the
/// `>&N` / `<&N` duplication forms (`2>&1` is `fd 2 -> Dup(1)`).
#[derive(Debug, Clone, PartialEq)]
pub enum RedirectTarget {
    File(Word),
    Dup(u32),
    HereDoc(Word),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RedirectKind {
    /// `< file`: read stdin from a file.
    Read,
    /// `> file`: truncate-write stdout to a file.
    Write,
    /// `>> file`: append stdout to a file.
    Append,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Assignment {
    pub name: String,
    pub value: Word,
}

/// A word is a sequence of parts that concatenate into one field before
/// field splitting / globbing (see `expansion.rs`), which then may expand it
/// into zero or more fields.
pub type Word = Vec<WordPart>;

#[derive(Debug, Clone, PartialEq)]
pub enum WordPart {
    /// Literal text typed outside of any quotes: eligible for pathname
    /// globbing and IFS treats it as ordinary field content (never itself
    /// split, since whitespace already separates words at the lexer level).
    Literal(String),
    /// Literal text from inside single or double quotes (including an empty
    /// quote pair, so `""` still anchors one field): never glob-expanded, and
    /// always "anchors" at least one field, even when it and every other part
    /// of the word are empty.
    QuotedLiteral(String),
    /// `$NAME`, `${NAME}`, or a special parameter like `$?`. `quoted` is true
    /// inside double quotes, which suppresses IFS field splitting.
    Variable { name: String, quoted: bool },
    /// `$(script)` or `` `script` ``: the captured stdout of a nested script,
    /// with trailing newlines stripped. `quoted` suppresses field splitting.
    CommandSub { script: Script, quoted: bool },
    /// `$((expr))`: arithmetic expansion. `quoted` suppresses field splitting
    /// (the result is always a plain integer, so this rarely matters).
    Arith {
        expr: crate::arithmetic::ArithExpr,
        quoted: bool,
    },
}

impl Script {
    /// True if any statement runs in the background (`&`), including inside
    /// compound-command bodies. This is the exact predicate the workflow session
    /// loop uses to reject detached jobs.
    pub fn has_background(&self) -> bool {
        self.statements.iter().any(statement_has_background)
    }
}

fn statement_has_background(statement: &Statement) -> bool {
    statement.background
        || statement
            .pipelines
            .iter()
            .flat_map(|p| &p.commands)
            .any(command_has_background)
}

fn command_has_background(command: &Command) -> bool {
    match command {
        Command::Simple(_) | Command::Arith(_) => false,
        Command::Compound(compound) => match compound {
            CompoundCommand::If {
                cond,
                body,
                elifs,
                else_body,
            } => {
                cond.iter().any(statement_has_background)
                    || body.iter().any(statement_has_background)
                    || elifs.iter().any(|(c, b)| {
                        c.iter().any(statement_has_background)
                            || b.iter().any(statement_has_background)
                    })
                    || else_body
                        .as_ref()
                        .is_some_and(|b| b.iter().any(statement_has_background))
            }
            CompoundCommand::For { body, .. } => body.iter().any(statement_has_background),
            CompoundCommand::CStyleFor { body, .. } => body.iter().any(statement_has_background),
            CompoundCommand::While { cond, body, .. } => {
                cond.iter().any(statement_has_background)
                    || body.iter().any(statement_has_background)
            }
            CompoundCommand::Case { arms, .. } => arms
                .iter()
                .any(|arm| arm.body.iter().any(statement_has_background)),
        },
    }
}
