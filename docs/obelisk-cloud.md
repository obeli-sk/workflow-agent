# ObeliskNet from the session shell (`obelisk cloud`)

The emulated `obelisk` command supports `obelisk cloud ...` like the real CLI
(obelisk's `src/command/cloud.rs` and `cloud/deploy.rs`). An agent can list
apps, create and deploy them, manage env and secrets, and inspect executions
and logs of a hosted app.

## Configuration

- `OBELISK_CLOUD_API_URL` (public env) points at the provisioner. Its default,
  `http://127.0.0.1:9090`, does nothing unless something listens there.
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

Discover any app's webhook with
`obelisk cloud app --app NAME endpoint webhook`, then fetch its route with
`curl`.

`packs/obelisk-control/descriptor.js` adds a "Cloud apps" section to the
system prompt along with the cloud's current apps. If the provisioner rejects the token or can't be reached, the section is
left out and a warning is shown instead.

## Pieces

The `obelisk-agent:tools/cloud` interface has these activities
(`packs/obelisk-control/cloud/`); all but `tenant-read` have `max_retries = 0`:

- `run` (`cli.js`) runs the provisioner commands: `apps list`,
  `token list|get`, `app new|get|status|stage|apply|reactivate|deactivate|delete`,
  `env ...`, `secrets ...` and `endpoint`. It returns stdout, stderr and an
  exit code, and its errors use the real CLI's wording.
- `prepare-deploy` (`deploy.js`) and `finish-deploy` (`finish-deploy.js`)
  run the provisioner part of `app deploy`, in the real CLI's order:
  1. `prepare-deploy` stages the config of an existing app, or creates the
     app. A new app whose policy requires env or secrets needs
     `--fill-non-interactive`, which reads same-named exported shell variables.
  2. The shell submits and enqueues the deployment on the app's API.
  3. `finish-deploy` fills an existing app's values, checks the required env
     and secrets, applies the config with the enqueued deployment's ID and
     requires the app to be running.
- `tenant` (`tenant.js`) sends one POST, PUT or DELETE request to
  `https://api--<app>.<domain>` with the cloud token and returns the status
  and body, whatever the status.
- `tenant-read` (`tenant-read.js`) does the same for GET and is retried on
  transient errors.

In the shell (`vendor/just-bash/src/obelisk-pack.js`), each `obelisk cloud` command goes
to one of three places:

- `cloud app [--app NAME] execution|component|deployment|admin ...` is ported
  from obelisk's `src/command/{execution,component,deployment,admin}.rs`. It
  sends the same requests through `tenant`/`tenant-read`
  (`createCloud` in `workflow-js/src/host.js`) and prints the same output:
  human output on stderr, values and JSON on stdout. Errors print
  `Error: ...` and exit 1; usage errors exit 2.
- `cloud app deploy [-a app.toml] [-d deployment.toml] [--fill-non-interactive]`
  calls `prepare-deploy`, then submits and enqueues the deployment against
  the app. The submit uploads only the files the server asks for and reuses the
  active deployment when nothing changed. Last, it calls `finish-deploy` with
  the deployment ID.
- Everything else goes to `run` with the app policy's text: the `-a` file,
  else `./app.toml`. `--from-env VAR` turns into `--stdin` with the exported
  variable's value, so secret values never appear in argv. With
  `--fill-non-interactive` (or `fill --non-interactive`), the exported
  variables are passed along for the fill.

`--app`, `--json` and `--verbose` are accepted anywhere. The app is `--app`,
else an exported `OBELISK_APP_NAME`, else `app_name` in `./app.toml`.

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
  `--fill`, `fill` without `--non-interactive`, `token new|revoke`,
  `--api-url`, `--api-token` and `--apps-domain`.
- `obelisk server ...` and the top-level app commands do not exist. The agent
  asks the user with the separate `ask-user QUESTION` shell command.

## Pulling deployments

```sh
obelisk cloud apps list
export OBELISK_APP_NAME=example
obelisk cloud app deployment pull "$(obelisk cloud app deployment active)" -o /workspace/example
cd /workspace/example
cat deployment.toml
cat webhook/handle.js
obelisk cloud app deployment apply
```

As in the real CLI, `deployment pull ID [-o DIR] [-f]` writes
`deployment.toml` without the generated `content_digest` and `component_files`,
plus the deployment's source files. It refuses to overwrite an existing file
unless `--force` is given. Source files are registered with their content
digests and are fetched on first read. An unedited file keeps its digest and
is not uploaded again; submit still reads JS modules to find their imports. A remote deployment change does not change the
pulled files. Edits remain local until submitted or applied.
