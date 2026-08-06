serve:
  obelisk server run -d deployment.toml --server-config server.toml 
# deployment.toml's [[workflow_wasm]] entry points at it; the crate's
# .cargo/config.toml pins the wasm32-unknown-unknown target.
# Build the native Rust workflow component (workflow/workflow-rs).
build:
  cd workflow/workflow-rs && cargo build --release

verify: build
  obelisk deployment verify --deployment deployment.toml --server-config server.toml --allow-unavailable-runtime-config

sync:
  obelisk deployment get $(obelisk deployment active) --force

# Run everything: unit tests plus all end-to-end suites.
test: test-rs test-e2e test-e2e-agent-workflow test-e2e-redeploy test-e2e-mcp

# Rust port: unit tests for the workflow and just-bash-rs interpreter.
test-rs:
  cargo test -p just-bash-rs -p workflow-agent-rs

# Rust port: end-to-end test of the bash workflow component under Obelisk.
test-e2e:
  ./scripts/test-e2e.sh

# deployed via the real deployment.toml.
# Rust port: end-to-end test of the full agent-loop/run workflow component.
test-e2e-agent-workflow:
  ./scripts/test-e2e-agent-workflow.sh

# End-to-end no-op redeploy of the current deployment via the content-addressed
# submit tool (empty edited-files list, no source uploads).
test-e2e-redeploy:
  ./scripts/test-e2e-redeploy.sh

# End-to-end MCP: runs a stateless MCP server in a docker/podman container and
# drives discovery, the `mcp` registry, and tool/prompt calls over real HTTP.
# SKIPs when no container runtime is on PATH (the nix devshell ships neither
# docker nor podman, so run this where docker is available).
test-e2e-mcp:
  ./scripts/test-e2e-mcp.sh
