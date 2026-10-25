# Obelisk API client

`obelisk-openapi.json` and `vendor/obelisk-api` are imported from the immutable
Obelisk revision in `obelisk-openapi.rev`. `obelisk-api.language` selects the
Rust or JavaScript package. The API pin is independent of the runtime pin.
Only server info, app policy and deployment switch are in this first slice.

Edit `obelisk-openapi.rev`, then run inside `nix develop`:

```sh
scripts/update-obelisk-api.sh
scripts/update-obelisk-api.sh --check
```

For a matching clean local Obelisk checkout, append its path to either command.
The check compares the package, schema and importer with the pinned upstream
files. Code generation belongs to Obelisk; do not edit vendored artifacts.
Ordinary builds and unit tests use checked-in code without fetching or generating.
