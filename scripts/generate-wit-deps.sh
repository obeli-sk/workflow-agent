
#!/usr/bin/env bash

set -euo pipefail
cd "$(dirname "$0")/.."

d=workflow/workflow-rs/wit/deps
rm -rf "$d"
mkdir -p "$d"
cp -r wit/deps/obelisk-agent_stub "$d/"
cp -r wit/deps/obelisk-agent_llm "$d/"
cp -r wit/deps/obelisk-agent_tools "$d/"
obelisk generate wit-extensions activity_stub wit/deps/obelisk-agent_stub "$d"
obelisk generate wit-extensions activity wit/deps/obelisk-agent_llm "$d"
cp -r wit/deps/obelisk-agent_workflow "$d/"
obelisk generate wit-support workflow --force "$d"
