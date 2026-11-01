# Obelisk API client

`obelisk-openapi.json` and `vendor/obelisk-api` are imported from the `obelisk`
flake input locked in `flake.lock`, the same revision that provides the Obelisk
binary. `obelisk-api.language` selects the Rust or JavaScript package.
Only server info, app policy and deployment switch are in this first slice.

After `nix flake update obelisk`, run inside `nix develop`:

```sh
scripts/update-obelisk-api.sh
scripts/update-obelisk-api.sh --check
```

The check compares the package and schema with the locked upstream files.
Code generation belongs to Obelisk; do not edit vendored artifacts.
Ordinary builds and unit tests use checked-in code without fetching or generating.
