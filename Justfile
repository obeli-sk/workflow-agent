set positional-arguments

serve:
  obelisk server run -d deployment.toml --server-config server.toml --app-config app.toml

clean-target:
  rm -rf sqlite-target/

serve-target *args:
  #!/usr/bin/env bash
  export OBELISK_API_TOKEN=${TARGET_OBELISK_TOKEN}
  obelisk server run --server-config server-target.toml --app-config app-target.toml "$@"

verify:
  obelisk server verify --skip-db --deployment deployment.toml --server-config server.toml --app-config app.toml --allow-unavailable-runtime-config

test: test-js test-e2e

test-js:
  node --test webhook/ui/shell.test.js
  node --test activity/curl.test.js
  node --test activity/chat.test.js
  node --test activity/github-contents.test.js
  node --test activity/config-discover.test.js
  node --test activity/input-accepted-at.test.js
  node --test activity/llm-history.test.js
  node --test packs/obelisk-control/tools/call-target.test.mjs
  node --test packs/obelisk-control/cloud/cloud.test.mjs
  node --test shared/session-state.test.js
  node --test shared/model-catalog.test.js
  node --test $(find vendor/just-bash/src -name '*.test.js')
  node --test $(find workflow/workflow-js/src -name '*.test.js')

# Every suite runs concurrently, each on its own port range.
test-e2e:
  node --test scripts/e2e/*.test.mjs
