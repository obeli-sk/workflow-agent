# ObeliskNet from the session shell (`obelisk cloud`)

The emulated `obelisk` command supports `obelisk cloud ...` like the real CLI
(obelisk's `src/command/cloud.rs` and `cloud/deploy.rs`). An agent can list
apps, create and deploy them, manage env and secrets, and inspect executions
and logs of a hosted app.

## Configuration

- `OBELISK_CLOUD_API_URL` (public env) points at the provisioner. Its default,
  `http://127.0.0.1:9090`, does nothing unless something listens there.
- `OBELISK_CLOUD_API_TOKEN` (optional secret) is the account token. When it is
  unset, the system prompt says nothing about `obelisk cloud`.
- `OBELISK_CLOUD_APP_API_PATTERN` (optional public env) is the allowed-host
  pattern for the hosted apps' own APIs. It defaults to
  `https://*.obelisk.works:5005`.

When the token is set, `packs/obelisk-control/descriptor.js` adds an
"ObeliskNet" section to the system prompt along with the account's current
apps. If the provisioner rejects the token or can't be reached, the section is
left out and a warning is shown instead.

## Pieces

The `obelisk-agent:tools/cloud` interface has three activities
(`packs/obelisk-control/cloud/`), each with `max_retries = 0`:

- `run` (`cli.js`) runs the provisioner commands: `apps list`,
  `token list|get`, `app new|get|status|stage|apply|start|stop|delete`,
  `env ...`, `secrets ...` and `endpoint`. It returns stdout, stderr and an
  exit code, and its errors use the real CLI's wording.
- `prepare-deploy` (`deploy.js`) runs the provisioner part of `app deploy`:
  1. It creates the app, or restages it when the stored policy or cloud config
     differs.
  2. It checks the required env and secrets.
  3. It applies the config and starts the app when needed.
  4. It returns the app's API origin and webhook URL.
- `tenant` (`tenant.js`) runs one webapi tool (`packs/obelisk-control/tools/*.js`)
  against an app's API, authenticated with the cloud token. The tools read
  their target from `tools/target.js`, which `tenant` points at the app.

In the shell (`vendor/just-bash/src/obelisk-pack.js`, ported to
`vendor/just-bash-rs/src/obelisk_pack.rs`), each `obelisk cloud` command goes
to one of three places:

- `cloud app [--app NAME] functions|executions|call|deployment ...` reuses the
  local command implementations with a control plane routed through `tenant`
  (`createCloud` in `workflow-js/src/host.js` and `CloudHost` in
  `workflow-rs/src/host.rs`). This way the output, flags and lazy deployment
  mounts stay identical to those commands.
- `cloud app deploy [-a app.toml] [-d deployment.toml]` calls `prepare-deploy`
  and then `deployment apply` against the app. It uploads the files the server
  asks for, just like the local apply.
- Everything else goes to `run` with the app policy's text: the `-a` file,
  else `./app.toml`. `--from-env VAR` turns into `--stdin` with the shell
  variable's value, so secret values never appear in argv.

## Differences from the real CLI

- Interactive or account-level operations are rejected with a hint:
  `--fill` and `app fill`, `token new|revoke`, `--api-url` and `--api-token`.
- `cloud app deployment refresh` is rejected, because it would remount the
  local target.

## Proposal: the target as a single-app cloud

Status: design, not implemented.

The original single target (`TARGET_OBELISK_*`) predates `obelisk cloud`. Now
that hosted apps are the real targets, the session should see one model: it
controls apps in the cloud. A plain Obelisk server becomes a cloud provider
with exactly one app that cannot be provisioned, deleted or reconfigured.

### Provider selection

- `OBELISK_CLOUD_API_TOKEN` set: ObeliskNet, as today.
- Else `TARGET_OBELISK_API_URL` set: the single-app provider. The app name is
  the target's `app_name` (from `/v1/info` or the active deployment's
  `app.toml`).
- Else: no cloud section and no `obelisk cloud`.

### Single-app behavior

- `apps list` prints one row; `app get|status` and `endpoint` are answered
  from the `TARGET_OBELISK_*` URLs and the server's health.
- `app new|delete|start|stop|stage|apply`, `env ...` and `secrets ...` fail with
  "this cloud has a single fixed app; ask the user to change it".
- `app deploy` skips `prepare-deploy`: it checks the deployment against the
  target's own policy and runs `deployment apply`. It never widens the policy.
- `app functions|executions|call|deployment` go to the target through the same
  control plane the tenant routing uses, so output and flags do not change.
- `--app` other than the single app's name is an error listing the one app.

### Shell

- The top-level `obelisk functions|executions|call|deployment` are removed;
  `obelisk execution list` reads as if it acted on the server the agent runs
  on. Only `obelisk cloud app ...`, `obelisk cloud ...` and `obelisk generate`
  remain, mirroring the real CLI.
- `--app` may be omitted when exactly one app exists (always for the
  single-app provider), in addition to the `./app.toml` lookup.

### Deployment mounts

- Each app gets its own lazy mount at `/workspace/cloud/<app>/deployment`,
  with `current` linked to the active deployment. It is mounted on first use
  of `cloud app --app NAME deployment ...`, through activities, so replay stays
  deterministic.
- `cloud app deployment refresh` remounts that app's tree instead of being
  rejected. `/workspace/deployment` goes away.

### System prompt

- The planner intro says the agent manages apps in the cloud through
  `obelisk cloud`, and that none of them is the instance it runs on.
- One cloud section for both providers: the provider, the apps (one for the
  single-app provider), what is not allowed (provisioning on the single-app
  provider) and where each app's deployment is mounted.
- The `generate new` help and the session-logic mount listing point at the
  per-app mount instead of `/workspace/deployment/current`.

### Tests

- The e2e suites that use the local target keep working through the
  single-app provider, rewritten to `obelisk cloud app ...`.
- JS and Rust shell tests cover: single-app refusals, `--app` defaulting,
  per-app mounts and `refresh`.
