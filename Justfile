serve:
  obelisk server run -d deployment.toml --server-config server.toml 

# Run the keyless stateless MCP example used by the interactive guide and E2E.
sample-mcp-server:
  node examples/stateless-mcp-server.mjs
# Regenerate the workflow's WIT dependency folder from deployment.toml. It is a
# build artifact (gitignored), not a hand-curated set: obelisk cannot know which
# components a single workflow imports, so it emits deps for every component in
# the deployment. wit-bindgen (workflow-rs/build.rs) only reads the ones the
# world imports.
wit-deps:
  mkdir -p workflow/workflow-rs/wit/deps
  obelisk generate wit-deps --deployment deployment.toml --force workflow/workflow-rs/wit/deps
  obelisk generate wit-support workflow --force workflow/workflow-rs/wit/deps
  # Drop the workflow's own package: obelisk emits obelisk-agent:workflow as a
  # dep too, which collides with wit/impl.wit (same package, two locations).
  rm -rf workflow/workflow-rs/wit/deps/obelisk-agent_workflow

# deployment.toml's [[workflow_wasm]] entry points at it; the crate's
# .cargo/config.toml pins the wasm32-unknown-unknown target.
# Build the native Rust workflow component (workflow/workflow-rs).
build: wit-deps
  cd workflow/workflow-rs && cargo build --release

verify: build
  obelisk deployment verify --deployment deployment.toml --server-config server.toml --allow-unavailable-runtime-config

fix: build
  obelisk deployment verify --deployment deployment.toml --server-config server.toml --fix

sync:
  obelisk deployment get $(obelisk deployment active) --force

# Run everything: unit tests plus all end-to-end suites.
test: test-rs test-e2e test-e2e-agent-workflow test-e2e-redeploy test-e2e-mcp

# Rust port: unit tests for the workflow and just-bash-rs interpreter.
test-rs: wit-deps
  cargo test -p just-bash-rs -p workflow-agent-rs

# Rust port: end-to-end test of the bash workflow component under Obelisk.
test-e2e:
  ./scripts/test-e2e.sh

# deployed via the real deployment.toml.
# Rust port: end-to-end test of the full workflow component.
test-e2e-agent-workflow: wit-deps
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
