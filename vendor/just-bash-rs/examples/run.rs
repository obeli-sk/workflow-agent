//! Minimal end-to-end demo: run a bash script through the Rust interpreter.
//!
//! `cargo run -p just-bash-rs --example run -- 'echo hi | cat'`

use just_bash_rs::{Bash, BashOptions, ExecOptions};

fn main() {
    let script = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "X=world; echo \"hello $X\" | cat".to_string());

    let mut bash = Bash::new(BashOptions {
        cwd: "/workspace".into(),
        ..Default::default()
    });
    let result = bash.exec(&script, ExecOptions::default());

    print!("{}", result.stdout);
    eprint!("{}", result.stderr);
    std::process::exit(result.exit_code);
}
