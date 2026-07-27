serve:
  obelisk server run -d deployment.toml

install:
  pnpm install --frozen-lockfile

build:
  pnpm run build

verify: build
  obelisk server verify --deployment deployment.toml --allow-unavailable-runtime-config

sync:
  obelisk deployment get $(obelisk deployment active) --force
