//! Rust port of `just-bash`, the virtual bash interpreter the workflow-agent
//! session loop runs as its only model-facing tool.
//!
//! The port is incremental and usage-driven: it targets the exact surface the
//! workflow consumes (`Bash::exec`, the command registry, and `parse` for
//! background-job detection) rather than the whole upstream package. The module
//! tree mirrors `vendor/just-bash/src/` so each TypeScript file maps to an
//! obvious Rust home. See `meta/designs/workflow-agent-rust-port.md` for the
//! phase plan and the TS-to-Rust module map.

pub mod arithmetic;
pub mod ast;
pub mod bash;
pub mod commands;
pub mod custom_command;
pub mod expansion;
pub mod fs;
pub mod glob;
pub mod interpreter;
pub mod obelisk_pack;
pub mod parser;
pub mod types;

pub use bash::Bash;
pub use commands::command_names;
pub use custom_command::{CustomCommandHandler, CustomCommands};
pub use fs::{FsError, Vfs};
pub use obelisk_pack::{MountResult, ObeliskHost, SYSTEM_PROMPT};
pub use parser::parse;
pub use types::{BashOptions, ExecOptions, ExecResult, ExecutionLimits};
