import { serverInfo } from "../../../shared/obelisk-api-fixtures.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "./fs.js";
import { Interpreter, OutputLog } from "./interpreter.js";
import { Bash } from "./bash.js";
import { sha256Hex } from "./commands/hash.js";
import { utf8Encode } from "./utf8.js";
import { executeObelisk, commandHandler, manifestWithDigests, manifestWithGeneratedFiles } from "./obelisk-pack.js";
import { appConfig } from "../../../packs/obelisk-control/cloud/policy.js";

function sha256(text) {
    return `sha256:${sha256Hex(utf8Encode(text))}`;
}

function words(s) {
    return s.split(" ").filter((w) => w !== "");
}

// `env` entries are exported, like a process environment.
function interp(cwd = "/workspace", env = {}) {
    return new Interpreter({
        vfs: new Vfs(),
        cwd,
        env,
        now: () => 0,
        sleep: () => {},
        customCommands: new Map(),
        dispatchBuiltin: () => ({ stdout: "", stderr: "command not found\n", exitCode: 127 }),
        commandNames: [],
        log: new OutputLog(),
    });
}

// A fake `createCloud`. `routes` maps `"METHOD /path?query"` (`*` matches one
// path segment) to a response `{ status, body }`, a JSON value (status 200),
// a function of the request body, or a `seq(...)` of those served in order
// (the last repeats). Unrouted requests are 404s. Records every call.
function fakeCloud(routes = {}) {
    routes = {
        "POST /api/v1/apps": ok({ app_name: "demo", status: "running", applied_revision: 1 }),
        "POST /api/v1/apps/demo/apply": ok({ app_name: "demo", status: "running", endpoints: { api: "https://api--demo.test", internal: "https://internal--demo.test", external: "https://demo.test" }, outcome: { configuration: "applied", vm: "started" } }),
        ...routes,
    };
    const drafts = new Map();
    const served = new Map();
    const respond = (app, method, path, contentType, body) => {
        cloud.calls.push({ app, method, path, contentType, body });
        const key = Object.keys(routes).find((pattern) => {
            const regex = pattern.split("*").map((part) => part.replace(/[.?+^$()[\]{}|\\]/g, "\\$&")).join("[^/?]+");
            return new RegExp(`^${regex}$`).test(`${method} ${path}`);
        });
        if (key === undefined) return { status: 404, body: `no route for ${method} ${path}` };
        let route = routes[key];
        if (route instanceof Seq) {
            const n = served.get(key) ?? 0;
            served.set(key, n + 1);
            route = route.responses[Math.min(n, route.responses.length - 1)];
        }
        if (typeof route === "function") route = route(body);
        if (route && typeof route === "object" && "status" in route) {
            return { status: route.status, body: typeof route.body === "string" ? route.body : JSON.stringify(route.body) };
        }
        return { status: 200, body: JSON.stringify(route) };
    };
    const cloud = {
        calls: [],
        commands: [],
        runs: [],
        deploys: [],
        creates: [],
        opens: [],
        draftRequests: [],
        openDraft(app, key, parentRevision) {
            cloud.opens.push({ app, key, parentRevision });
            if (!drafts.has(key)) drafts.set(key, { ...draftView(), key, draft_id: drafts.size + 1, parent_revision: parentRevision, env: {}, policy: appConfig(`app_name = "${app}"\n`).policy, cloud: {} });
            return { status: 200, body: JSON.stringify(drafts.get(key)) };
        },
        draftRequest(app, key, draftId, method, section, contentType, body) {
            cloud.draftRequests.push({ app, key, draftId, method, section, contentType, body });
            cloud.calls.push({ app, method, path: `/api/v1/apps/${app}/drafts/${key}${section.length ? "/" + section.join("/") : ""}`, contentType, body });
            const draft = drafts.get(key);
            assert.equal(draft.draft_id, draftId);
            if (method === "DELETE") {
                drafts.delete(key);
                return { status: 200, body: '{"discarded":true}' };
            }
            if (section[0] === "config") {
                const config = appConfig(body);
                Object.assign(draft, { app_toml: body, policy: config.policy, cloud: config.cloud });
            } else if (section[0] === "env") draft.env[section[1]] = JSON.parse(body).value;
            else if (section[0] === "deployment") draft.deployment_id = JSON.parse(body).deployment_id;
            return { status: 200, body: JSON.stringify(draft) };
        },
        create(body, commandId) {
            cloud.creates.push({ body, commandId });
            return respond(null, "POST", "/api/v1/apps", "application/json", body);
        },
        // Provisioner requests are routed under `/api`.
        read(path) {
            const result = respond(null, "GET", `/api/${path.join("/")}`, null, null);
            if (result.status === 404 && path[3] === "drafts" && drafts.has(path[4])) return { status: 200, body: JSON.stringify(drafts.get(path[4])) };
            if (path.length === 3 && path[1] === "apps" && result.status === 200) result.body = JSON.stringify({ applied_revision: 1, ...JSON.parse(result.body) });
            return result;
        },
        command(app, method, path, body, commandId, draftId = null) {
            cloud.commands.push(commandId);
            cloud.lastCommandDraftId = draftId;
            return respond(app, method, `/api/v1/apps/${[app, ...path].join("/")}`, null, body);
        },
        get: (app, path) => respond(app, "GET", path, null, null),
        send: (app, method, path, contentType, body) => respond(app, method, path, contentType, body),
        run(args, stdin, appToml, fillEnv) {
            cloud.runs.push({ args, stdin, appToml, fillEnv });
            return { stdout: "ok\n", stderr: "", exitCode: 0 };
        },
    };
    return cloud;
}

class Seq {
    constructor(responses) {
        this.responses = responses;
    }
}

function seq(...responses) {
    return new Seq(responses);
}

function run(i, args, cloud, stdin = "") {
    return executeObelisk(i, typeof args === "string" ? words(args) : args, stdin, null, cloud);
}

// `obelisk cloud app SUBCOMMAND --app demo ...`
function api(i, args, cloud, stdin = "") {
    const [sub, ...rest] = typeof args === "string" ? words(args) : args;
    return run(i, ["cloud", "app", sub, "--app", "demo", ...rest], cloud, stdin);
}

// -- dispatch, help, app selection, errors --

test("help is printed at every level", () => {
    for (const args of ["", "--help", "cloud", "cloud app", "cloud app execution", "cloud app deployment submit --help", "cloud app admin -h"]) {
        const out = run(interp(), args, fakeCloud());
        assert.equal(out.exitCode, 0, args);
        assert.match(out.stdout, /Usage: obelisk/, args);
    }
    assert.match(run(interp(), "cloud app execution --help", fakeCloud()).stdout, /persist-backtraces/);
});

test("usage errors exit 2 like clap, other errors print Error: and exit 1", () => {
    let out = run(interp(), "server run", fakeCloud());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "error: unrecognized subcommand 'server'\n\nFor more information, try '--help'.\n");

    out = api(interp(), "execution list --bogus", fakeCloud());
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /^error: unexpected argument '--bogus' found/);

    out = api(interp(), "execution status", fakeCloud());
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /required arguments were not provided:\n {2}<EXECUTION_ID>/);

    out = api(interp(), "execution status E_1", fakeCloud());
    assert.equal(out.exitCode, 1);
    assert.equal(out.stderr, "Error: server returned 404 Not Found: no route for GET /v1/executions/E_1/status\n");
});

test("the app comes from --app, then exported OBELISK_APP_NAME, then ./app.toml", () => {
    const cloud = fakeCloud({ "GET /v1/info": serverInfo({ deployment_id: "Dep_1" }) });
    assert.equal(run(interp(), "cloud app deployment active --app flag", cloud).exitCode, 0);
    assert.equal(run(interp("/workspace", { OBELISK_APP_NAME: "env" }), "cloud app deployment active", cloud).exitCode, 0);
    const i = interp();
    i.vfs.writeFile("/workspace/app.toml", 'app_name = "file"\n');
    i.setVar("OBELISK_APP_NAME", "not-exported");
    assert.equal(run(i, "cloud app deployment active", cloud).exitCode, 0);
    assert.deepEqual(cloud.calls.map((call) => call.app), ["flag", "env", "file"]);

    const out = run(interp(), "cloud app deployment active", cloud);
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /^Error: Select an app with --app, OBELISK_APP_NAME or app_name in \.\/app\.toml/);
});

test("--app follows the app subcommand and is rejected by app list", () => {
    const i = interp("/workspace", { OBELISK_APP_NAME: "demo" });
    const cloud = fakeCloud();
    for (const args of ["cloud app --app demo deployment active", "cloud --app demo app status", "cloud app list --app demo"]) {
        const out = run(i, args, cloud);
        assert.equal(out.exitCode, 2, args);
        assert.match(out.stderr, /^error: unexpected argument '--app' found/, args);
    }
    assert.equal(run(i, "cloud app list", cloud).exitCode, 0);
    assert.deepEqual(cloud.runs[0].args, ["app", "list"]);
});

test("--json is global and active prints the ID as a value", () => {
    const cloud = fakeCloud({ "GET /v1/info": serverInfo({ deployment_id: "Dep_1" }) });
    assert.equal(api(interp(), "deployment active", cloud).stdout, "Dep_1\n");
    assert.equal(run(interp(), "cloud --json app deployment active --app demo", cloud).stdout, '"Dep_1"\n');
});

test("commandHandler strips the command name and runs inside the shell", () => {
    const bash = new Bash({ cwd: "/workspace" });
    bash.registerCommand("obelisk", commandHandler(null, fakeCloud({ "GET /v1/info": serverInfo({ deployment_id: "Dep_1" }) })));
    const out = bash.exec("obelisk cloud app deployment active --app demo | tr D d");
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stdout, "dep_1\n");
});

// -- provisioner commands and deploy --

test("provisioner commands forward args, policy and OBELISK_APP_NAME", () => {
    const i = interp("/workspace", { OBELISK_APP_NAME: "demo", API_KEY: "s3cret", MODE: "prod" });
    const policy = 'app_name = "demo"\n[secrets]\nAPI_KEY = { optional = true }\n[public_env]\nMODE = {}\n';
    i.vfs.writeFile("/workspace/app.toml", policy);
    const cloud = fakeCloud();
    let out = run(i, "cloud app env set MODE prod", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.deepEqual(cloud.runs[0], {
        args: words("app env set MODE prod --app demo"), stdin: "", appToml: policy, fillEnv: null,
    });

    // A fill passes only the declared env, never the secret's same-named variable.
    out = run(i, "cloud app new --fill-non-interactive", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.deepEqual(JSON.parse(cloud.creates[0].body), { app_toml: policy, env: { MODE: "prod" }, secrets: {} });
});

test("cloud app deploy uploads without switching, then finishes with its id", () => {
    const i = interp("/workspace/app");
    i.vfs.writeFile("/workspace/app/app.toml", 'app_name = "demo"\n');
    i.vfs.writeFile("/workspace/app/deployment.toml", '[[activity_js]]\nlocation = "a.js"\n');
    i.vfs.writeFile("/workspace/app/a.js", "a");
    const cloud = fakeCloud({
        "GET /api/v1/apps/demo": ok({ app_name: "demo", status: "running" }),
        "PUT /v1/deployments/*": { status: 201, body: "" },
    });
    const out = run(i, "cloud app deploy", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    const id = cloud.calls.find((call) => call.path.startsWith("/v1/deployments/")).path.split("/").at(-1);
    assert.match(id, /^Dep_[0-9A-Z]{26}$/);
    const draft = cloud.opens[0].key;
    assert.match(draft, /^deploy-[0-9a-z]{26}$/);
    const commandId = cloud.commands[0];
    assert.match(commandId, /^E_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    assert.deepEqual(cloud.opens, [{ app: "demo", key: draft, parentRevision: 1 }]);
    assert.ok(cloud.draftRequests.every((request) => request.draftId === 1));
    assert.equal(cloud.lastCommandDraftId, 1);
    const submit = cloud.calls.find((call) => call.path === `/v1/deployments/${id}`);
    assert.deepEqual(JSON.parse(submit.body), {
        deployment_toml: `[[activity_js]]\nlocation = "a.js"\ncontent_digest = "${sha256("a")}"\n`,
        description: null,
        allow_unavailable_runtime_config: true,
    });
    assert.equal(out.stdout, "");
    assert.ok(out.stderr.includes(`→ obelisk cloud app stage --draft ${draft}\n`));
    assert.ok(out.stderr.includes(`Submitted as ${id}\n`));
    assert.match(out.stderr, /Deployed demo\nAPI: https:\/\/api--demo.test/);
    assert.ok(!cloud.calls.some((call) => call.path.endsWith("/switch")));

    const json = run(i, "cloud app deploy --json", cloud);
    assert.deepEqual(JSON.parse(json.stdout).outcomes, [{ configuration: "applied", vm: "started" }]);
});

test("cloud app stage creates a missing app bare, submits, then edits one captured draft", () => {
    const i = interp("/workspace/app", { MODE: "prod" });
    i.vfs.writeFile("/workspace/app/app.toml", 'app_name = "demo"\n[public_env]\nMODE = {}\n');
    i.vfs.writeFile("/workspace/app/deployment.toml", '[[activity_js]]\nlocation = "a.js"\n');
    i.vfs.writeFile("/workspace/app/a.js", "a");
    const cloud = fakeCloud({ "PUT /v1/deployments/*": { status: 201, body: "" } });
    const out = run(i, "cloud app stage --env MODE -d deployment.toml --description first", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    const submit = cloud.calls.find((call) => call.method === "PUT");
    const id = submit.path.slice("/v1/deployments/".length);
    assert.match(id, /^Dep_[0-9A-Z]{26}$/);
    assert.deepEqual(JSON.parse(submit.body), {
        deployment_toml: `[[activity_js]]\nlocation = "a.js"\ncontent_digest = "${sha256("a")}"\n`,
        description: "first",
        allow_unavailable_runtime_config: true,
    });
    assert.deepEqual(cloud.runs, []);
    assert.deepEqual(cloud.opens, [{ app: "demo", key: "default", parentRevision: 1 }]);
    assert.ok(cloud.calls.some((call) => call.method === "GET" && call.path === "/api/v1/apps/demo/drafts/default"));
    assert.deepEqual(cloud.draftRequests.map(({ section }) => section), [["config"], ["env", "MODE"], ["deployment"]]);
    assert.ok(cloud.draftRequests.every((request) => request.draftId === 1));
    assert.deepEqual(JSON.parse(cloud.creates[0].body), { app_toml: 'app_name = "demo"\n' });
    assert.match(cloud.creates[0].commandId, /^E_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    assert.match(out.stderr, /App demo does not exist; creating it/);
    assert.match(out.stderr, /Changes staged\./);
    assert.ok(!cloud.calls.some((call) => call.path.endsWith("/switch")));

    // An empty deployment needs no deployment.toml; an existing app is not created.
    const empty = fakeCloud({ "GET /api/v1/apps/demo": ok({ status: "running" }), "PUT /v1/deployments/*": { status: 201, body: "" } });
    assert.equal(run(i, "cloud app stage --empty-deployment", empty).exitCode, 0);
    const emptyId = empty.calls.find((call) => call.method === "PUT").path.slice("/v1/deployments/".length);
    assert.equal(JSON.parse(empty.draftRequests.at(-1).body).deployment_id, emptyId);

    // A failed submission stages nothing.
    const failed = fakeCloud({ "GET /api/v1/apps/demo": ok({ status: "running" }), "PUT /v1/deployments/*": { status: 500, body: "boom" } });
    const refused = run(i, "cloud app stage -d deployment.toml", failed);
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr, /The deployment was not submitted, nothing was staged/);
    assert.equal(failed.runs.length, 0);

    // A config for another app is refused before anything is created.
    const other = fakeCloud();
    assert.match(run(i, "cloud app stage --app other -d deployment.toml", other).stderr, /app\.toml is for app `demo`, but the selected app is `other`/);
    assert.equal(other.calls.length + other.runs.length, 0);

    // Without a deployment, stage still creates the app outside cloud.run.
    const plain = fakeCloud();
    assert.equal(run(i, "cloud app stage", plain).exitCode, 0);
    assert.deepEqual(plain.runs, []);
    assert.deepEqual(plain.draftRequests.map(({ section }) => section), [["config"]]);
    assert.equal(plain.creates.length, 1);

    for (const args of ["cloud app stage -d deployment.toml --empty-deployment", "cloud app stage --description x"]) {
        assert.notEqual(run(i, args, fakeCloud()).exitCode, 0, args);
    }
});

test("stage reuses default's captured identity and parent without recreating it", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/app.toml", 'app_name = "demo"\n');
    const existing = draftView({ draft_id: 42, parent_revision: 7, env: {}, policy: appConfig('app_name="demo"\n').policy, cloud: {} });
    const cloud = fakeCloud({
        "GET /api/v1/apps/demo": ok({ applied_revision: 9, status: "running" }),
        "GET /api/v1/apps/demo/drafts/default": ok(existing),
    });
    const edits = [];
    cloud.openDraft = () => assert.fail("an existing draft is not reopened");
    cloud.draftRequest = (app, key, id, method, section, contentType, body) => {
        edits.push({ key, id, method, section });
        return { status: 200, body: JSON.stringify(existing) };
    };
    const result = run(i, "cloud app stage --env MODE=prod --json", cloud);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).parent_revision, 7);
    assert.deepEqual(edits, [
        { key: "default", id: 42, method: "PUT", section: ["config"] },
        { key: "default", id: 42, method: "PUT", section: ["env", "MODE"] },
    ]);
    assert.equal(cloud.creates.length, 0);
});

test("deploy preserves browser settings and does not fill an integration-supplied URL", () => {
    const i = interp();
    const policy = 'app_name="demo"\n[cloud.integrations.browser]\ntype="browser"\nenv="BROWSER_URL"\nallowed_hosts=["https://app.example.com"]\nsession_memory_mb=128\n[public_env]\nBROWSER_URL={}\n';
    i.vfs.writeFile("/workspace/app.toml", policy);
    const cloud = fakeCloud({ "PUT /v1/deployments/*": { status: 201, body: "" } });
    const result = run(i, "cloud app deploy --empty-deployment --fill-non-interactive", cloud);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(cloud.draftRequests[0].body, policy);
    assert.ok(!cloud.draftRequests.some(({ section }) => section[0] === "env"));
    assert.deepEqual(appConfig(cloud.draftRequests[0].body).cloud.integrations.browser.allowed_hosts, ["https://app.example.com"]);
});

test("cloud app deploy --empty-deployment and deployment submit --empty skip deployment.toml", () => {
    const i = interp("/workspace/app");
    i.vfs.writeFile("/workspace/app/app.toml", 'app_name = "demo"\n');
    // Never read: an empty deployment ignores the manifest.
    i.vfs.writeFile("/workspace/app/deployment.toml", "invalid TOML");
    for (const args of ["cloud app deploy --empty-deployment", "cloud app deployment submit --empty-deployment", "cloud app deployment submit --empty"]) {
        const cloud = fakeCloud({ "PUT /v1/deployments/*": { status: 201, body: "" } });
        const out = run(i, args, cloud);
        assert.equal(out.exitCode, 0, `${args}: ${out.stderr}`);
        const submit = cloud.calls.find((call) => call.path.startsWith("/v1/deployments/"));
        assert.equal(JSON.parse(submit.body).deployment_toml, "", args);
    }
    assert.equal(run(i, "cloud app deploy -d deployment.toml --empty-deployment", fakeCloud()).exitCode, 2);
});

test("cloud app apply leaves the deployment to the draft", () => {
    const cloud = fakeCloud({
        "GET /api/v1/apps/demo": ok({ status: "running", applied_revision: 1 }),
        "GET /api/v1/apps/demo/drafts/default": draftView({ deployment_id: "Dep_staged" }),
        "POST /api/v1/apps/demo/apply": ok({ status: "running", outcome: { configuration: "applied" } }),
    });
    const out = api(interp(), "apply", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.ok(!cloud.calls.some((call) => call.path === "/v1/info"));
    assert.deepEqual(JSON.parse(cloud.calls.at(-1).body), { force: false, draft: "default" });
});

// A draft view as the provisioner returns it: `default`, revision 2 over applied revision 1, app.toml changed.
// A 200 response, for values with their own `status` field.
function ok(body) {
    return { status: 200, body };
}

function draftView(overrides = {}) {
    const empty = { added: [], removed: [], changed: [] };
    return {
        key: "default", parent_revision: 1, revision: 2, applied_revision: 1, stale: false,
        summary: { changed: true, app_toml: true, policy: false, cloud: false, env: empty, secrets: empty },
        values: { missing_env: [], missing_secrets: [], unused_env: [], unused_secrets: [] },
        ...overrides,
    };
}

test("cloud app apply reads in the shell and sends one command with a fresh Idempotency-Key", () => {
    const cloud = fakeCloud({
        "GET /api/v1/apps/demo": ok({ status: "running", applied_revision: 1 }),
        "GET /api/v1/apps/demo/drafts/default": draftView(),
        "POST /api/v1/apps/demo/apply": ok({ status: "running", outcome: { configuration: "applied" } }),
    });
    const out = api(interp(), "apply --force", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.match(out.stderr, /^Applying draft `default` revision 2 over revision 1: app\.toml\nConfiguration applied\./);
    assert.deepEqual(cloud.calls.map((call) => `${call.method} ${call.path}`), [
        "GET /api/v1/apps/demo", "GET /api/v1/apps/demo/drafts/default", "POST /api/v1/apps/demo/apply",
    ]);
    assert.deepEqual(JSON.parse(cloud.calls[2].body), { force: true, draft: "default" });
    assert.match(cloud.commands[0], /^E_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    assert.equal(cloud.runs.length, 0);

    const json = api(interp(), "apply --json", cloud);
    assert.deepEqual(JSON.parse(json.stdout).outcome, { configuration: "applied" });
    assert.equal(json.stderr, "");
});

test("cloud app apply needs a staged draft unless --reapply and rejects other flags", () => {
    const cloud = fakeCloud({
        "GET /api/v1/apps/demo": ok({ status: "running", applied_revision: 4 }),
        "POST /api/v1/apps/demo/apply": ok({ status: "running" }),
    });
    const nothing = api(interp(), "apply --draft ci", cloud);
    assert.equal(nothing.exitCode, 1);
    assert.match(nothing.stderr, /^Error: Nothing staged in draft `ci`; stage changes with `obelisk cloud app stage` or `env set` --draft ci, or reconcile the applied revision with `--reapply`/);
    assert.equal(cloud.commands.length, 0);

    const reapplied = api(interp(), "apply --reapply", cloud);
    assert.equal(reapplied.exitCode, 0, reapplied.stderr);
    assert.match(reapplied.stderr, /^Re-applying revision 4\n/);
    assert.deepEqual(JSON.parse(cloud.calls.at(-1).body), { force: false, revision: 4 });

    const stale = fakeCloud({
        "GET /api/v1/apps/demo": ok({ status: "running", applied_revision: 1 }),
        "GET /api/v1/apps/demo/drafts/default": draftView({ stale: true }),
    });
    assert.match(api(interp(), "apply", stale).stderr, /Draft `default` was opened on revision 1, but revision 1 was applied since/);
    assert.equal(stale.commands.length, 0);

    for (const args of ["apply --reapply --draft ci", "apply --draft Bad", "apply --env X", "enable --force", "delete extra"]) {
        assert.equal(api(interp(), args, fakeCloud()).exitCode, 2, args);
    }
});

test("cloud app enable, disable and delete report errors with the command ID", () => {
    const cloud = fakeCloud({
        "POST /api/v1/apps/demo/disable": { status: 409, body: { error: "app is busy" } },
        "DELETE /api/v1/apps/demo": ok({ status: "deleted" }),
        "POST /api/v1/apps/demo/enable": () => { throw "Cloud API returned 503: interrupted"; },
    });
    const busy = api(interp(), "disable --command-id E_cmd", cloud);
    assert.equal(busy.exitCode, 1);
    assert.equal(busy.stderr, "Error: app is busy (HTTP 409). Command ID: E_cmd\n");
    assert.deepEqual(cloud.calls.map((call) => `${call.method} ${call.path}`), ["GET /api/v1/commands/E_cmd", "POST /api/v1/apps/demo/disable"]);

    const deleted = api(interp(), "delete", cloud);
    assert.equal(deleted.exitCode, 0, deleted.stderr);
    assert.equal(deleted.stderr, "App deleted.\n");

    const failed = api(interp(), "enable", cloud);
    assert.equal(failed.exitCode, 1);
    assert.match(failed.stderr, new RegExp(`^Error: Cloud request failed; retry the same command with --command-id ${cloud.commands.at(-1)}\n\nCaused by:\n {4}Cloud API returned 503: interrupted\n$`));
});

test("cloud app apply --command-id reports an accepted command without rebuilding it", () => {
    const id = "E_01M7A0M1P2P2F1VNCPZ9S26DFJ";
    const cloud = fakeCloud({ [`GET /api/v1/commands/${id}`]: ok({ status: "running", outcome: { configuration: "applied" } }) });
    const out = api(interp(), `apply --command-id ${id}`, cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.match(out.stderr, /^Configuration applied\./);
    assert.deepEqual(cloud.calls.map((call) => call.path), [`/api/v1/commands/${id}`]);
    assert.equal(cloud.commands.length, 0);
});

test("cloud app deploy forwards --env with only the named variables and applies its draft", () => {
    const i = interp("/workspace/app", { MODE: "prod", API_KEY: "s3cret", OTHER: "x" });
    i.vfs.writeFile("/workspace/app/app.toml", 'app_name = "demo"\n');
    i.vfs.writeFile("/workspace/app/deployment.toml", "");
    const cloud = fakeCloud({ "PUT /v1/deployments/*": { status: 201, body: "" } });
    const out = run(i, "cloud app deploy --env MODE --env REGION=eu", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.match(cloud.opens[0].key, /^deploy-[0-9a-z]{26}$/);
    assert.deepEqual(cloud.draftRequests.filter(({ section }) => section[0] === "env").map(({ section, body }) => [section[1], JSON.parse(body).value]), [["MODE", "prod"], ["REGION", "eu"]]);
    assert.equal(cloud.lastCommandDraftId, 1);

    i.vfs.writeFile("/workspace/app/app.toml", 'app_name = "demo"\n[secrets]\nAPI_KEY = {}\n[public_env]\nOTHER = {}\n');
    const filled = fakeCloud({ "GET /api/v1/apps/demo": ok({ status: "running" }), "PUT /v1/deployments/*": { status: 201, body: "" } });
    assert.equal(run(i, "cloud app deploy --fill-non-interactive", filled).exitCode, 0);
    assert.deepEqual(filled.draftRequests.filter(({ section }) => section[0] === "env").map(({ section, body }) => [section[1], JSON.parse(body).value]), [["OTHER", "x"]]);
    assert.equal(run(i, "cloud app deploy --draft ci", fakeCloud()).exitCode, 2);
});

test("cloud app deploy discards its draft when the submission fails", () => {
    const i = interp("/workspace/app");
    i.vfs.writeFile("/workspace/app/app.toml", 'app_name = "demo"\n');
    i.vfs.writeFile("/workspace/app/deployment.toml", "");
    const cloud = fakeCloud({ "PUT /v1/deployments/*": { status: 500, body: "boom" } });
    const out = run(i, "cloud app deploy", cloud);
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /Deployment staging failed/);
    assert.equal(cloud.draftRequests.at(-1).method, "DELETE");
    assert.equal(cloud.draftRequests.at(-1).draftId, 1);
    assert.equal(cloud.commands.length, 0);
});

test("cloud app new captures explicit env in its immutable creation request", () => {
    const i = interp("/workspace", { OBELISK_APP_NAME: "demo", MODE: "prod", API_KEY: "s3cret", OTHER: "x" });
    i.vfs.writeFile("/workspace/app.toml", 'app_name = "demo"\n');
    const cloud = fakeCloud();
    const out = run(i, "cloud app new --env MODE --env REGION=eu", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(cloud.runs.length, 0);
    assert.deepEqual(JSON.parse(cloud.creates[0].body), { app_toml: 'app_name = "demo"\n', env: { MODE: "prod", REGION: "eu" }, secrets: {} });
    assert.match(cloud.creates[0].commandId, /^E_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
});

test("cloud app new recovers a lost command response before rebuilding its inputs", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/app.toml", 'app_name = "demo"\n');
    const cloud = fakeCloud();
    cloud.create = (body, commandId) => {
        cloud.creates.push({ body, commandId });
        throw "response lost";
    };
    const failed = run(i, "cloud app new", cloud);
    const { commandId } = cloud.creates[0];
    assert.equal(failed.exitCode, 1);
    assert.ok(failed.stderr.includes(`obelisk cloud app new --app demo --command-id ${commandId}`));
    i.vfs.writeFile("/workspace/app.toml", 'app_name = "demo"\n[public_env]\nMODE = {}\n');
    const recovered = fakeCloud({ [`GET /api/v1/commands/${commandId}`]: ok({ app_name: "demo", status: "running" }) });
    const result = run(i, `cloud app new --app demo --command-id ${commandId} --json --env MODE`, recovered);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).app_name, "demo");
    assert.equal(recovered.creates.length, 0);
    assert.deepEqual(recovered.calls.map((call) => call.path), [`/api/v1/commands/${commandId}`]);
});

test("creation validates the selected config and required values before submitting", () => {
    const i = interp("/workspace/app", { MODE: "prod", API_KEY: "secret" });
    i.vfs.writeFile("/workspace/app/deployment.toml", "");
    for (const [policy, args, error] of [
        ['app_name = "other"\n', "cloud app new --app demo -a app.toml", /is for app `other`/],
        ['app_name = "demo"\n[public_env]\nMODE = {}\n', "cloud app new", /Missing required configuration: env MODE/],
        ['app_name = "demo"\n[public_env]\nMODE = {}\n', "cloud app deploy", /Missing required configuration: env MODE/],
        ['app_name = "demo"\n[secrets]\nAPI_KEY = {}\n', "cloud app new --fill-non-interactive", /requires secret\(s\) API_KEY/],
        ['app_name = "demo"\n[secrets]\nAPI_KEY = {}\n', "cloud app deploy --fill-non-interactive", /requires secret\(s\) API_KEY/],
    ]) {
        i.vfs.writeFile("/workspace/app/app.toml", policy);
        const cloud = fakeCloud();
        const result = run(i, args, cloud);
        assert.equal(result.exitCode, 1, args);
        assert.match(result.stderr, error);
        assert.equal(cloud.creates.length, 0);
        assert.equal(cloud.deploys.length, 0);
    }
});

test("cloud app commands never take secret values", () => {
    const i = interp("/workspace/app", { OBELISK_APP_NAME: "demo", API_KEY: "s3cret" });
    i.vfs.writeFile("/workspace/app/app.toml", 'app_name = "demo"\n');
    i.vfs.writeFile("/workspace/app/deployment.toml", "");
    for (const args of ["new --secret API_KEY", "stage --secret=API_KEY -d deployment.toml", "deploy --secret API_KEY"]) {
        const cloud = fakeCloud();
        const out = run(i, `cloud app ${args}`, cloud);
        assert.equal(out.exitCode, 1, args);
        assert.match(out.stderr, /^Error: `--secret` is not available here, secret values come only from the user: ask the user to set them/, args);
        assert.deepEqual([cloud.runs, cloud.deploys, cloud.calls], [[], [], []], args);
    }
});

test("cloud app deploy refuses another app's config or a missing one", () => {
    const i = interp("/workspace/app", { OBELISK_APP_NAME: "demo" });
    const cloud = fakeCloud();
    let out = run(i, "cloud app deploy", cloud);
    assert.equal(out.stderr, "Error: No app config: ./app.toml not found; pass --app-config\n");
    i.vfs.writeFile("/workspace/app/app.toml", 'app_name = "other"\n');
    out = run(i, "cloud app deploy", cloud);
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /app\.toml is for app `other`, but the selected app is `demo`/);
    assert.deepEqual(cloud.deploys, []);
});

test("cloud app deploy stops before finishing when the upload fails", () => {
    const i = interp("/workspace/app");
    i.vfs.writeFile("/workspace/app/app.toml", 'app_name = "demo"\n');
    i.vfs.writeFile("/workspace/app/deployment.toml", "");
    const cloud = fakeCloud({ "PUT /v1/deployments/*": { status: 400, body: "invalid deployment" } });
    const out = run(i, "cloud app deploy", cloud);
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /Error: Deployment staging failed; inspect `obelisk cloud app status --app demo` and retry deploy\n\nCaused by:\n {4}server returned 400 Bad Request: invalid deployment\n$/);
    assert.equal(cloud.commands.length, 0);
});

// -- execution --

const LOCKED = { status: "locked", locked_by: { executor_id: "Exr_1", run_id: "Run_1" }, lock_expires_at: "2026-01-01T00:00:00Z" };
const FINISHED = { status: "finished", version: 3, finished_at: "2026-01-01T00:00:01Z", result_kind: "ok" };

test("execution list forwards filters and prints a compact or verbose line per execution", () => {
    const executions = [
        { execution_id: "E_1", ffqn: "a:b/c.d", pending_state: LOCKED, first_scheduled_at: "2026-01-01T00:00:00Z" },
        { execution_id: "E_2", ffqn: "a:b/c.e", pending_state: FINISHED, first_scheduled_at: "2026-01-01T00:00:00Z" },
    ];
    const cloud = fakeCloud({ "GET /v1/executions?*": executions });
    let out = api(interp(), "execution list --ffqn a:b -e E_ --hide-finished --limit 5", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(cloud.calls[0].path, "/v1/executions?length=5&ffqn_prefix=a%3Ab&execution_id_prefix=E_&hide_finished=true");
    assert.equal(out.stderr, "E_1 `Running` a:b/c.d\nE_2 `Finished: OK` a:b/c.e\n");
    assert.equal(out.stdout, "");

    out = run(interp(), "cloud --verbose app execution list --app demo", cloud);
    assert.equal(out.stderr.split("\n")[0], "E_1 `Locked(`2026-01-01 00:00:00 UTC`, Exr_1, Run_1)` a:b/c.d `2026-01-01 00:00:00 UTC`");
    assert.deepEqual(JSON.parse(api(interp(), "execution list -j", cloud).stdout), executions);
});

test("execution submit matches a short function name and prints the new ID", () => {
    const cloud = fakeCloud({
        "GET /v1/components?exports=true&extensions=false": [{ exports: [{ ffqn: "ns:pkg/ifc@1.0.0.run" }, { ffqn: "ns:pkg/other.run" }] }],
        "PUT /v1/executions/*": (body) => ({ ok: "E_x", body }),
    });
    const out = api(interp(), ["execution", "submit", ".../ifc.run", '["a", 1]', "--paused"], cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stderr, "Matched ns:pkg/ifc@1.0.0.run\n");
    assert.equal(out.stdout, "E_x\n");
    assert.match(cloud.calls[1].path, /^\/v1\/executions\/E_[0-9A-Z]{26}$/);
    assert.deepEqual(JSON.parse(cloud.calls[1].body), { ffqn: "ns:pkg/ifc@1.0.0.run", params: ["a", 1], paused: true });
});

test("execution submit parameters: none, one array, stdin, @file, and one value per argument after --", () => {
    const cloud = fakeCloud({ "PUT /v1/executions/*": { ok: "E_x" } });
    const i = interp();
    i.vfs.writeFile("/workspace/p.json", "[3]");
    const params = (args, stdin) => {
        const out = api(i, ["execution", "submit", ...args], cloud, stdin);
        assert.equal(out.exitCode, 0, out.stderr);
        return JSON.parse(cloud.calls.at(-1).body).params;
    };
    assert.deepEqual(params(["a:b/c.d"]), []);
    assert.deepEqual(params(["a:b/c.d", "[1, 2]"]), [1, 2]);
    assert.deepEqual(params(["a:b/c.d", "-"], "[true]"), [true]);
    assert.deepEqual(params(["a:b/c.d", "@p.json"]), [3]);
    assert.deepEqual(params(["a:b/c.d", "--", '"x"', "{}"]), ["x", {}]);
    assert.deepEqual(params(["a:b/c.d", "--", "[1]"]), [[1]]);
    assert.deepEqual(params(["-e", "E_given", "a:b/c.d"]), []);
    assert.equal(cloud.calls.at(-1).path, "/v1/executions/E_given");

    const out = api(i, ["execution", "submit", "a:b/c.d", "{}"], cloud);
    assert.equal(out.stderr, "Error: Parameter provided as JSON must be a JSON array.\n");
});

test("execution submit --follow streams the status and reports the result", () => {
    const sse = `data: ${JSON.stringify({ pending_state: LOCKED })}\n\ndata: ${JSON.stringify({ pending_state: FINISHED })}\n\n`;
    const cloud = fakeCloud({
        "PUT /v1/executions/*": { ok: "E_x" },
        "GET /v1/executions/*/status?follow=true": { status: 200, body: sse },
        "GET /v1/executions/*?follow=false": { ok: { value: 1 } },
    });
    let out = api(interp(), "execution submit -e E_x a:b/c.d -f", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stdout, 'E_x\n{\n  "ok": {\n    "value": 1\n  }\n}\n');
    assert.equal(out.stderr, "Locked\nFinished: OK\nExecution finished: OK\n");

    out = api(interp(), "execution submit -e E_x a:b/c.d -f --json", cloud);
    assert.equal(out.stdout, '{"ok":"E_x"}\n{"ok":{"value":1}}\n');
    assert.equal(out.stderr, "");
});

test("execution result exits 1 on an error or execution failure", () => {
    let cloud = fakeCloud({ "GET /v1/executions/E_1?follow=false": { err: null } });
    let out = api(interp(), "execution result E_1", cloud);
    assert.equal(out.exitCode, 1);
    assert.equal(out.stdout, '{\n  "err": null\n}\n');
    assert.equal(out.stderr, "Execution finished: Error\n");

    cloud = fakeCloud({ "GET /v1/executions/E_1?follow=false": { execution_failed: { kind: "timed_out", reason: "slow", detail: "d" } } });
    out = api(interp(), "execution result E_1", cloud);
    assert.equal(out.stderr, "Execution finished: Execution failure (TimedOut): `slow`\nd\n");
});

test("execution status prints the status text, or JSON", () => {
    const cloud = fakeCloud({ "GET /v1/executions/E_1/status": { ffqn: "a:b/c.d", pending_state: { status: "blocked_by_join_set", join_set_id: "o:1", closing: true } } });
    assert.equal(api(interp(), "execution status E_1", cloud).stderr, "Blocked by o:1 (closing)\n");
    assert.equal(JSON.parse(api(interp(), "execution status E_1 --json", cloud).stdout).ffqn, "a:b/c.d");
});

test("execution logs builds the level and stream query and prints log and stream lines", () => {
    const items = [
        { cursor: 1, run_id: "Run_1", execution_id: "E_1", type: "log", created_at: "2026-01-01T00:00:00Z", level: "info", message: "hello" },
        { cursor: 2, run_id: "Run_1", execution_id: "E_1", type: "stream", created_at: "2026-01-01T00:00:01Z", stream_type: "stdout", payload: "aGkK" },
    ];
    const cloud = fakeCloud({ "GET /v1/executions/E_1/logs?*": items });
    const out = api(interp(), "execution logs E_1 --level warn --stream-type stdout --show-run-id", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(cloud.calls[0].path,
        "/v1/executions/E_1/logs?length=20&direction=newer&show_logs=true&level=warn&level=error&show_streams=true&stream_type=stdout");
    assert.equal(out.stdout,
        "2026-01-01 00:00:00 UTC [info  ] Run_1 hello\n2026-01-01 00:00:01 UTC [stdout] Run_1 hi\n\n");

    const off = api(interp(), "execution logs E_1 --level off --stream-type none", cloud);
    assert.equal(off.stderr, "Error: either `--level` must not be `off`, or `--stream-type` must not be `none`\n");
});

test("execution logs --follow polls until the execution has finished and nothing is left", () => {
    const item = { cursor: 7, run_id: "Run_1", execution_id: "E_1", type: "log", created_at: "2026-01-01T00:00:00Z", level: "info", message: "m" };
    const cloud = fakeCloud({
        "GET /v1/executions/E_1/logs?*": seq([], [item], []),
        "GET /v1/executions/E_1/status": seq({ pending_state: LOCKED }, { pending_state: FINISHED }),
    });
    const out = api(interp(), "execution logs E_1 --follow", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stdout, "2026-01-01 00:00:00 UTC [info  ] m\n");
    assert.match(cloud.calls.at(-2).path, /&cursor=7&including_cursor=false$/);
});

test("execution events and responses render the event log", () => {
    const cloud = fakeCloud({
        "GET /v1/executions/E_1/events?length=20&direction=older": {
            events: [
                { version: 0, created_at: "2026-01-01T00:00:00Z", event: { created: { ffqn: "a:b/c.d", scheduled_at: "2026-01-01T00:00:00Z" } } },
                { version: 1, created_at: "2026-01-01T00:00:00Z", event: { history_event: { event: { type: "join_set_request", join_set_id: "o:1", request: { type: "delay_request", delay_id: "Delay_1", expires_at: "2026-01-01T00:00:00Z", schedule_at: { in: { secs: 5, nanos: 0 } } } } } } },
                { version: 2, created_at: "2026-01-01T00:00:00Z", event: "paused" },
            ],
            max_version: 2,
        },
        "GET /v1/executions/E_1/responses?length=3&cursor=0&including_cursor=true": {
            responses: [{ cursor: 0, event: { created_at: "2026-01-01T00:00:00Z", event: { join_set_id: "o:1", event: { type: "delay_finished", delay_id: "Delay_1", result: { Ok: null } } } } }],
        },
    });
    let out = api(interp(), "execution events E_1", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stderr, [
        "0 `2026-01-01 00:00:00 UTC` Created(a:b/c.d, `2026-01-01 00:00:00 UTC`)",
        "1 `2026-01-01 00:00:00 UTC` HistoryEvent(JoinSetRequest(DelayRequest(Delay_1, expires_at: `2026-01-01 00:00:00 UTC`, schedule_at: `In(5s)`)))",
        "2 `2026-01-01 00:00:00 UTC` Paused",
        "",
    ].join("\n"));
    out = api(interp(), "execution responses E_1 --from 0 --limit 3", cloud);
    assert.equal(out.stderr, "0 `2026-01-01 00:00:00 UTC` o:1 delay finished: Delay_1\n");
});

test("execution cancel accepts a 409 outcome and routes delays separately", () => {
    const cloud = fakeCloud({
        "PUT /v1/executions/E_1/cancel": { status: 409, body: { err: "already_finished" } },
        "PUT /v1/delays/Delay_1/cancel": { ok: "cancelled" },
    });
    assert.equal(api(interp(), "execution cancel E_1", cloud).stderr, "Already_finished\n");
    assert.equal(api(interp(), "execution cancel Delay_1 --json", cloud).stdout, '{\n  "ok": "cancelled"\n}\n');
    assert.equal(api(interp(), "execution cancel X_1", cloud).exitCode, 2);
});

test("execution advance pauses captured delays and children before writing them", () => {
    const delayAppend = { event: { history_event: { event: { type: "join_set_request", request: { type: "delay_request", delay_id: "Delay_1" } } } } };
    const cloud = fakeCloud({
        "PUT /v1/executions/E_1/replay": {
            type: "advanceable", replayed_event_count: 1, replay_duration_ms: 1, replay_version: 1,
            captured_writes: [{ type: "append", event: delayAppend }, { type: "append_batch_create_new_execution", events: [], child_requests: [{}] }],
        },
        "PUT /v1/executions/E_1/advance": { type: "in_progress", pending_state: { status: "paused", PendingAt: { scheduled_at: "2026-01-01T00:00:00Z", last_lock: null } } },
    });
    const out = api(interp(), "execution advance E_1 --pause-all", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    const writes = JSON.parse(cloud.calls[1].body).captured_writes;
    assert.equal(writes[0].event.event.history_event.event.request.paused, true);
    assert.equal(writes[1].child_requests[0].paused, true);
    assert.equal(out.stderr, "success, current state: Paused(PendingAt(`2026-01-01 00:00:00 UTC`, last_lock=None))\n");
});

test("execution events --backtraces shows each backtrace once with source snippets", () => {
    const created = { created: { ffqn: "a:b/c.d", scheduled_at: "2026-01-01T00:00:00Z" } };
    const events = {
        events: [
            { version: 0, created_at: "2026-01-01T00:00:00Z", event: created },
            { version: 2, created_at: "2026-01-01T00:00:00Z", event: "paused", backtrace_id: 2 },
            { version: 3, created_at: "2026-01-01T00:00:00Z", event: "paused", backtrace_id: 2 },
        ],
        max_version: 3,
    };
    const backtrace = {
        component_id: { component_digest: "sha256:wf" },
        wasm_backtrace: {
            frames: [
                { module: "wf", func_name: "f0", symbols: [{ func_name: "run", file: "wf.js", line: 2, col: 10 }, { file: "lib.js", line: 1 }] },
                { module: "wf", func_name: "native", symbols: [] },
            ],
        },
    };
    const cloud = fakeCloud({
        "GET /v1/executions/E_1/events?length=20&include_backtrace_id=true&direction=older": events,
        "GET /v1/executions/E_1/backtrace?version=2": backtrace,
        "GET /v1/components/sha256:wf/source?file=wf.js": "a\nb\nc\nd\n",
    });
    let out = api(interp(), "execution events E_1 --backtraces", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stderr, [
        "0 `2026-01-01 00:00:00 UTC` Created(a:b/c.d, `2026-01-01 00:00:00 UTC`)",
        "2 `2026-01-01 00:00:00 UTC` Paused",
        "    at run (wf.js:2:10)",
        "        1 | a",
        "      > 2 | b",
        "        3 | c",
        "        4 | d",
        "    at f0 (lib.js:1)",
        "    at native (wf)",
        "3 `2026-01-01 00:00:00 UTC` Paused",
        "",
    ].join("\n"));
    assert.equal(cloud.calls.filter((call) => call.path.includes("/backtrace?")).length, 1);
    assert.equal(cloud.calls.filter((call) => call.path.includes("/source?")).length, 2, "lib.js 404 is cached");

    out = api(interp(), "execution events E_1 --backtraces=frames", cloud);
    assert.doesNotMatch(out.stderr, /\| a/);
    assert.match(out.stderr, /at run \(wf\.js:2:10\)/);

    out = api(interp(), "execution events E_1 --backtraces --json", cloud);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.max_version, 3);
    assert.deepEqual(parsed.events[1].backtrace.wasm_backtrace.frames[0].symbols[0].source, { start_line: 1, lines: ["a", "b", "c", "d"] });
    assert.equal(parsed.events[2].backtrace, undefined);

    assert.equal(api(interp(), "execution events E_1 --backtraces=bogus", cloud).exitCode, 2);

    const none = fakeCloud({ "GET /v1/executions/E_1/events?length=20&include_backtrace_id=true&direction=older": { events: [events.events[0]], max_version: 0 } });
    assert.match(api(interp(), "execution events E_1 --backtraces", none).stderr, /No persisted backtraces for these events, see `obelisk cloud app execution persist-backtraces E_1`/);
});

test("execution upgrade switches to the active deployment's component", () => {
    const cloud = fakeCloud({
        "GET /v1/executions/E_1/status": { ffqn: "a:b/c.d", component_digest: "sha256:old" },
        "GET /v1/components?ffqn=a%3Ab%2Fc.d": [{ component_id: { name: "w", component_digest: "sha256:new" } }],
        "PUT /v1/executions/E_1/upgrade": { status: 200, body: "" },
    });
    const out = api(interp(), "execution upgrade E_1", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stderr, "Upgrading from sha256:old to sha256:new\nUpgraded\n");
    assert.deepEqual(JSON.parse(cloud.calls[2].body), { old: "sha256:old", new: "sha256:new", skip_determinism_check: false });
});

// -- component --

test("component list prints each component's exports", () => {
    const components = [{
        component_id: { component_type: "workflow", name: "wf", component_digest: "sha256:1" },
        exports: [{ ffqn: "a:b/c.d", parameter_types: [{ name: "x", wit_type: "u32" }], return_type: "result<string>" }],
        imports: [],
    }];
    const cloud = fakeCloud({ "GET /v1/components?exports=true&imports=true&extensions=false": components });
    const out = api(interp(), "component list -i", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stderr, "wf\tworkflow\nExports:\n\ta:b/c.d: func(x: u32) -> result<string>\nImports:\n\n");
    assert.match(api(interp(), "component push x", cloud).stderr, /^Error: `component push` needs an OCI registry/);
});

test("component source lists registered files or prints one", () => {
    const cloud = fakeCloud({
        "GET /v1/components/sha256:1/sources": [{ file: "wf.js", digest: "sha256:a" }, { file: ".../src/lib.rs", digest: "sha256:b" }],
        "GET /v1/components/sha256:2/sources": [],
        "GET /v1/components/sha256:1/source?file=wf.js": "export default 1;\n",
    });
    let out = api(interp(), "component source sha256:1", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stdout, "wf.js\n.../src/lib.rs\n");
    assert.equal(JSON.parse(api(interp(), "component source sha256:1 --json", cloud).stdout)[1].digest, "sha256:b");
    assert.equal(api(interp(), "component source sha256:2", cloud).stderr, "No sources registered for component sha256:2\n");
    assert.equal(api(interp(), "component source sha256:1 wf.js", cloud).stdout, "export default 1;\n");
    assert.equal(api(interp(), "component source sha256:1 wf.js --json", cloud).stdout, '"export default 1;\\n"\n');
    out = api(interp(), "component source sha256:1 x.js", cloud);
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /^Error: cannot fetch source `x.js` of component sha256:1\n\nCaused by:\n {4}server returned 404 Not Found/);
});

// -- deployment --

test("deployment submit uploads only the missing files, then resubmits", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/deployment.toml", '[[activity_js]]\nlocation = "a.js"\n');
    i.vfs.writeFile("/workspace/a.js", "a");
    const digest = sha256("a");
    const cloud = fakeCloud({
        "PUT /v1/deployments/Dep_01ARZ3NDEKTSV4RRFFQ69G5FAV": seq(
            { status: 409, body: { missing_files: [{ field_path: "activity_js[0].location", path: "a.js", digest }] } },
            { status: 201, body: "" },
        ),
        [`PUT /v1/files/${digest}`]: { status: 204, body: "" },
    });
    const out = run(i, "cloud app deployment --app demo --verbose submit --deployment-id Dep_01ARZ3NDEKTSV4RRFFQ69G5FAV --description first", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stdout, "Dep_01ARZ3NDEKTSV4RRFFQ69G5FAV\n");
    assert.equal(out.stderr, `Uploading a.js (1 bytes, ${digest})\nSubmitted as Dep_01ARZ3NDEKTSV4RRFFQ69G5FAV\n`);
    const [preflight, upload, retry] = cloud.calls;
    assert.equal(JSON.parse(preflight.body).description, "first");
    assert.deepEqual([upload.contentType, upload.body], ["application/octet-stream", "a"]);
    assert.equal(retry.body, preflight.body);
});

test("deployment submit refreshes the deployment storing the same content", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/deployment.toml", "[[activity_js]]\nlocation = 'a.js'\n");
    i.vfs.writeFile("/workspace/a.js", "a");
    const digest = api(i, "deployment digest", fakeCloud()).stdout.trim();
    assert.match(digest, /^sha256:[0-9a-f]{64}$/);
    const cloud = fakeCloud({
        [`GET /v1/deployment-digests/${digest}`]: { deployment_id: "Dep_1" },
        "PUT /v1/deployments/Dep_1": { status: 200, body: "null" },
    });
    const out = api(i, "deployment submit", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stdout, "Dep_1\n");
    assert.equal(out.stderr, "Deployment content matches Dep_1\nSubmitted as Dep_1\n");
    assert.equal(JSON.parse(cloud.calls.at(-1).body).description, null);
});

test("deployment digest reads a stored deployment by ID", () => {
    const id = "Dep_01JABCDEFGHJKMNPQRSTVWXYZ0";
    const cloud = fakeCloud({ [`GET /v1/deployments/${id}`]: { digest: "sha256:abc" } });
    assert.equal(api(interp(), `deployment digest ${id}`, cloud).stdout, "sha256:abc\n");
});

test("cloud app pull writes app.toml and the active deployment", () => {
    const i = interp();
    const cloud = fakeCloud({
        "GET /v1/app-toml": { status: 200, body: 'app_name = "demo"\n' },
        "GET /v1/info": serverInfo({ deployment_id: "Dep_1", app_name: "demo" }),
        "GET /v1/deployments/Dep_1?include_generated_metadata=false": { deployment_toml: "# stored\n", files: [] },
    });
    let out = api(i, "pull -o out", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stderr, "Wrote out/app.toml for app demo\nWrote out/deployment.toml (0 source files) for deployment Dep_1\n");
    assert.equal(i.vfs.readFile("/workspace/out/app.toml"), 'app_name = "demo"\n');
    assert.equal(i.vfs.readFile("/workspace/out/deployment.toml"), "# stored\n");
    out = api(i, "pull -o out", cloud);
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /try using `--force`/);
    assert.equal(api(i, "pull -o out -f", cloud).exitCode, 0);
});

test("deployment pull defaults to the active deployment", () => {
    const cloud = fakeCloud({
        "GET /v1/info": serverInfo({ deployment_id: "Dep_1" }),
        "GET /v1/deployments/Dep_1?include_generated_metadata=false": { deployment_toml: "# stored\n", files: [] },
    });
    const out = api(interp(), "deployment pull", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.match(out.stderr, /^Pulling active deployment Dep_1\n/);
});

test("generate app-name sets the root app_name and keeps the rest", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/app.toml", '# keep\napp_name = "old"\n\n[env_vars]\napp_name = "kept"\n');
    const out = run(i, ["generate", "app-name"], fakeCloud());
    const name = out.stdout.trim();
    assert.match(name, /^[a-z]+-[a-z]+$/);
    assert.ok(name.length <= 20);
    assert.equal(out.stderr, "Updated app_name in app.toml\n");
    assert.equal(i.vfs.readFile("/workspace/app.toml"), `# keep\napp_name = "${name}"\n\n[env_vars]\napp_name = "kept"\n`);
    const printed = run(i, ["generate", "app-name", "--print-only"], fakeCloud());
    assert.equal(printed.stderr, "");
    assert.equal(i.vfs.readFile("/workspace/app.toml").includes(name), true);
});

test("deployment submit reports server rejections like the real CLI", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/deployment.toml", "");
    let cloud = fakeCloud({ "PUT /v1/deployments/*": { status: 409, body: { unexpected_files: [{ field_path: "x" }], missing_files: [{ field_path: "y", message: "gone" }] } } });
    assert.equal(api(i, "deployment submit", cloud).stderr, "Error: deployment submit rejected: missing file at y (gone); unexpected file x\n");

    cloud = fakeCloud({ "PUT /v1/deployments/*": { status: 422, body: { error: "missing_runtime_config", secrets: ["TOKEN"] } } });
    assert.match(api(i, "deployment submit", cloud).stderr, /^Error: deployment rejected by the server: configuration references secret\(s\) `TOKEN` not registered/);
});

test("deployment submit rejects generated metadata and missing files", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/deployment.toml", '[[activity_js]]\nlocation = "a.js"\ncontent_digest = "sha256:1"\n');
    assert.equal(api(i, "deployment submit", fakeCloud()).stderr,
        "Error: activity_js.content_digest is generated submission metadata; remove it from deployment.toml\n");
    assert.match(api(i, "deployment submit missing.toml", fakeCloud()).stderr, /^Error: cannot read deployment manifest "missing.toml"/);
});

test("cloud deployment enqueue and apply reject activation before any API calls", () => {
    const id = "Dep_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    for (const action of ["enqueue", "apply"]) {
        for (const source of [id, "--empty", "--empty-deployment", "missing.toml"]) {
            const cloud = fakeCloud();
            const out = run(interp(), `cloud app deployment ${action} ${source}`, cloud);
            assert.equal(out.exitCode, 1);
            assert.equal(out.stderr, "Error: Cloud deployment enqueue/apply is unsupported; use `obelisk cloud app deploy` to upload and activate a deployment, or `obelisk cloud app apply` to apply configuration with the active deployment\n");
            assert.deepEqual(cloud.calls, []);
            assert.deepEqual(cloud.deploys, []);
            assert.deepEqual(cloud.runs, []);
        }
    }
});

test("deployment active rejects malformed info", () => {
    const out = api(interp(), "deployment active", fakeCloud({ "GET /v1/info": { deployment_id: "Dep_1" } }));
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /Invalid ServerInfoResponse/);
});

test("deployment list prints a table", () => {
    const cloud = fakeCloud({
        "GET /v1/deployments": [{ deployment_id: "Dep_1", status: "active", description: "first", created_at: "2026-01-01T00:00:00.123Z", last_active_at: null }],
    });
    assert.equal(api(interp(), "deployment list", cloud).stderr,
        `${"ID".padEnd(32)}  ${"STATUS".padEnd(12)}  DESCRIPTION\n${"Dep_1".padEnd(32)}  ${"Active".padEnd(12)}  first\n`);
    assert.match(run(interp(), "cloud app deployment list --app demo --verbose", cloud).stderr, /2026-01-01 00:00:00 {2}/);
    assert.equal(api(interp(), "deployment list", fakeCloud({ "GET /v1/deployments": [] })).stderr, "No deployments found.\n");
});

test("deployment show prints the manifest, one file, or JSON", () => {
    const cloud = fakeCloud({
        "GET /v1/deployments/Dep_1?include_generated_metadata=true": { deployment_toml: 'a = "b"\n', files: [{ path: "src/a.js", digest: "sha256:1", size: 1 }] },
        "GET /v1/files/sha256:1": { status: 200, body: "x" },
    });
    assert.equal(api(interp(), "deployment show Dep_1", cloud).stdout, 'a = "b"\n');
    assert.equal(api(interp(), "deployment show Dep_1 ./src/a.js", cloud).stdout, "x");
    assert.equal(api(interp(), "deployment show Dep_1 --json", cloud).stdout, '{\n  "a": "b"\n}\n');
    assert.equal(api(interp(), "deployment show Dep_1 b.js", cloud).stderr, "Error: deployment Dep_1 has no deployment-owned source file `b.js`\n");
});

test("deployment pull writes the manifest, loads sources on demand, and refuses to overwrite", () => {
    const cloud = fakeCloud({
        "GET /v1/deployments/Dep_1?include_generated_metadata=false": {
            deployment_toml: '[[activity_js]]\nlocation = "src/run.js"\n', files: [{ path: "src/run.js", digest: "sha256:old", size: 3 }],
        },
        "GET /v1/files/sha256:old": { status: 200, body: "old" },
    });
    const i = interp();
    let out = api(i, "deployment pull Dep_1 -o checkout", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stderr, 'Wrote checkout/deployment.toml (1 source file) for deployment Dep_1\n');
    assert.equal(cloud.calls.length, 1);
    assert.equal(i.vfs.readFile("/workspace/checkout/src/run.js"), "old");
    assert.equal(cloud.calls.at(-1).path, "/v1/files/sha256:old");

    out = api(i, "deployment pull Dep_1 -o checkout", cloud);
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /^Error: cannot open "checkout\/deployment.toml" for writing, try using `--force`/);
    assert.equal(api(i, "deployment pull Dep_1 -o checkout --force", cloud).exitCode, 0);
});

test("a pulled, edited deployment resubmits with only the edited file", () => {
    const cloud = fakeCloud({
        "GET /v1/deployments/Dep_1?include_generated_metadata=false": {
            deployment_toml: '[[activity_wasm]]\nlocation = "run.wasm"\n[[activity_wasm]]\nlocation = "other.wasm"\n',
            files: [{ path: "run.wasm", digest: sha256("old"), size: 3 }, { path: "other.wasm", digest: sha256("other"), size: 5 }],
        },
        "PUT /v1/deployments/*": { status: 201, body: "" },
    });
    const i = interp();
    assert.equal(api(i, "deployment pull Dep_1", cloud).exitCode, 0);
    i.vfs.writeFile("/workspace/run.wasm", "new");
    const out = api(i, "deployment submit", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    const toml = JSON.parse(cloud.calls.at(-1).body).deployment_toml;
    assert.ok(toml.includes(`content_digest = "${sha256("new")}"`), toml);
    assert.ok(toml.includes(`content_digest = "${sha256("other")}"`), toml);
    assert.ok(!cloud.calls.some((call) => call.path.startsWith("/v1/files/")));
});

test("deployment submit rehashes a pending file with a foreign digest", () => {
    // A file copied unmodified from a git mount keeps the remote's SHA-1, which is not a CAS digest.
    const gitSha = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3";
    const i = interp();
    i.vfs.setBlobLoader((digest) => (digest === gitSha ? "test" : null));
    i.vfs.writeFile("/workspace/deployment.toml", '[[workflow_js]]\nlocation = "a.js"\n');
    i.vfs.registerLazy("/workspace/a.js", gitSha, 4);
    const cloud = fakeCloud({ "PUT /v1/deployments/*": { status: 201, body: "" } });
    assert.equal(api(i, "deployment submit", cloud).exitCode, 0);
    assert.ok(JSON.parse(cloud.calls.at(-1).body).deployment_toml.includes(sha256("test")));
});

test("deployment submit generates WIT and JS module component files", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/deployment.toml", '[[activity_js]]\nname = "multi"\nffqn = "test:pkg/api.run"\nwit = "wit"\nlocation = "src/index.js"\n');
    i.vfs.writeFile("/workspace/src/index.js", 'import { value } from "./lib.js"; export default () => value;');
    i.vfs.writeFile("/workspace/src/lib.js", "export const value = 1;");
    i.vfs.writeFile("/workspace/wit/world.wit", "package test:pkg; world api { export run: func(); }");
    i.vfs.writeFile("/workspace/wit/deps/dep/dep.wit", "package test:dep; interface unused {}");
    const cloud = fakeCloud({ "PUT /v1/deployments/*": { status: 201, body: "" } });
    const out = api(i, "deployment submit", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    const toml = JSON.parse(cloud.calls.at(-1).body).deployment_toml;
    for (const path of ["src/index.js", "src/lib.js", "wit/world.wit", "wit/deps/dep/dep.wit"]) {
        assert.ok(toml.includes(`"${path}" = "sha256:`), toml);
    }
});

test("deployment submit does not mistake a later comment for an export...from clause", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/deployment.toml", '[[activity_js]]\nname = "chat"\nlocation = "src/index.js"\n');
    i.vfs.writeFile("/workspace/src/index.js", [
        "export default async function chat(stdin, args) {",
        "    return stdin;",
        "}",
        "// Empty when it is still working, so callers can tell apart",
        '// from "it finished with an empty message".',
    ].join("\n"));
    const cloud = fakeCloud({ "PUT /v1/deployments/*": { status: 201, body: "" } });
    const out = api(i, "deployment submit", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
});

// -- admin --

test("admin retention parses the age and reports the counts", () => {
    const cloud = fakeCloud({
        "POST /v1/admin/executions/retain": { deleted_execution_trees: 2, blocked_non_terminal: 1, has_more: false },
    });
    const out = api(interp(), "admin executions retain --max-age 2d --dry-run", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stderr, "2 execution tree(s) would delete; 1 blocked; has_more=false\n");
    assert.deepEqual(JSON.parse(cloud.calls[0].body), {
        retain_count: null, max_age_seconds: 172800, batch_size: 100, force_non_terminal: false, dry_run: true,
    });
    assert.match(api(interp(), "admin executions retain --max-age 2", cloud).stderr, /duration must have a unit: s, m, h, or d/);
    assert.equal(api(interp(), "admin executions retain", cloud).exitCode, 2);
});

test("admin deployments delete and node-run-id", () => {
    const cloud = fakeCloud({
        "DELETE /v1/admin/deployments/Dep_1?delete_executions=true&force_non_terminal=false": { deleted: true, deleted_execution_trees: 3 },
        "GET /v1/info": serverInfo({ node_run_id: "Run_1" }),
    });
    const out = api(interp(), "admin deployments delete Dep_1 --delete-executions", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stderr, "Deleting deployment Dep_1\nDep_1: deleted (3 execution tree(s) deleted)\n");
    assert.equal(api(interp(), "admin node-run-id", cloud).stdout, "Run_1\n");
    assert.equal(api(interp(), "admin node-run-id --json", cloud).stdout, '"Run_1"\n');
});

// -- generate --

test("generate deployment prints the embedded template", () => {
    const out = run(interp(), "generate deployment", null);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /\[\[activity_wasm\]\]/);
    assert.ok(out.stdout.endsWith("\n"));
});

// A fake `obelisk-agent:mounts/apps.request` serving a two-level template tree at `ref`.
function templateSource(obeliskVersion = "v0.42.0", ref = obeliskVersion) {
    const bodies = {
        "examples/templates": JSON.stringify([
            { name: "minimal", type: "dir" },
            { name: "url-health-dashboard", type: "dir" },
        ]),
        "examples/templates/minimal": JSON.stringify([
            { name: "app.toml", type: "file" },
            { name: "README.md", type: "file" },
            { name: "workflow", type: "dir" },
        ]),
        "examples/templates/minimal/workflow": JSON.stringify([{ name: "run.js", type: "file" }]),
        "examples/templates/minimal/app.toml": 'app_name = "__APP_NAME__"\n',
        "examples/templates/minimal/workflow/run.js": "42\n",
    };
    const calls = [];
    const githubContents = (method, paramsJson) => {
        calls.push([method, paramsJson]);
        const params = JSON.parse(paramsJson);
        const body = params.ref === ref ? bodies[params.path] : undefined;
        if (body === undefined) throw `404 Not Found: ${params.path}`;
        return body;
    };
    return { calls, generate: { obeliskVersion, githubContents } };
}

function generate(i, args, source = templateSource()) {
    return executeObelisk(i, typeof args === "string" ? words(args) : args, "", source.generate, null);
}

test("generate new fetches the chosen template at OBELISK_VERSION", () => {
    const i = interp("/workspace/My Cool_App");
    const source = templateSource();
    let out = generate(i, "generate new --template minimal", source);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(
        out.stdout,
        'Generated "/workspace/My Cool_App/app.toml"\nGenerated "/workspace/My Cool_App/workflow/run.js"\nGenerated "/workspace/My Cool_App/README.md"\n',
    );
    const generated = /using generated app name `([a-z]+-[a-z]+)`\n$/.exec(out.stderr)[1];
    assert.match(i.vfs.readFile("/workspace/My Cool_App/README.md"), new RegExp(`^# ${generated}\n[^]*obelisk cloud app deploy\n`));
    assert.equal(i.vfs.readFile("/workspace/My Cool_App/app.toml"), `app_name = "${generated}"\n`);
    assert.equal(i.vfs.readFile("/workspace/My Cool_App/workflow/run.js"), "42\n");
    assert.deepEqual(source.calls[3], [
        "read",
        '{"owner":"obeli-sk","repo":"obelisk","ref":"v0.42.0","path":"examples/templates/minimal/workflow/run.js"}',
    ]);

    // A second run must not overwrite anything.
    out = generate(i, "generate new --template minimal");
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /already exists/);

    out = generate(i, "generate new --template minimal chosen-app");
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(i.vfs.isFile("/workspace/My Cool_App/chosen-app/workflow/run.js"), true);

    out = generate(i, ["generate", "new", "--template", "minimal", "Bad Name"]);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.match(out.stderr, /invalid app name `Bad Name`.*using generated app name/);
    assert.match(i.vfs.readFile("/workspace/My Cool_App/Bad Name/app.toml"), /^app_name = "[a-z]+-[a-z]+"\n$/);
});

test("generate new requires --template and lists the available ones", () => {
    const out = generate(interp("/workspace/app"), "generate new");
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /--template is required; templates at obeli-sk\/obelisk@v0\.42\.0: minimal, url-health-dashboard/);
    const help = generate(interp("/workspace/app"), "generate new -h");
    assert.match(help.stdout, /--template <TEMPLATE>  \[possible values: minimal, url-health-dashboard\]\n/);
});

test("generate new falls back to main when OBELISK_VERSION has no such template", () => {
    for (const version of ["v0.43.0-rc.6", "latest"]) {
        const i = interp("/workspace/app");
        const out = generate(i, "generate new --template minimal", templateSource(version, "main"));
        assert.equal(out.exitCode, 0, out.stderr);
        assert.equal(i.vfs.readFile("/workspace/app/workflow/run.js"), "42\n");
    }
    const out = generate(interp("/workspace/app"), "generate new --template bogus");
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /@v0\.42\.0:examples\/templates\/bogus: 404 Not Found.*@main:examples\/templates\/bogus: 404/);
});

test("generate requires a known subcommand", () => {
    assert.match(generate(interp(), "generate").stdout, /Usage: obelisk generate/);
    const out = generate(interp(), "generate bogus");
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /unrecognized subcommand 'bogus'/);
});

// -- TOML editor --

test("manifestWithDigests pins each owned location and skips oci:// and missing files", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/w.js", "w");
    const manifest = [
        "[[workflow_js]]",
        'location = "w.js"',
        "[workflow_js.backtrace.sources]",
        '"/abs/w.js" = "w.js"',
        "[[activity_wasm]]",
        'location = "oci://example/a:1"',
        "[[activity_js]]",
        'location = "missing.js"',
        "",
    ].join("\n");
    assert.equal(manifestWithDigests(i.vfs, "/workspace", manifest), manifest.replace('location = "w.js"\n', `location = "w.js"\ncontent_digest = "${sha256("w")}"\n`));
});

test("the TOML editor preserves every unrelated byte", () => {
    const fixture = [
        "## Top-of-file comment block, must survive untouched.",
        "",
        "[[activity_js]]",
        'name = "program_curl"',
        'location = "activity/curl.js"',
        "# a per-component comment",
        'env_vars = ["ENV1", {key = "ENV2", value = "literal"}]',
        "",
        "[[activity_js.allowed_host]]",
        'pattern = "api.github.com"',
        'methods = "*"',
        "",
        "[[webhook_endpoint_js]]",
        'name = "ui"',
        'location = "webhook/ui-api.js"',
        "[webhook_endpoint_js.backtrace.sources]",
        '"/abs/ui.js" = "webhook/ui.js"',
        "",
        "## Trailing file comment.",
        "",
    ].join("\n");
    const i = interp();
    i.vfs.writeFile("/workspace/activity/curl.js", "curl");
    i.vfs.writeFile("/workspace/webhook/ui-api.js", 'import "./ui.js";');
    i.vfs.writeFile("/workspace/webhook/ui.js", "ui");
    const prepared = manifestWithDigests(i.vfs, "/workspace", manifestWithGeneratedFiles(i.vfs, "/workspace", fixture));
    const files = `component_files = { "webhook/ui-api.js" = "${sha256('import "./ui.js";')}", "webhook/ui.js" = "${sha256("ui")}" }`;
    assert.equal(prepared, fixture
        .replace('env_vars = ["ENV1", {key = "ENV2", value = "literal"}]\n', `$&content_digest = "${sha256("curl")}"\n`)
        .replace('location = "webhook/ui-api.js"\n', `$&${files}\ncontent_digest = "${sha256('import "./ui.js";')}"\n`));
});
