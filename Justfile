serve:
  obelisk server run -d deployment.toml --server-config server.toml 

serve-target:
  obelisk server run --server-config server-target.toml 

# Run the keyless stateless MCP example used by the interactive guide and E2E.
sample-mcp-server:
  node examples/stateless-mcp-server.mjs

# Build the native Rust workflow component (workflow/workflow-rs).
# The generated wit/deps are committed; regenerate with scripts/generate-wit-deps.sh
# after changing the source WIT.
build:
  cd workflow/workflow-rs && cargo build --release

verify: build
  obelisk deployment verify --deployment deployment.toml --server-config server.toml --allow-unavailable-runtime-config

fix: build
  obelisk deployment verify --deployment deployment.toml --server-config server.toml --fix

sync:
  obelisk deployment get $(obelisk deployment active) --force

# Test everything: unit tests plus all end-to-end suites.
test: test-rs test-js test-e2e

# Unit tests for the workflow and just-bash-rs interpreter.
test-rs:
  cargo test -p just-bash-rs -p workflow-agent-rs

# Web UI: unit tests for the served transcript renderer (turn/step grouping).
# Activities: unit tests for the curl and chat programs' flag handling.
# Shared session-state projection (sidebar + chat state).
test-js:
  node --test webhook/ui/shell.test.js
  node --test activity/curl.test.js
  node --test activity/chat.test.js
  node --test shared/session-state.test.js

# All end-to-end suites, each against its own isolated, throwaway obelisk server.
# See scripts/test-e2e-*.sh; the mcp suite SKIPs when no docker/podman is on PATH.
test-e2e:
  ./scripts/test-e2e-bash-workflow.sh
  ./scripts/test-e2e-agent-workflow.sh
  ./scripts/test-e2e-chat.sh
  ./scripts/test-e2e-redeploy.sh
  ./scripts/test-e2e-interrupt.sh
  ./scripts/test-e2e-mcp.sh
