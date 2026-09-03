serve: serve-rs

# Rust session-workflow backend (workflow/workflow-rs, deployment.rs.toml),
# the default `serve` depends on. Depends on `build-rs` so the server always
# runs the wasm just compiled from the current source, never a stale one left
# over from an earlier build.
serve-rs: build-rs
  obelisk server run -d deployment.rs.toml --server-config server.toml

# Same session-workflow FFQN as `serve`, but backed by the JS workflow
# (workflow/workflow-js, deployment.js.toml) instead of the Rust default (see
# docs/js-backend-migration.md). A session started under one and continued
# under the other replays cleanly, since both export
# obelisk-agent:workflow/workflow.run-cancellable identically; switch a
# running server between them with `obelisk deployment apply`.
serve-js:
  obelisk server run -d deployment.js.toml --server-config server.toml

serve-target:
  obelisk server run --server-config server-target.toml 

# Run the keyless stateless MCP example used by the interactive guide and E2E.
sample-mcp-server:
  node examples/stateless-mcp-server.mjs

# Build the native Rust workflow component (workflow/workflow-rs).
# The generated wit/deps are committed; regenerate with scripts/generate-wit-deps.sh
# after changing the source WIT.
build-rs:
  cd workflow/workflow-rs && cargo build --release

verify: build-rs
  obelisk deployment verify --deployment deployment.rs.toml --server-config server.toml --allow-unavailable-runtime-config
  obelisk deployment verify --deployment deployment.js.toml --server-config server.toml --allow-unavailable-runtime-config
  ./scripts/check-deployment-toml-parity.sh

# Test everything: unit tests plus all end-to-end suites.
test: test-rs test-js test-e2e

# Unit tests for the workflow and just-bash-rs interpreter.
test-rs:
  cargo test -p just-bash-rs -p workflow-agent-rs

# Web UI: unit tests for the served transcript renderer (turn/step grouping).
# Activities: unit tests for the curl and chat programs' flag handling, the
# GitHub contents mount transport (symlink resolution), and config.discover
# (registries plus the shared prompt-tail/self-section rendering).
# Shared session-state projection (sidebar + chat state).
# vendor/just-bash: the hand-written JS bash interpreter (JS workflow backend).
test-js:
  node --test webhook/ui/shell.test.js
  node --test activity/curl.test.js
  node --test activity/chat.test.js
  node --test activity/github-contents.test.js
  node --test activity/config-discover.test.js
  node --test packs/obelisk-control/native-call.test.mjs
  node --test shared/session-state.test.js
  node --test $(find vendor/just-bash/src -name '*.test.js')
  node --test $(find workflow/workflow-js/src -name '*.test.js')

# All end-to-end suites, each against its own isolated, throwaway obelisk server.
# See scripts/test-e2e-*.sh; the mcp suite SKIPs when no docker/podman is on PATH.
# agent-workflow/chat/interrupt/mcp/redeploy/target-deploy run against both the
# Rust and JS session-workflow backends (same FFQN, see
# docs/js-backend-migration.md); target-deploy proves the agent can redeploy a
# separate target Obelisk instance without ever hot-swapping its own driving
# deployment (see the script's header comment for why that self-swap design
# was replaced). bash-workflow tests the unrelated standalone bash-rs
# workflow, backend-agnostic.
test-e2e:
  ./scripts/test-e2e-bash-workflow.sh
  ./scripts/test-e2e-agent-workflow.sh rs
  ./scripts/test-e2e-agent-workflow.sh js
  ./scripts/test-e2e-chat.sh rs
  ./scripts/test-e2e-chat.sh js
  ./scripts/test-e2e-redeploy.sh rs
  ./scripts/test-e2e-redeploy.sh js
  ./scripts/test-e2e-interrupt.sh rs
  ./scripts/test-e2e-interrupt.sh js
  ./scripts/test-e2e-mcp.sh rs
  ./scripts/test-e2e-mcp.sh js
  ./scripts/test-e2e-target-deploy.sh rs
  ./scripts/test-e2e-target-deploy.sh js
