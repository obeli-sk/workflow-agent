#!/usr/bin/env bash
# Vendors the Obelisk API client from the `obelisk` flake input, so one pin covers the runtime and the API.
set -euo pipefail
cd "$(dirname "$0")/.."
mode=update
if [[ "${1:-}" == --check ]]; then
    mode=check
    shift
fi
if [[ $# -gt 0 ]]; then
    echo "Usage: $0 [--check]" >&2
    exit 2
fi
kind=$(cat assets/schemas/obelisk-api.language)
case "$kind" in
    rust) artifact=crates/api-types ;;
    javascript) artifact=clients/javascript ;;
    *) echo "Unknown API client language: $kind" >&2; exit 2 ;;
esac
source=$(nix eval --raw --impure --expr \
    '(builtins.fetchTree (builtins.fromJSON (builtins.readFile ./flake.lock)).nodes.obelisk.locked).outPath')
if [[ "$mode" == check ]]; then
    diff -ru "$source/$artifact" vendor/obelisk-api
    diff -u "$source/assets/openapi/lifecycle.json" assets/schemas/obelisk-openapi.json
else
    mkdir -p vendor assets/schemas
    rm -rf vendor/obelisk-api
    cp -R "$source/$artifact" vendor/obelisk-api
    chmod -R u+w vendor/obelisk-api
    cp "$source/assets/openapi/lifecycle.json" assets/schemas/obelisk-openapi.json
    chmod u+w assets/schemas/obelisk-openapi.json
fi
