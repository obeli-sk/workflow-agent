# ObeliskNet from the session shell (`obelisk cloud`)

The emulated `obelisk` command supports `obelisk cloud ...` like the real CLI
(obelisk's `src/command/cloud.rs` and `cloud/deploy.rs`). An agent can list
apps, create and deploy them, manage env and secrets, and inspect executions
and logs of a hosted app.

## Configuration

- `OBELISK_CLOUD_API_URL` (public env) points at the provisioner. Its default,
  `http://127.0.0.1:9090`, does nothing unless something listens there.
- `OBELISK_CLOUD_API_TOKEN` (optional secret) is the account token. When it is
  unset, the cloud is the single-app cloud described below.
- `OBELISK_CLOUD_APPS_DOMAIN` (optional public env) is the hosted apps' domain,
  the same variable the real CLI reads for `--apps-domain`. It defaults to
  `obelisk.works`. The app policy and both deployment manifests derive the
  allowed-host pattern `https://*.<domain>` from it, covering the hosted apps'
  own APIs and the shell's GET-only `curl` access to hosted webhook URLs.

Public app endpoints use HTTPS port 443: `https://api--<app>.<domain>` for the
API and `https://<app>.<domain>` for webhooks. The default pattern
`https://*.obelisk.works` covers both the production and `dev.obelisk.works`
domains. Apply the app configuration and redeploy after changing the domain.

Discover any app's webhook with
`obelisk cloud app --app NAME endpoint webhook`, then fetch its route with
`curl`. The fixed target's endpoint is configured by
`TARGET_OBELISK_WEBHOOK_URL`, defaulting to `http://127.0.0.1:9290`.
The shell uses the same endpoint command for every app.

`packs/obelisk-control/descriptor.js` adds a "Cloud apps" section to the
system prompt along with the cloud's current apps. If the provisioner rejects the token or can't be reached, the section is
left out and a warning is shown instead.

## Pieces

The `obelisk-agent:tools/cloud` interface has three activities
(`packs/obelisk-control/cloud/`), each with `max_retries = 0`:

- `run` (`cli.js`) runs the provisioner commands: `apps list`,
  `token list|get`, `app new|get|status|stage|apply|reactivate|deactivate|delete`,
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
  `workflow-rs/src/host.rs`). This way the output and flags stay identical to
  the real CLI's app commands.
- `cloud app deploy [-a app.toml] [-d deployment.toml]` calls `prepare-deploy`
  and then `deployment apply` against the app. It uploads the files the server
  asks for, just like the local apply.
- Everything else goes to `run` with the app policy's text: the `-a` file,
  else `./app.toml`. `--from-env VAR` turns into `--stdin` with the shell
  variable's value, so secret values never appear in argv.

## Differences from the real CLI

- `deployment pull DIRECTORY` is a shell convenience backed by lazy virtual files.
- Interactive or account-level operations are rejected with a hint:
  `--fill` and `app fill`, `token new|revoke`, `--api-url` and `--api-token`.
- `--app` may be left out when exactly one app exists, in addition to the
  `./app.toml` lookup. The order is `--app`, the `-a` file's or `./app.toml`'s
  `app_name`, then the cloud's only app.
- `obelisk call obelisk-agent:stub/stub.ask-user '["question"]'` stays at the
  top level: it asks the user, not an app. The other top-level app commands
  (`functions`, `executions`, `call`, `deployment`) are gone; they print a hint
  pointing at `obelisk cloud app ...`.

## Pulling deployments

```sh
obelisk cloud apps list
obelisk cloud app --app example deployment pull /workspace/example
cd /workspace/example
cat deployment.toml
cat webhook/handle.js
obelisk cloud app deployment apply deployment.toml
```

`deployment pull DIRECTORY` resolves the active deployment ID and fetches its
manifest, app policy and file index. It writes `deployment.toml` and, when
available, `app.toml` directly into the destination. Source files are registered
with their content digests and load on first read. A remote deployment change
does not change the pulled files. Edits remain local until submitted or applied;
submission requests a fresh server-assigned deployment ID.

The destination must be absent or an empty directory. To inspect a newer
deployment, pull into another directory. Pull errors are reported by the
command without creating a hidden error file. No automatic cloud deployment
mount or `deployment refresh` command remains. `mount` lists reference
repositories and MCP resources, without app endpoint URLs.

## The single-app cloud

Without `OBELISK_CLOUD_API_TOKEN` and with `TARGET_OBELISK_API_URL` set
(`packs/obelisk-control/cloud/single-app.js`), the `TARGET_OBELISK_*` server is
a cloud holding one app that cannot be provisioned. Its name is the
`app_name` reported by the target's `/v1/info`, or `target` when it reports
none.

This adapter is an implementation detail. The LLM receives the same cloud
instructions for every backend; restrictions are reported as command permission
errors. Deployment pull, lazy file loading, submission and endpoint discovery
use the same commands.

- `apps list`, `app get|status` and `app endpoint` are answered from the
  `TARGET_OBELISK_*` URLs and whether `/v1/info` answers.
- `app new|delete|reactivate|deactivate|stage|apply`, `env ...`, `secrets ...` and
  `token ...` are refused, asking the user to change the app.
- `app deploy` skips provisioning: it checks the app is running and then runs
  `deployment apply`. The target's own policy still applies, so a deployment
  cannot widen it.
- `--app` other than the single app's name is an error naming the one app.
