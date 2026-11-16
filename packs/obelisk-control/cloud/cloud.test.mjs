import { serverInfo } from "../../../shared/obelisk-api-fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";

const { default: run } = await import("./cli.js");
const { default: prepareDeploy } = await import("./deploy.js");
const { default: finishDeploy } = await import("./finish-deploy.js");
const { default: tenant } = await import("./tenant.js");
const { default: tenantRead } = await import("./tenant-read.js");
const { default: command } = await import("./command.js");
const { default: create } = await import("./create.js");
const { default: upload } = await import("./upload.js");
const { default: read } = await import("./read.js");
const { appConfig } = await import("./policy.js");

const POLICY = `app_name = "demo"
[secrets]
API_KEY = {}
EXTRA = { optional = true }
[public_env]
MODE = {}
SELF_API = { type = "internal", source = "api-url" }
BROWSER_UI = { type = "internal", source = "webui-url" }
`;
// POLICY without the required secret, which only the user sets.
const ENV_POLICY = POLICY.replace("API_KEY = {}\n", "");

test("app policy preserves internal environment sources and rejects optional", () => {
    assert.deepEqual(appConfig(POLICY).policy.public_env, [
        { name: "BROWSER_UI", type: "internal", source: "webui-url" },
        "MODE",
        { name: "SELF_API", type: "internal", source: "api-url" },
    ]);
    for (const optional of [true, false]) {
        assert.throws(() => appConfig(POLICY.replace('source = "api-url"', `source = "api-url", optional = ${optional}`)), /unknown field/);
    }
    assert.throws(() => appConfig(POLICY.replace('source = "api-url"', 'source = "unknown"')), /source must be/);
});

test("app policy accepts url_prefix rules in the server's stored shape", () => {
    const hosts = `app_name = "demo"
[[outbound_http.allowed_host]]
url_prefix = "https://example.com/api/"
url_regex_suffix = "/v1/x$"
methods = ["GET"]
[[outbound_http.allowed_host]]
url_prefix = "https://example.org"
[[outbound_http.allowed_host]]
pattern = "https://*.example.net"
request_url_regex = "^GET https://a\\\\.example\\\\.net/"
`;
    assert.deepEqual(appConfig(hosts).policy.outbound_http, [
        { url_prefix: "https://example.com/api/", url_regex_suffix: "/v1/x$", methods: ["GET"], request_url_regex: null, secrets: [], replace_in: [] },
        { url_prefix: "https://example.org", methods: null, request_url_regex: null, secrets: [], replace_in: [] },
        { pattern: "https://*.example.net", methods: null, request_url_regex: "^GET https://a\\.example\\.net/", secrets: [], replace_in: [] },
    ]);
    assert.throws(() => appConfig(`app_name = "demo"\n[[outbound_http.allowed_host]]\nurl_prefix = "https://a.b"\npattern = "https://a.b"\n`), /cannot be combined/);
    assert.throws(() => appConfig(`app_name = "demo"\n[[outbound_http.allowed_host]]\npattern = "https://a.b"\nurl_regex_suffix = "/x"\n`), /requires url_prefix/);
});

const APP_API = "https://api--demo.obelisk.works";

// A fake provisioner: `routes` maps "METHOD /path" to a response body, or a function of the request.
function provisioner(routes) {
    // The provisioner API lives under `/api` behind app-proxy.
    process.env.OBELISK_CLOUD_API_URL = "https://cloud.test/api/";
    process.env.OBELISK_CLOUD_API_TOKEN = "cloud-token";
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
        const { origin, search } = new URL(url);
        let { pathname } = new URL(url);
        if (origin === "https://cloud.test") {
            assert.ok(pathname.startsWith("/api/"), pathname);
            pathname = pathname.slice("/api".length);
        }
        const request = { url, origin, path: pathname + search, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body };
        requests.push(request);
        const key = `${request.method} ${origin === "https://cloud.test" ? "" : origin}${pathname}`;
        const route = routes[key];
        if (route === undefined) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 404 });
        const value = typeof route === "function" ? route(request) : route;
        if (value instanceof Response) return value;
        return new Response(JSON.stringify(value), { status: 200 });
    };
    return requests;
}

function appRow(overrides = {}) {
    const config = appConfig(POLICY);
    return {
        app_name: "demo",
        status: "running",
        revision: 1,
        applied_revision: 1,
        hostname: "demo.obelisk.works",
        endpoints: { api: `${APP_API}/`, webui: "https://webui--demo.obelisk.works", internal: "https://internal--demo.obelisk.works" },
        policy: config.policy,
        cloud: config.cloud,
        ...overrides,
    };
}

// A draft view as the provisioner returns it: by default `default`, revision 2 over applied revision 1, app.toml changed.
function draftView(overrides = {}) {
    const config = appConfig(POLICY);
    const empty = { added: [], removed: [], changed: [] };
    return {
        key: "default", draft_id: "D_1", parent_revision: 1, revision: 2, applied_revision: 1, stale: false,
        app_toml: POLICY, policy: config.policy, cloud: config.cloud,
        env: { MODE: "prod" }, secrets: ["API_KEY"],
        summary: { changed: true, app_toml: true, policy: false, cloud: false, env: empty, secrets: empty },
        values: { missing_env: [], missing_secrets: [], unused_env: [], unused_secrets: [] },
        ...overrides,
    };
}

const deploy = (app, policy, { draft = "deploy-x", env = [], fill = false, exported = [] } = {}) =>
    prepareDeploy(app, policy, draft, env, fill, exported);

const calls = (requests) => requests.map((request) => `${request.method} ${request.path}`);

// Routes for staging into `deploy-x` of a missing app: the config arrives without env, and each
// env PUT adds its value.
function createdApp(policy, routes = {}) {
    const config = appConfig(policy);
    const staged = draftView({ key: "deploy-x", app_toml: policy, policy: config.policy, cloud: config.cloud, env: {}, secrets: [] });
    return provisioner({
        "POST /v1/apps/demo/drafts/deploy-x": staged,
        "PUT /v1/apps/demo/drafts/deploy-x/config": staged,
        ...routes,
    });
}

test("deploy preparation stages explicit and filled values on an existing app", async () => {
    const policy = 'app_name = "demo"\n[secrets]\nEXTRA = { optional = true }\n';
    const requests = createdApp(policy);
    const target = await deploy("", policy);
    assert.deepEqual(target, {
        log: "→ obelisk cloud app stage --draft deploy-x\n",
    });
    assert.deepEqual(calls(requests), [
        "POST /v1/apps/demo/drafts/deploy-x", "PUT /v1/apps/demo/drafts/deploy-x/config",
    ]);
    assert.equal(requests.at(-1).body, policy);

    const withMode = (request) => draftView({ key: "deploy-x", env: { MODE: JSON.parse(request.body).value } });
    // A fill reads env only, never the optional secret's same-named variable.
    const filled = createdApp(ENV_POLICY, { "PUT /v1/apps/demo/drafts/deploy-x/env/MODE": withMode });
    await deploy("", ENV_POLICY, { fill: true, exported: [["MODE", "dev"], ["EXTRA", "e"]] });
    const env = (requests) => requests.filter((request) => request.path.includes("/env/") || request.path.includes("/secrets/"))
        .map((request) => [request.path, JSON.parse(request.body)]);
    assert.deepEqual(env(filled), [["/v1/apps/demo/drafts/deploy-x/env/MODE", { value: "dev" }]]);
    const values = createdApp(ENV_POLICY, { "PUT /v1/apps/demo/drafts/deploy-x/env/MODE": withMode });
    await deploy("", ENV_POLICY, { env: ["MODE"], exported: [["MODE", "dev"]] });
    assert.deepEqual(env(values), [["/v1/apps/demo/drafts/deploy-x/env/MODE", { value: "dev" }]]);
    await assert.rejects(deploy("", ENV_POLICY, { env: ["MODE"] }), /Error: Environment variable MODE is missing/);
});

test("deploy stages cloud integrations and does not require the env they supply", async () => {
    const policy = 'app_name = "demo"\n[cloud.integrations]\nllm = { type = "llm", env = "LLM_BASE_URL" }\n[public_env]\nLLM_BASE_URL = {}\n';
    const requests = createdApp(policy);
    await deploy("", policy);
    assert.equal(requests.find((request) => request.path.endsWith("/config")).body, policy);
    assert.ok(!requests.some((request) => request.path.includes("/env/")));
    assert.throws(() => appConfig('app_name = "demo"\n[cloud.integrations]\nllm = { type = "llm", env = "MISSING" }\n'), /environment-backed/);
});

test("deploy preserves browser integration settings and skips its supplied URL", async () => {
    const policy = 'app_name = "demo"\n[cloud]\nmemory_mb = 512\n[cloud.integrations.browser]\ntype = "browser"\nenv = "BROWSER_URL"\nallowed_hosts = ["https://app.example.com"]\nmax_sessions = 1\nsession_memory_mb = 128\nmax_ttl = "30m"\n[public_env]\nBROWSER_URL = { optional = true }\n';
    assert.deepEqual(appConfig(policy).cloud.integrations.browser, {
        type: "browser", env: "BROWSER_URL", allowed_hosts: ["https://app.example.com"],
        max_sessions: 1, session_memory_mb: 128, max_ttl: "30m",
    });
    const requests = createdApp(policy);
    await deploy("", policy);
    assert.equal(requests.find((request) => request.path.endsWith("/config")).body, policy);
    assert.ok(!requests.some((request) => request.path.includes("/env/")));
});

test("deploy creates its own draft and stages config and values", async () => {
    const staged = draftView({ key: "deploy-x", env: {} });
    const requests = provisioner({
        "GET /v1/apps/demo": appRow({ status: "stopped" }),
        "POST /v1/apps/demo/drafts/deploy-x": draftView({ key: "deploy-x", summary: { changed: false } }),
        "PUT /v1/apps/demo/drafts/deploy-x/config": { ...staged, values: { ...staged.values, missing_env: ["MODE"] } },
        "PUT /v1/apps/demo/drafts/deploy-x/env/MODE": { ...staged, env: { MODE: "prod" } },
    });
    const target = await deploy("demo", POLICY, { env: ["MODE=prod"], fill: true, exported: [["API_KEY", "k"]] });
    assert.deepEqual(target, {
        log: "→ obelisk cloud app stage --draft deploy-x\n→ obelisk cloud app fill\n",
    });
    assert.deepEqual(calls(requests), [
        "POST /v1/apps/demo/drafts/deploy-x", "PUT /v1/apps/demo/drafts/deploy-x/config",
        "PUT /v1/apps/demo/drafts/deploy-x/env/MODE",
    ]);
    const [stage, env] = requests.filter((request) => request.method === "PUT");
    assert.equal(stage.headers["content-type"], "application/toml");
    assert.equal(stage.body, POLICY);
    assert.deepEqual(JSON.parse(env.body), { value: "prod" });
    assert.ok(!("idempotency-key" in env.headers));
});

test("deploy discards its draft when values are missing or the draft exists", async () => {
    const missing = draftView({ key: "deploy-x", values: { ...draftView().values, missing_secrets: ["API_KEY"] } });
    const requests = provisioner({
        "GET /v1/apps/demo": appRow(),
        "POST /v1/apps/demo/drafts/deploy-x": draftView({ key: "deploy-x" }),
        "PUT /v1/apps/demo/drafts/deploy-x/config": missing,
        "DELETE /v1/apps/demo/drafts/deploy-x": { discarded: true },
    });
    await assert.rejects(deploy("demo", POLICY), /\nError: App demo requires secret\(s\) API_KEY, which only the user sets\. Stage the app/);
    assert.equal(calls(requests).at(-1), "DELETE /v1/apps/demo/drafts/deploy-x");
    const taken = provisioner({
        "GET /v1/apps/demo": appRow(),
        "POST /v1/apps/demo/drafts/deploy-x": () => new Response(JSON.stringify({ error: "draft exists" }), { status: 409 }),
    });
    await assert.rejects(deploy("demo", POLICY), /draft exists/);
    assert.deepEqual(calls(taken), ["POST /v1/apps/demo/drafts/deploy-x"]);
});

const COMMAND = "E_01M7A0M1P2P2F1VNCPZ9S26DFJ";

test("finish-deploy stages the uploaded deployment in the draft, warns about other drafts and applies it", async () => {
    const staged = draftView({ key: "deploy-x", deployment_id: "Dep_1" });
    const requests = provisioner({
        "PUT /v1/apps/demo/drafts/deploy-x/deployment": staged,
        "GET /v1/apps/demo/drafts": { drafts: [staged, draftView({ summary: { ...staged.summary, app_toml: false, env: { added: ["X"] } } })], applied_revision: 1 },
        "GET /v1/apps/demo": appRow(),
        "POST /v1/apps/demo/apply": appRow({ outcome: { configuration: "applied", vm: "started" } }),
    });
    const deployed = await finishDeploy("demo", "Dep_1", "deploy-x", COMMAND);
    assert.equal(JSON.parse(deployed.app_json).endpoints.internal, "https://internal--demo.obelisk.works");
    assert.equal(deployed.log, "Draft `default` (env +X) will be discarded when this deploy is applied\n"
        + "Applying draft `deploy-x` revision 2 over revision 1: app.toml, deployment Dep_1\n"
        + "→ obelisk cloud app apply --draft deploy-x\nConfiguration applied. App started.\n");
    assert.deepEqual(calls(requests), [
        `GET /v1/commands/${COMMAND}`, "PUT /v1/apps/demo/drafts/deploy-x/deployment", "GET /v1/apps/demo/drafts",
        "GET /v1/apps/demo", "POST /v1/apps/demo/apply",
    ]);
    assert.deepEqual(JSON.parse(requests[1].body), { deployment_id: "Dep_1" });
    assert.deepEqual(JSON.parse(requests.at(-1).body), { force: false, draft: "deploy-x" });
    assert.equal(requests.at(-1).headers["idempotency-key"], COMMAND);
});

test("finish-deploy retried after its apply was accepted joins the apply", async () => {
    const requests = provisioner({
        [`GET /v1/commands/${COMMAND}`]: { status: "running" },
        "POST /v1/apps/demo/apply": appRow(),
    });
    await finishDeploy("demo", "Dep_1", "deploy-x", COMMAND);
    assert.deepEqual(calls(requests), [`GET /v1/commands/${COMMAND}`, "POST /v1/apps/demo/apply"]);
    assert.deepEqual(JSON.parse(requests[1].body), { force: false, draft: "deploy-x" });
});

test("finish-deploy discards the draft when the deployment cannot be staged", async () => {
    const requests = provisioner({
        "PUT /v1/apps/demo/drafts/deploy-x/deployment": () => new Response(JSON.stringify({ error: "unknown deployment" }), { status: 422 }),
        "DELETE /v1/apps/demo/drafts/deploy-x": { discarded: true },
    });
    await assert.rejects(finishDeploy("demo", "Dep_1", "deploy-x", COMMAND), /Error: unknown deployment \(HTTP 422\)/);
    assert.equal(calls(requests).at(-1), "DELETE /v1/apps/demo/drafts/deploy-x");
});

test("finish-deploy requires a running app and suggests a retry on failure", async () => {
    const accepted = { [`GET /v1/commands/${COMMAND}`]: { status: "running" } };
    provisioner({ ...accepted, "POST /v1/apps/demo/apply": appRow({ status: "stopped" }) });
    await assert.rejects(finishDeploy("demo", "Dep_1", "deploy-x", COMMAND), /\nError: App is "stopped"; inspect it with/);
    provisioner({ ...accepted, "POST /v1/apps/demo/apply": () => new Response(JSON.stringify({ error: "draft is stale" }), { status: 409 }) });
    await assert.rejects(finishDeploy("demo", "Dep_1", "deploy-x", COMMAND), /Error: Retry with `obelisk cloud app deploy --app demo`\n\nCaused by:\n {4}draft is stale/);
});

test("command sends one request with the shell's Idempotency-Key; only failures are errors", async () => {
    const requests = provisioner({
        "POST /v1/apps/demo/apply": () => new Response(JSON.stringify({ error: "draft is stale" }), { status: 409 }),
        "DELETE /v1/apps/demo": appRow(),
        "POST /v1/apps/demo/enable": () => new Response("upstream down", { status: 502 }),
    });
    const id = "E_01M7A0M1P2P2F1VNCPZ9S26DFJ";
    assert.deepEqual(await command("demo", "POST", ["apply"], '{"force":false}', id), { status: 409, body: '{"error":"draft is stale"}' });
    assert.equal(requests[0].headers["idempotency-key"], id);
    assert.equal(requests[0].headers["content-type"], "application/json");
    assert.equal(requests[0].body, '{"force":false}');
    assert.equal((await command("demo", "DELETE", [], null, id)).status, 200);
    assert.equal(requests[1].headers["content-type"], undefined);
    await assert.rejects(command("demo", "POST", ["enable"], null, id), /Cloud API returned 502: upstream down/);
    await assert.rejects(command("demo", "PUT", ["env"], null, id), /unsupported command method PUT/);
    await assert.rejects(command("Demo!", "POST", ["enable"], null, id));
});

test("read returns provisioner responses, including 404", async () => {
    const requests = provisioner({ "GET /v1/commands/E_1": appRow() });
    assert.equal((await read(["v1", "commands", "E_1"])).status, 200);
    assert.equal((await read(["v1", "apps", "demo", "drafts", "ci"])).status, 404);
    assert.equal(requests[0].headers["idempotency-key"], undefined);
    await assert.rejects(read(["internal", "x"]), /invalid provisioner path/);
});

test("creation retries a lost response with the same body and command ID", async () => {
    let accepted = false;
    let creations = 0;
    const requests = provisioner({ "POST /v1/apps": () => {
        if (!accepted) {
            accepted = true;
            creations++;
            throw new Error("connection lost after acceptance");
        }
        return appRow();
    } });
    const body = JSON.stringify({ app_toml: ENV_POLICY, env: { MODE: "prod" }, secrets: {} });
    await assert.rejects(create(body, COMMAND), /Cloud request failed/);
    const recovered = await create(body, COMMAND);
    assert.equal(recovered.status, 200);
    assert.equal(JSON.parse(recovered.body).app_name, "demo");
    assert.equal(creations, 1);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => [request.body, request.headers["idempotency-key"]]), [[body, COMMAND], [body, COMMAND]]);

    provisioner({ "POST /v1/apps": () => new Response('{"error":"busy"}', { status: 409 }) });
    assert.equal((await create(body, COMMAND)).status, 409);
    provisioner({ "POST /v1/apps": () => new Response("unavailable", { status: 503 }) });
    await assert.rejects(create(body, COMMAND), /503/);
});

test("cloud.run no longer creates apps", async () => {
    const requests = provisioner({});
    const result = await run(["app", "new", "--app", "demo"], "", ENV_POLICY, []);
    assert.equal(result.exit_code, 2);
    assert.equal(requests.length, 0);
});

test("app status, stage, unstage, env and secrets work on drafts", async () => {
    const stale = draftView({ key: "old", stale: true });
    const requests = provisioner({
        "GET /v1/apps/demo/status": { app: appRow({ revision: 3, applied_revision: 2 }), api_ready: true },
        "GET /v1/apps/demo": appRow({ revision: 3, applied_revision: 2 }),
        "GET /v1/apps/demo/drafts": { drafts: [draftView({ values: { missing_secrets: ["API_KEY"], unused_env: ["OLD"] } }), stale], applied_revision: 2 },
        "POST /v1/apps/demo/config/compare": { changes: ["/cloud/memory_mb"], revision: 3 },
        "PUT /v1/apps/demo/drafts/default/config": { ...draftView({ revision: 3 }), changed: false },
        "PUT /v1/apps/demo/drafts/ci/env/MODE": { ...draftView({ key: "ci", revision: 6 }), changed: true },
        "DELETE /v1/apps/demo/drafts/default/secrets/API_KEY": { ...draftView({ revision: 7 }), changed: true },
        "DELETE /v1/apps/demo/drafts/ci": { discarded: true },
    });
    const status = await run(["app", "status"], "", POLICY);
    assert.equal(status.exit_code, 0, status.stderr);
    assert.match(status.stderr, /Configuration: applied revision 2\nDraft `default`: revision 2: app\.toml\. Run `obelisk cloud app apply --app demo` to apply it\.\nMissing values: secret API_KEY\nNot declared in app\.toml: env OLD\nDraft `old`: opened on revision 1, superseded\n/);
    const staged = await run(["app", "stage", "-a", "app.toml"], "", POLICY);
    assert.match(staged.stderr, /^Configuration unchanged at staged revision 3\.\n/);
    const env = await run(["app", "env", "set", "MODE", "prod", "--draft", "ci"], "", POLICY);
    assert.equal(env.stderr, "Environment staged. Staged revision 6; run `obelisk cloud app apply --draft ci` to apply changes.\n");
    // Secret values come from the user, never through the agent.
    const before = requests.length;
    const set = await run(["app", "secrets", "set", "API_KEY"], "", POLICY);
    assert.equal(set.exit_code, 1);
    assert.match(set.stderr, /^Error: `secrets set` is not available here, secret values come only from the user: ask the user to set them with their own `obelisk cloud app secrets set` or in the dashboard/);
    assert.equal(requests.length, before);
    const secret = await run(["app", "secrets", "unset", "API_KEY"], "", POLICY);
    assert.equal(secret.exit_code, 0, secret.stderr);
    // Edits create or reuse the draft.
    assert.deepEqual(calls(requests).filter((call) => call.includes("/drafts/")), [
        "PUT /v1/apps/demo/drafts/default/config?create_or_reuse=true",
        "PUT /v1/apps/demo/drafts/ci/env/MODE?create_or_reuse=true",
        "DELETE /v1/apps/demo/drafts/default/secrets/API_KEY?create_or_reuse=true",
    ]);
    assert.equal((await run(["app", "unstage", "--draft", "ci"], "", POLICY)).stderr, "Draft `ci` discarded.\n");
    assert.equal((await run(["app", "unstage", "--draft", "gone"], "", POLICY)).exit_code, 1);
    assert.ok(!requests.some((request) => "idempotency-key" in request.headers));
});

test("app stage only edits the existing app's draft and records a staged deployment", async () => {
    const id = "Dep_01M7A0M1P2P2F1VNCPZ9S26DFJ";
    const missing = draftView({ revision: 2, deployment_id: id, values: { missing_env: ["MODE"], missing_secrets: ["API_KEY"], unused_env: [], unused_secrets: [] } });
    const requests = provisioner({
        "PUT /v1/apps/demo/drafts/default/config": { ...missing, deployment_id: undefined, changed: true },
        "PUT /v1/apps/demo/drafts/default/deployment": { ...missing, changed: true },
    });
    const staged = await run(["app", "stage", "-a", "app.toml", "-d", id], "", POLICY);
    assert.equal(staged.exit_code, 0, staged.stderr);
    assert.match(staged.stderr, /Set env with `obelisk cloud app env set --app demo`; for secrets, ask the user to set them with their own `obelisk cloud app secrets set` or in the dashboard, then run `obelisk cloud app apply`\n$/);
    assert.deepEqual(calls(requests), [
        "PUT /v1/apps/demo/drafts/default/config?create_or_reuse=true",
        "PUT /v1/apps/demo/drafts/default/deployment?create_or_reuse=true",
    ]);
    assert.equal(requests[0].body, POLICY);
    assert.deepEqual(JSON.parse(requests[1].body), { deployment_id: id });
    assert.ok(!calls(requests).some((call) => call.includes("/apply")));

    for (const args of [["-d", "nope"], ["--fill"], ["--force"]]) {
        provisioner({});
        assert.notEqual((await run(["app", "stage", "--app", "demo", ...args], "", POLICY)).exit_code, 0, args.join(" "));
    }
});

test("app status shows an idle-suspended app as resuming on request", async () => {
    const status = async (machine_state, api_ready) => {
        provisioner({ "GET /v1/apps/demo/status": { app: appRow(), machine_state, api_ready }, "GET /v1/apps/demo/drafts": { drafts: [] } });
        const result = await run(["app", "status"], "", POLICY);
        assert.equal(result.exit_code, 0, result.stderr);
        return result.stderr;
    };
    const suspended = await status("suspended", null);
    assert.match(suspended, /^demo: running \(suspended\)\n/);
    assert.match(suspended, /\nAPI: \S+ \(resumes on request\)\n/);
    assert.doesNotMatch(suspended, /reconcile/);
    const stopped = await status("stopped", false);
    assert.match(stopped, /^demo: running\n/);
    assert.match(stopped, /VM is stopped although the app is running\./);
    assert.match(stopped, /\nAPI: \S+ \(unavailable\)\n/);
});

test("app status shows health and a failing wake-up", async () => {
    provisioner({ "GET /v1/apps/demo/status": {
        app: appRow(), machine_state: "started", api_ready: false,
        health: { status: "critical", critical_since: 1762180000000 },
        wake_failure: { wake_at: 1762180000000, attempts: 3, retry_after: 1762180060000, error: "host unavailable" },
    }, "GET /v1/apps/demo/drafts": { drafts: [] } });
    const result = await run(["app", "status"], "", POLICY);
    assert.equal(result.exit_code, 0, result.stderr);
    assert.match(result.stderr, /\nAPI: \S+ \(unavailable\)\nWeb UI: https:\/\/webui--demo\.obelisk\.works\nInternal webhooks: https:\/\/internal--demo\.obelisk\.works\n/);
    assert.doesNotMatch(result.stderr, /External webhooks|URL:/);
    assert.match(result.stderr, /\nHealth: critical since 2025-11-03 14:26:40 UTC\n/);
    assert.match(result.stderr, /\nWake-up failing: 3 attempts since 2025-11-03 14:26:40 UTC, next retry at 2025-11-03 14:27:40 UTC\nWake-up error: host unavailable\n/);
    provisioner({ "GET /v1/apps/demo/status": { app: appRow(), machine_state: "suspended", api_ready: null, health: null, wake_failure: null }, "GET /v1/apps/demo/drafts": { drafts: [] } });
    const idle = await run(["app", "status"], "", POLICY);
    assert.doesNotMatch(idle.stderr, /Health|Wake-up/);
});

test("app events lists recent events newest first", async () => {
    const requests = provisioner({ "GET /v1/apps/demo/events": { events: [
        { event_id: 2, created_at: 1762180060000, level: "info", code: "machine.health.recovered", message: "Health check recovered after 60 s", details: null },
        { event_id: 1, created_at: 1762180000000, level: "warn", code: "machine.health.critical", message: "Health check is critical", details: {} },
    ] } });
    const result = await run(["app", "events", "--limit", "7"], "", POLICY);
    assert.equal(result.exit_code, 0, result.stderr);
    assert.equal(result.stderr,
        "2025-11-03 14:27:40 UTC  info   Health check recovered after 60 s  (machine.health.recovered)\n"
        + "2025-11-03 14:26:40 UTC  warn   Health check is critical  (machine.health.critical)\n");
    assert.equal(requests[0].path, "/v1/apps/demo/events?limit=7");
    await run(["app", "events"], "", POLICY);
    assert.equal(requests[1].path, "/v1/apps/demo/events?limit=5");
    assert.equal((await run(["app", "events", "-n", "51"], "", POLICY)).exit_code, 2);
    provisioner({ "GET /v1/apps/demo/events": { events: [] } });
    assert.equal((await run(["app", "events"], "", POLICY)).stderr, "No events.\n");
});

test("app commands never use another app's config", async () => {
    const requests = provisioner({ "GET /v1/apps/demo/status": { app: appRow(), api_ready: true }, "GET /v1/apps/demo/drafts": { drafts: [] } });
    const other = POLICY.replace('app_name = "demo"', 'app_name = "other"');
    for (const command of ["status", "stage"]) {
        const result = await run(["app", command, "--app", "demo", "-a", "app.toml"], "", other);
        assert.equal(result.exit_code, 1, command);
        assert.match(result.stderr, /app\.toml is for app `other`, but the selected app is `demo`/, command);
    }
    const staged = await run(["app", "stage", "--app", "demo"], "", other);
    assert.match(staged.stderr, /is for app `other`/);
    assert.equal(requests.length, 0);
    const status = await run(["app", "status", "--app", "demo"], "", other);
    assert.equal(status.exit_code, 0, status.stderr);
    assert.doesNotMatch(status.stderr, /app\.toml/);
});

test("uploads preserve the digest or deployment ID and body after a lost response", async () => {
    const file = `/v1/files/sha256:${"a".repeat(64)}`;
    const deployment = `/v1/deployments/Dep_01M7A0M1P2P2F1VNCPZ9S26DFJ`;
    const accepted = new Map();
    const respond = (request) => {
        if (!accepted.has(request.path)) {
            accepted.set(request.path, request.body);
            throw new Error("response lost after storage");
        }
        assert.equal(request.body, accepted.get(request.path));
        return new Response(null, { status: 204 });
    };
    const requests = provisioner({
        [`PUT ${APP_API}${file}`]: respond,
        [`PUT ${APP_API}${deployment}`]: respond,
    });
    for (const [path, contentType, body] of [[file, "application/octet-stream", "source bytes"], [deployment, "application/json", '{"deployment_toml":""}']]) {
        await assert.rejects(upload("demo", path, contentType, body), /error sending request/);
        assert.equal((await upload("demo", path, contentType, body)).status, 204);
    }
    assert.equal(accepted.size, 2);
    assert.equal(requests.length, 4);
    await assert.rejects(upload("demo", `${deployment}/switch`, null, "{}"), /unsupported upload path/);
    assert.equal(requests.length, 4);

    provisioner({ [`PUT ${APP_API}${deployment}`]: () => new Response('{"missing_files":[]}', { status: 409 }) });
    assert.equal((await upload("demo", deployment, "application/json", "{}")).status, 409);
    provisioner({ [`PUT ${APP_API}${file}`]: () => new Response("busy", { status: 503 }) });
    await assert.rejects(upload("demo", file, null, "source"), /503/);
});

test("tenant sends a request to the app API with the cloud token and returns any status", async () => {
    const requests = provisioner({
        [`PUT ${APP_API}/v1/deployments/Dep_1`]: () => new Response(JSON.stringify({ missing_files: [] }), { status: 409 }),
    });
    const response = await tenant("demo", "PUT", "/v1/deployments/Dep_1", "application/json", "{}");
    assert.deepEqual(response, { status: 409, body: '{"missing_files":[]}' });
    assert.equal(requests[0].url, `${APP_API}/v1/deployments/Dep_1`);
    assert.deepEqual(requests[0].headers, { accept: "application/json", authorization: "Bearer cloud-token", "content-type": "application/json" });
    assert.equal(requests[0].body, "{}");
    await assert.rejects(tenant("demo", "GET", "/v1/info", null, null), /use cloud.tenant-read/);
    await assert.rejects(tenant("demo", "PUT", "v1/x", null, null), /invalid app API path/);
});

test("run rejects credential flags and leaves lifecycle commands to the shell", async () => {
    provisioner({});
    assert.equal((await run(["app", "disable", "--app", "demo"], "", null)).exit_code, 2);

    const flagged = await run(["app", "list", "--api-token", "x"], "", null);
    assert.equal(flagged.exit_code, 1);
    assert.match(flagged.stderr, /OBELISK_CLOUD_API_TOKEN/);
});

test("the descriptor lists the cloud's apps, or leaves the cloud out without a token", async () => {
    const { default: describe } = await import("../descriptor.js");
    const savedDocs = process.env.DOCS_URLS_JSON;
    process.env.DOCS_URLS_JSON = "[]";
    try {
        provisioner({ "GET /v1/apps": { apps: [{ app_name: "demo", status: "running" }] } });
        const hosted = await describe();
        assert.match(hosted.prompt, /- demo: running/);
        assert.deepEqual(hosted.warnings, []);
        delete process.env.OBELISK_CLOUD_API_TOKEN;
        const none = await describe();
        assert.ok(!none.prompt.includes("- demo: running"));
        assert.match(none.warnings[0], /No cloud is configured/);
    } finally {
        if (savedDocs === undefined) delete process.env.DOCS_URLS_JSON;
        else process.env.DOCS_URLS_JSON = savedDocs;
    }
});

test("get and endpoint are not app subcommands", async () => {
    provisioner({});
    for (const action of ["get", "endpoint"]) {
        const result = await run(["app", action, "--app", "demo"], "", null);
        assert.equal(result.exit_code, 2, result.stderr);
    }
});

test("an invalid app_name in the config points at generate app-name", () => {
    assert.throws(() => appConfig('app_name = "Bad Name"\n', "x/app.toml"), (error) => error.includes("obelisk generate app-name -a x/app.toml"));
});

test("cloud auth status reports the configured token's state", async () => {
    const fetched = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response("[]", { status: 200 });
        const active = await run(["auth", "status", "--json"], "", null, null);
        const [account] = JSON.parse(active.stdout).accounts;
        assert.deepEqual([account.default, account.token_state], [true, "active"]);
        globalThis.fetch = async () => new Response("{}", { status: 401 });
        const rejected = await run(["auth", "status"], "", null, null);
        assert.match(rejected.stderr, /token state: rejected/);
        const login = await run(["auth", "login"], "", null, null);
        assert.equal(login.exit_code, 1);
        assert.match(login.stderr, /not available in the sandbox/);
    } finally {
        globalThis.fetch = fetched;
    }
});

test("tenant-read GETs a path on the app API", async () => {
    provisioner({ [`GET ${APP_API}/v1/info`]: serverInfo({ deployment_id: "Dep_1" }) });
    assert.deepEqual(await tenantRead("demo", "/v1/info"), { status: 200, body: JSON.stringify(serverInfo({ deployment_id: "Dep_1" })) });
    assert.equal((await tenantRead("demo", "/v1/missing")).status, 404);
});
