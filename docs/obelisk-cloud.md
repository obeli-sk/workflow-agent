# ObeliskNet from the session shell (`obelisk cloud`)

The emulated `obelisk` command supports `obelisk cloud ...` like the real CLI
(obelisk's `src/command/cloud.rs` and `cloud/deploy.rs`). An agent can list
apps, create and deploy them, manage env and secrets, and inspect executions
and logs of a hosted app.

## Configuration

- `OBELISK_CLOUD_API_URL` (public env) points at the provisioner API. Its default,
  `http://127.0.0.1:9090/api`, does nothing unless something listens there.
  ObeliskNet serves it under `/api` on the cloud host, e.g.
  `https://cloud.obeli.sk/api`.
- `OBELISK_CLOUD_API_TOKEN` (optional secret) is the account token. When it is
  unset, `obelisk cloud` is left out of the system prompt.
- `OBELISK_CLOUD_APPS_DOMAIN` (optional public env) is the hosted apps' domain,
  the same variable the real CLI reads for `--apps-domain`. It defaults to
  `obelisk.works`. The app policy and both deployment manifests derive the
  allowed-host pattern `https://*.<domain>` from it, covering the hosted apps'
  own APIs and the shell's GET-only `curl` access to hosted webhook URLs.

Public app endpoints use HTTPS port 443: `https://api--<app>.<domain>` for the
API and `https://<app>.<domain>` for webhooks. The default pattern
`https://*.obelisk.works` covers both the production and `dev.obelisk.works`
domains. Apply the app configuration and redeploy after changing the domain.

`obelisk cloud app status --app NAME` lists the URLs the app's applied
configuration serves: API, Web UI, internal webhooks, and external webhooks
when `external` is in `public_http_servers`. `app deploy` prints them as well.
Fetch a webhook route with `curl`.

`packs/obelisk-control/descriptor.js` adds a "Cloud apps" section to the
system prompt along with the cloud's current apps. If the provisioner rejects the token or can't be reached, the section is
left out and a warning is shown instead.

## Pieces

The `obelisk-agent:tools/cloud` interface has these activities
(`packs/obelisk-control/cloud/`). `create`, `upload`, `read`, `tenant-read`, `command` and
`finish-deploy` are retried; the rest have `max_retries = 0`:

- `run` (`cli.js`) runs the provisioner commands: `auth status`, `app list`,
  `app status|events|stage|unstage`, `env ...` and `secrets list|unset`.
  No secret value passes through the agent: there is no `secrets set` and no
  `--secret`, `--fill-non-interactive` fills only env, and `new` (or `deploy`)
  of an app lacking a required secret fails with guidance to `stage` it and let
  the user set the secrets from their own CLI or the dashboard. Edits
  go into a named draft (`--draft`, default `default`) through
  `/v1/apps/<app>/drafts/<key>/...` with `create_or_reuse=true`. With `-d ID`, `stage` records an
  already submitted deployment in the draft. It returns
  stdout, stderr and an exit code, and its errors use the real CLI's wording.
- `create` (`create.js`) sends one `POST /v1/apps` with an immutable JSON body
  and Idempotency-Key chosen in the workflow. Transport failures, body-read
  failures and HTTP 5xx throw so Obelisk retries the same request; other HTTP
  responses return to the shell for formatting. The provisioner validates the
  request fingerprint, joins accepted creation, and returns its recorded result.
  All app creation, including bare apps needed by stage and deploy, uses this activity.
- `read` (`read.js`) sends one GET to the provisioner and returns the status
  and body. `command` (`command.js`) sends one `app apply|enable|disable|delete`
  request with the body and Idempotency-Key the shell chose, so a retry joins
  the command or gets its recorded result. Both return every response below
  500; only a failed request or a server error is an error and gets retried.
- `prepare-deploy` (`deploy.js`) and `finish-deploy` (`finish-deploy.js`)
  run the provisioner part of `app deploy`, in the real CLI's order:
  1. `prepare-deploy` exclusively creates the deploy's draft of an existing
     app and stages the config, `--env` values and, with
     `--fill-non-interactive`, the remaining declared env into it, then
     checks that it has every required value. On failure it discards the
     draft. The shell first checks whether the app exists, validates required
     values before creating a missing app, and creates it bare through `create`.
     Its configuration and values are then staged in the deploy draft.
  2. The shell uploads the deployment to the app's API, without enqueueing or switching it.
  3. `finish-deploy` applies the draft (or re-applies the revision of a new
     app) with the uploaded deployment's ID and requires the app to be running.
     A draft left by a failed apply is discarded by the next successful one.
     The shell passes the
     apply's Idempotency-Key, so `finish-deploy` is retried: deploying the app
     the shell runs in interrupts it, and the retry gets the apply's result.
- `upload` (`upload.js`) sends one PUT to `/v1/files/{digest}` or
  `/v1/deployments/{id}` on the app API. Each file the server requests is a
  separate activity; manifest submissions and resubmissions are separate
  activities too. The workflow captures the digest or deployment ID and body
  before invoking the activity, so a transport failure or HTTP 5xx retries the
  same upload. File contents are addressed by digest and the server accepts
  the same deployment content under the same ID. Other responses, including
  409 missing-file reports, return to the workflow to drive the upload loop.
- `tenant` (`tenant.js`) sends other POST, PUT or DELETE requests to
  `https://api--<app>.<domain>` with the cloud token and returns the status
  and body, whatever the status. It sends no `If-Match`, so a deployment
  switch gets `428`; deployments are activated by the provisioner's apply.
- `tenant-read` (`tenant-read.js`) does the same for GET and is retried on
  transient errors.

In the shell (`vendor/just-bash/src/obelisk-pack.js`), `obelisk cloud` commands
are handled as follows:

- `cloud app execution|component|deployment|admin ... [--app NAME]` is ported
  from obelisk's `src/command/{execution,component,deployment,admin}.rs`. It
  sends the same requests through `tenant`/`tenant-read`
  (`createCloud` in `workflow-js/src/host.js`) and prints the same output:
  human output on stderr, values and JSON on stdout. Errors print
  `Error: ...` and exit 1; usage errors exit 2.
- `cloud app deploy [-a app.toml] [-d deployment.toml | --empty-deployment] [--env NAME[=VALUE]]...
  [--fill-non-interactive]` creates a missing app through `create`, then calls `prepare-deploy` with a
  generated `deploy-<ulid>` draft, then uploads the deployment against
  the app; a failed upload discards the draft through `run`'s `unstage`. The submit uploads only the files the server asks for and reuses the
  active deployment when nothing changed. Last, it calls `finish-deploy` with
  the deployment ID.
- `cloud app stage [-a app.toml] [-d deployment.toml | --empty-deployment]
  [--description TEXT] [--env ...] [--draft KEY]` is ported from
  obelisk's `src/command/cloud/stage.rs`. The shell creates a missing app bare
  through `create`. With a deployment, it submits the deployment to the app's
  API, then calls `run` once to stage the config, values and deployment ID.
  Without a deployment, `run` stages only config and values. It never applies.
- `cloud app new [--command-id ID]` validates its policy and initial public
  values in the workflow, then calls `create` with the captured JSON body and
  a generated command ID. With an explicit ID it first reads
  `GET /v1/commands/ID`, recovering an accepted result before rebuilding inputs
  from files or environment that might have changed. Exhausted transport
  retries report that recovery command, including for implicit bare creation.
- `cloud app deployment enqueue` and `cloud app deployment apply` are rejected
  before any API request, with guidance to use `cloud app deploy` or `cloud app apply`.
  Deploy uploads local deployment.toml changes and applies that deployment's ID.
  Apply uses the currently active deployment with staged configuration and does
  not upload local deployment.toml changes.
- `cloud app apply|enable|disable|delete [--command-id ID]` is ported from
  obelisk's `src/command/cloud.rs`, in the shell. It generates the command ID
  unless `--command-id` is given, in which case it first asks
  `GET /v1/commands/ID` and reports a command the provisioner already accepted.
  `apply` then reads the app row and the draft through `read` and the active
  deployment through `tenant-read` unless the draft has a staged deployment, and builds the request: the draft
  (`--draft`, default `default`) or, with `--reapply`, the applied revision.
  Last, `command` sends it. When its retries run out, the error names the
  command ID to retry with.
- Everything else goes to `run` with the app policy's text: the `-a` file,
  else `./app.toml`. A bare
  `--env NAME` reads the exported variable, so only those
  variables are passed along; with `--fill-non-interactive`, also the
  exported variables that app.toml declares under `[public_env]`. No other
  variable, so no secret value, leaves the shell.

`--json` and `--verbose` are accepted anywhere; `--app` only after the `cloud app`
subcommand, and not by `app list`. The app is `--app`, else an exported `OBELISK_APP_NAME`, else `app_name` in `./app.toml`. As in the
real CLI, an app config naming a different app is an error when passed with `-a`
or required (`stage`, `deploy`), and a discovered `./app.toml` is ignored by the
other commands.

## Retry audit (2026-11-16)

`cloud.run` keeps `max_retries = 0`. Its remaining operations have different
recovery properties; passing a command ID to the whole activity would not make
them collectively safe. The draft webhook does not read `Idempotency-Key`, and
its OpenAPI operations are marked as non-command endpoints.

| Operations | Requests | Retry assessment |
|---|---|---|
| `auth status`, `app list`, `app events`, `app env list`, `app secrets list` | GET | Safe to repeat as fresh reads. A future extraction can use retryable read activities; today `run` converts failures to exit codes, and `auth status` reports token lookup failures as unknown. |
| `app status` | GET status/drafts, POST config comparison | Read-only, including comparison. Safe as fresh reads; a comparison failure is intentionally shown in the status output. Responses can reflect newer state rather than an earlier snapshot. |
| `app stage` | PUT config, zero or more PUT env, optional PUT deployment | Multiple commits can partially succeed. No durable aggregate result, revision precondition or draft identity binds a retry. Keep automatic retries disabled. |
| `app env set/unset`, `app secrets unset` | PUT/DELETE draft values with `create_or_reuse=true` | Repeating against an unchanged draft can restore the same desired value, but can overwrite another edit or recreate a draft after apply/discard. No original response can be recovered by command ID. Keep retries disabled. |
| `app unstage` | DELETE draft by label | A second call changes `discarded:true` to `false`, or deletes a replacement draft opened under the same label. Keep retries disabled. |

`prepare-deploy` also stays non-retryable: its exclusive draft POST returns 409
if the first response was lost, and later failure cleanup can discard a partially
staged draft. App creation has been removed from it. Safely retrying draft
mutations needs provisioner support for a stable draft identity and revision
preconditions, or durable per-request outcomes. HTTP method alone is insufficient.

`app new` and lifecycle requests already have the required durable command
protocol. File uploads and deployment submissions are retryable through `upload`:
their digest or deployment ID and request body are workflow inputs and stay fixed
across retries. Other app API mutations through `tenant` remain outside this audit
and retain `max_retries = 0`.

## Differences from the real CLI

- `execution status|result --follow` reads the server's event stream in one
  request that ends when the execution finishes, so the statuses print all at
  once at the end. `execution logs --follow` polls once a second, like the real
  CLI, but its output also appears only when the command ends. `--no-reconnect`
  is accepted and has no effect.
- `component push|add` (they need an OCI registry) and `deployment verify` (it
  compiles components locally) are rejected with a hint.
- A deployment rejected for missing runtime configuration reports the server's
  findings without the real CLI's suggested app.toml snippet.
- Interactive or account-level operations are rejected with a hint:
  `--fill`, `--api-url`, `--api-token` and `--apps-domain`.
- `obelisk server ...` and the top-level app commands do not exist. The agent
  asks the user with the separate `ask-user QUESTION` shell command.

## Pulling deployments

```sh
obelisk cloud app list
export OBELISK_APP_NAME=example
obelisk cloud app pull -o /workspace/example
cd /workspace/example
cat deployment.toml
cat webhook/handle.js
obelisk cloud app deploy
```

As in the real CLI, `app pull [-o DIR] [-f]` writes the app's verbatim
`app.toml` and pulls its active deployment. `deployment pull [ID] [-o DIR] [-f]`
writes only `deployment.toml` without the generated `content_digest` and `component_files`,
plus the deployment's source files. It refuses to overwrite an existing file
unless `--force` is given. Source files are registered with their content
digests and are fetched on first read. An unedited file keeps its digest and
is not uploaded again; submit still reads JS modules to find their imports. A remote deployment change does not change the
pulled files. Edits remain local until submitted or applied.
