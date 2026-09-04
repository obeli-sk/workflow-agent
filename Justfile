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
  cargo test -p just-bash-rs -p workflow-agent-rs

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
  ./scripts/test-e2e-deploy-outside-root.sh rs
  ./scripts/test-e2e-deploy-outside-root.sh js
  ./scripts/test-e2e-github-mount-deploy.sh rs
  ./scripts/test-e2e-github-mount-deploy.sh js
