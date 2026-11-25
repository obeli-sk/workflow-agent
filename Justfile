set positional-arguments

serve:
  OBELISK__LIMITS__MAX_PERSISTED_VALUE_SIZE__MIB="${OBELISK__LIMITS__MAX_PERSISTED_VALUE_SIZE__MIB:-2}" \
    obelisk server run --dev -d deployment.toml --app-config app.toml

verify:
  obelisk server verify --dev --skip-db --deployment deployment.toml --app-config app.toml --allow-unavailable-runtime-config

test: test-js test-e2e

test-js:
  node --test src/webhook/ui/shell.test.js
  node --test src/webhook/lib/watch.test.js
  node --test src/activity/curl.test.js
  node --test src/activity/browser.test.js
  node --test src/activity/chat.test.js
  node --test src/activity/github-contents.test.js
  node --test src/activity/config-discover.test.js
  node --test src/activity/input-accepted-at.test.js
  node --test src/activity/llm-history.test.js
  node --test src/packs/obelisk-control/cloud/cloud.test.mjs
  node --test src/shared/session-state.test.js
  node --test src/shared/model-catalog.test.js
  node --test $(find src/vendor/just-bash/src -name '*.test.js')
  node --test $(find src/workflow -name '*.test.js')

# Every suite runs concurrently, each on its own port range.
test-e2e:
  node --test test/e2e/*.test.mjs
