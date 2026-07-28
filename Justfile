serve:
  obelisk server run -d deployment.toml

install:
  pnpm install --frozen-lockfile

# deployment.toml's [[workflow_wasm]] entry points at it; the crate's
# .cargo/config.toml pins the wasm32-unknown-unknown target.
# Build the native Rust workflow component (workflow/workflow-rs).
build:
  cd workflow/workflow-rs && cargo build --release

verify: build
  obelisk server verify --deployment deployment.toml --allow-unavailable-runtime-config

sync:
  obelisk deployment get $(obelisk deployment active) --force

# Rust port: unit tests for the just-bash-rs interpreter.
test-rs:
  cargo test -p just-bash-rs

# Rust port: end-to-end test of the bash workflow component under Obelisk.
test-e2e:
  ./scripts/test-e2e.sh

# deployed via the real deployment.toml.
# Rust port: end-to-end test of the full agent-loop/run workflow component.
test-e2e-agent-workflow:
  ./scripts/test-e2e-agent-workflow.sh
