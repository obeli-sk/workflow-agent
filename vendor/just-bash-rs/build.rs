//! Capture the devshell Obelisk's default `deployment.toml` template so the
//! `obelisk generate deployment` shell command (see src/obelisk_pack.rs) can
//! print it without a live server. Running the real binary at build time keeps
//! the embedded template in lockstep with the Obelisk version this component is
//! built against.

use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR is set for build scripts");
    let dest = PathBuf::from(out_dir).join("deployment-template.toml");

    let output = Command::new("obelisk")
        .args(["generate", "deployment"])
        .output()
        .expect("run `obelisk generate deployment` (is obelisk on PATH? use `nix develop`)");
    assert!(
        output.status.success(),
        "`obelisk generate deployment` failed ({}): {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );

    std::fs::write(&dest, &output.stdout).expect("write deployment-template.toml");
}
