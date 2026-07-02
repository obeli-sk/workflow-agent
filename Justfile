serve:
  obelisk server run -d deployment.toml

sync:
  obelisk deployment get $(obelisk deployment active) --force
