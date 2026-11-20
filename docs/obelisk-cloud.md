# ObeliskNet from the session shell (`obelisk cloud`)

The emulated `obelisk` command supports `obelisk cloud ...` like the real CLI
(obelisk's `src/command/cloud.rs` and `cloud/push.rs`). An agent can list
apps, create and push them, manage env and secrets, and inspect executions
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
when `external` is in `public_http_servers`. `app push` prints them as well.
Fetch a webhook route with `curl`.

`packs/obelisk-control/descriptor.js` adds a "Cloud apps" section to the
system prompt along with the cloud's current apps. If the provisioner rejects the token or can't be reached, the section is
left out and a warning is shown instead.

## Pieces

The shell implements `stage` and `push` as workflow orchestration over separate
`obelisk-agent:tools/cloud` activities. Each completed activity is recorded, so a
retry resumes the failed request without repeating earlier successful requests.

- `create` sends app creation with a workflow-generated command ID and captured
  JSON body. Transport failures and HTTP 5xx retry the same command.
- `draft-open` sends one `PUT` with the workflow's draft label and captured
  applied revision as `{parent_revision}`. It opens the draft, or returns it
  unchanged when it already exists on that parent, so a retry after a lost
  response recovers it; another parent gives 412 rather than silently rebasing.
  Stage first reads `default` (or `--draft`) and keeps an existing draft's parent
  and ID, opening one only when missing; push generates a unique
  `push-<ulid>` label and opens it directly.
- `draft-request` sends one GET, PUT or DELETE on the captured draft. Every call
  carries `If-Match: "draft-<id>"`. Config, each public value, the deployment ID
  and cleanup are separate retryable activities. Edits never implicitly create
  a draft. The ID stays fixed even if another caller discards and recreates its
  label; the replacement produces 412. Conditional discard also pins the ID,
  and repeating it while the draft is absent succeeds without deleting a replacement.
- `upload` sends one content-addressed file PUT or fixed-ID deployment PUT.
  Each file the server requests is a separate activity. Missing-file responses
  return to the workflow upload loop; transport failures and HTTP 5xx retry the
  same digest or deployment ID and body.
- `command` sends one lifecycle request with the workflow's command ID and body.
  Draft apply also carries the captured draft's `If-Match`. The provisioner
  joins an accepted command or returns its recorded result, even when apply has
  consumed the draft or restarted the calling app.
- `read` and `tenant-read` make provisioner and app API reads. `tenant` sends
  other app API mutations once; execution controls and admin operations do not
  gain upload retries.
- `run` handles `auth status`, app inspection, `env ...`, `secrets list|unset`
  and `unstage`. It keeps `max_retries = 0` and returns shell output and an exit
  code. Draft mutations resolve an ID and send `If-Match` before editing or
  discarding; a missing draft can be opened explicitly before an env edit.

No secret value passes through the shell. There is no `secrets set` or `--secret`.
`--fill-non-interactive` fills only declared public env; bare `--env NAME` reads
only the named exported variable. Required secrets must be set by the user from
their CLI or dashboard before deployment can proceed.

## Stage and push

`cloud app stage [-a app.toml] [-d deployment.toml|Dep_ID | --empty-deployment]
[--description TEXT] [--env NAME[=VALUE]]... [--fill-non-interactive] [--draft KEY]`
creates a missing app bare, submits an optional deployment first, then opens or
reuses the named draft and stages config, values and the submitted deployment ID.
An existing `Dep_` ID is staged without a submission, and without app.toml the
draft keeps its config. A failed upload leaves the draft untouched. Stage permits
missing values so the user can fill them later, and never applies. Without `-d`
or `--empty-deployment`, the draft keeps its already-staged deployment, matching
the Obelisk CLI.

`cloud app push [-a app.toml] [-d deployment.toml | --empty-deployment]
[--env NAME[=VALUE]]... [--fill-non-interactive]` generates its unique draft label
in the workflow, captures the applied revision, opens the draft, stages config
and values, and checks required values before uploading. It then uploads, stages
the deployment ID, and applies through `command`. Cleanup happens only after a
request exhausts its retries or a permanent preparation error occurs, and uses
the captured draft ID. Failed applies leave their draft for inspection.

The provisioner allocates `draft_id` with SQLite `AUTOINCREMENT`. Unstage deletes
the row; reopening the same label gets a new, never-reused ID. `If-Match` pins
identity, not the edit version, so shared edits of the same stage draft remain
possible. Parent revision checks and apply's atomic draft capture protect against
applying staging based on a superseded configuration.

These flows require the provisioner version supporting draft identity
preconditions, reusable draft creation and its explicit parent revision.

## Other commands

`cloud app new [--command-id ID]` captures its initial public values in the
workflow and uses `create`. With an explicit ID, it first reads
`GET /v1/commands/ID`, recovering a result before rebuilding inputs from files
or environment that might have changed.

`cloud app apply|enable|disable|delete [--command-id ID]` builds its request in
the workflow and uses `command`. Apply reads the selected draft (default
`default`) and pins its ID, or uses the applied revision with `--reapply`.
An explicit command ID first reads the accepted command's result. Exhausted
transport retries report a recovery command with the original ID.

`cloud app execution|component|deployment|admin ... [--app NAME]` uses the app
API through `tenant-read`, `upload` or `tenant`. Deployment has no enqueue or
apply: `cloud app stage -d` then `cloud app apply`, or `cloud app push`, activate one.
Pull writes app.toml, deployment.toml and lazily fetched deployment files.

`--json` and `--verbose` are accepted anywhere. `--app` follows the app subcommand
and is rejected by `app list`. Selection uses `--app`, then exported
`OBELISK_APP_NAME`, then `app_name` in ./app.toml. An explicit or required config
must name the selected app; a mismatching optional discovered config is ignored.

## Retry audit (2026-11-16)

Stage and deploy no longer run as compound activities. Draft opening, each edit,
each upload and apply have independent retries with captured inputs and identity.
The draft protocol does not cache original edit responses: a repeated PUT can
return `changed:false` after the original returned `changed:true`, while restoring
the same desired contents in the same draft. A replaced draft fails the identity
precondition. Command ID deduplication remains responsible for creation and apply.

The remaining `run` inspection commands are safe to repeat as fresh reads, but
still convert failures into shell exit codes. `auth status` reports failed token
lookups as unknown, and `app status` reports config-comparison failures in its
output. A future extraction can give those reads automatic activity retries.
Other app API mutations retain `max_retries = 0`.

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
obelisk cloud app push
```

As in the real CLI, `app pull [-o DIR] [-f]` writes the app's verbatim
`app.toml` and pulls its active deployment. `deployment pull [ID] [-o DIR] [-f]`
writes only `deployment.toml` without the generated `content_digest` and `component_files`,
plus the deployment's source files. It refuses to overwrite an existing file
unless `--force` is given. Source files are registered with their content
digests and are fetched on first read. An unedited file keeps its digest and
is not uploaded again; submit still reads JS modules to find their imports. A remote deployment change does not change the
pulled files. Edits remain local until submitted or applied.
