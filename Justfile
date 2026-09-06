serve: serve-rs

serve-rs: build-rs
  obelisk server run -d deployment.rs.toml --server-config server.toml

serve-js:
  obelisk server run -d deployment.js.toml --server-config server.toml

serve-target:
  rm -rf .target-obelisk-sqlite
  obelisk server run --server-config server-target.toml

sample-mcp-server:
  node examples/stateless-mcp-server.mjs

build-rs:
  cd workflow/workflow-rs && cargo build --release

verify: build-rs
  obelisk deployment verify --deployment deployment.rs.toml --server-config server.toml --allow-unavailable-runtime-config
  obelisk deployment verify --deployment deployment.js.toml --server-config server.toml --allow-unavailable-runtime-config
  ./scripts/check-deployment-toml-parity.sh

test: test-rs test-js test-e2e

test-rs:
  cargo nextest run -p just-bash-rs -p workflow-agent-rs

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


# Suites run one node:test file per script (in parallel across files); a
# suite's own rs/js pair stays in one file so they run sequentially, since
# both hardcode the same ports (see scripts/e2e/helpers.mjs).
test-e2e:
  node --test scripts/e2e/*.test.mjs
