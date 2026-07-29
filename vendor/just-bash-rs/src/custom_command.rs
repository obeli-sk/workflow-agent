//! PORT: vendor/just-bash/src/custom-commands.ts
//!
//! Registration surface for host-defined commands layered on top of the
//! builtin dispatch table (`commands::dispatch`). A handler is a boxed
//! `FnMut` closure rather than a trait so a caller (e.g. the obelisk-control
//! pack bridge, `obelisk_pack.rs`) can close over whatever external state it
//! needs (a host trait object, in that case) without this crate knowing
//! about it. Unlike upstream's `Command`/`LazyCommand`, there is no lazy-load
//! variant: this port has no code-splitting to defer.

use std::collections::BTreeMap;

use crate::interpreter::{CommandOutput, Interpreter};

/// A registered custom command. Takes the interpreter (for `fs`/`cwd`/`env`
/// access, the same surface a builtin gets), the command's argv with
/// `argv[0]` already stripped, and its stdin.
pub type CustomCommandHandler =
    Box<dyn FnMut(&mut Interpreter, &[String], String) -> CommandOutput>;

/// Name -> handler registry, held by `Bash` and moved into the `Interpreter`
/// for the duration of one `exec` call (the same move-in/move-out pattern
/// `Bash::exec` already uses for `Vfs`), since a handler needs `&mut
/// Interpreter` and can't be called while also borrowed out of it.
#[derive(Default)]
pub struct CustomCommands(BTreeMap<String, CustomCommandHandler>);

impl CustomCommands {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register (or replace) a command, checked in `commands::dispatch` after
    /// the builtin table when no case matches.
    pub fn register(&mut self, name: impl Into<String>, handler: CustomCommandHandler) {
        self.0.insert(name.into(), handler);
    }

    pub fn contains(&self, name: &str) -> bool {
        self.0.contains_key(name)
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.0.keys().map(String::as_str)
    }

    /// Temporarily take a handler out so it can be called with a `&mut
    /// Interpreter` that also owns this registry; see module docs.
    pub(crate) fn take(&mut self, name: &str) -> Option<CustomCommandHandler> {
        self.0.remove(name)
    }

    pub(crate) fn put_back(&mut self, name: String, handler: CustomCommandHandler) {
        self.0.insert(name, handler);
    }
}
