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
(`packs/obelisk-control/cloud/`); all but `tenant-read` have `max_retries = 0`:

- `run` (`cli.js`) runs the provisioner commands: `auth status`, `app list`,
  `app new|status|events|stage|unstage|apply|enable|disable|delete`,
  `env ...` and `secrets ...`. Edits go into a named draft
  (`--draft`, default `default`) through `/v1/apps/<app>/drafts/<key>/...`
  with `create_or_reuse=true`, and `apply` applies only what is staged in it;
  `apply --reapply` re-applies the applied revision. It returns stdout, stderr and an
  exit code, and its errors use the real CLI's wording.
- `prepare-deploy` (`deploy.js`) and `finish-deploy` (`finish-deploy.js`)
  run the provisioner part of `app deploy`, in the real CLI's order:
  1. `prepare-deploy` exclusively creates the deploy's draft of an existing
     app and stages the config, `--env`/`--secret` values and, with
     `--fill-non-interactive`, the remaining declared values into it, then
     checks that it has every required value. On failure it discards the
     draft. A new app is created with those values instead.
  2. The shell uploads the deployment to the app's API, without enqueueing or switching it.
  3. `finish-deploy` applies the draft (or re-applies the revision of a new
     app) with the uploaded deployment's ID and requires the app to be running.
     A draft left by a failed apply is discarded by the next successful one.
     The shell passes the
     apply's Idempotency-Key, so `finish-deploy` is retried: deploying the app
     the shell runs in interrupts it, and the retry gets the apply's result.
- `tenant` (`tenant.js`) sends one POST, PUT or DELETE request to
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
- `cloud app deploy [-a app.toml] [-d deployment.toml] [--env NAME[=VALUE]]...
  [--secret NAME]... [--fill-non-interactive]` calls `prepare-deploy` with a
  generated `deploy-<ulid>` draft, then uploads the deployment against
  the app; a failed upload discards the draft through `run`'s `unstage`. The submit uploads only the files the server asks for and reuses the
  active deployment when nothing changed. Last, it calls `finish-deploy` with
  the deployment ID.
- `cloud app deployment enqueue` and `cloud app deployment apply` are rejected
  before any API request, with guidance to use `cloud app deploy` or `cloud app apply`.
  Deploy uploads local deployment.toml changes and applies that deployment's ID.
  Apply uses the currently active deployment with staged configuration and does
  not upload local deployment.toml changes.
- Everything else goes to `run` with the app policy's text: the `-a` file,
  else `./app.toml`. `--from-env VAR` turns into `--stdin` with the exported
  variable's value, so secret values never appear in argv. A bare
  `--env NAME` and `--secret NAME` read the exported variable, so only those
  variables are passed along; with `--fill-non-interactive`, all exported
  variables are passed for the fill.

`--json` and `--verbose` are accepted anywhere; `--app` only after the `cloud app`
subcommand, and not by `app list`. The app is `--app`, else an exported `OBELISK_APP_NAME`, else `app_name` in `./app.toml`. As in the
real CLI, an app config naming a different app is an error when passed with `-a`
or required (`stage`, `deploy`), and a discovered `./app.toml` is ignored by the
other commands.

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
