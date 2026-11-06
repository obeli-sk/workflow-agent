import { serverInfo } from "../../../shared/obelisk-api-fixtures.js";
import assert from "node:assert/strict";
import test from "node:test";

const { default: run } = await import("./cli.js");
const { default: prepareDeploy } = await import("./deploy.js");
const { default: finishDeploy } = await import("./finish-deploy.js");
const { default: tenant } = await import("./tenant.js");
const { default: tenantRead } = await import("./tenant-read.js");
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
        api_url: `${APP_API}/`,
        webhook_url: "https://demo.obelisk.works",
        webui_url: "https://demo.obelisk.works:5006",
        policy: config.policy,
        cloud: config.cloud,
        ...overrides,
    };
}

test("deploy refuses to create an app whose policy requires values", async () => {
    const requests = provisioner({});
    await assert.rejects(prepareDeploy("", POLICY), /^Deploying demo\nError: Missing required configuration: env MODE, secret API_KEY\. Retry with `--fill`/);
    assert.deepEqual(requests.map((request) => `${request.method} ${request.path}`), ["GET /v1/apps/demo"]);
});

test("deploy creates a missing app", async () => {
    const policy = 'app_name = "demo"\n[secrets]\nEXTRA = { optional = true }\n';
    const requests = provisioner({ "POST /v1/apps": appRow() });
    const target = await prepareDeploy("", policy);
    assert.deepEqual(target, { created: true, revision: 1, log: "Deploying demo\n→ obelisk cloud app new\n" });
    const create = requests.find((request) => request.method === "POST");
    assert.equal(create.headers.authorization, "Bearer cloud-token");
    assert.match(create.headers["idempotency-key"], /^E_[0-9A-Z]{26}$/);
    assert.deepEqual(JSON.parse(create.body), { app_toml: policy, env: {}, secrets: {} });
});

test("cloud app new accepts public servers and internal HTTP URLs without requesting environment values", async () => {
    const policy = `app_name = "demo"
public_http_servers = ["partner", "external", "external"]
[public_env]
INTERNAL_BASE_URL = { type = "internal", source = "http-server-url", http_server = "internal" }
`;
    const requests = provisioner({ "POST /v1/apps": appRow() });
    const result = await run(["app", "new"], "", policy);
    assert.equal(result.exit_code, 0, result.stderr);
    assert.deepEqual(JSON.parse(requests.find((request) => request.method === "POST").body), {
        app_toml: policy, env: {}, secrets: {},
    });
    const parsed = appConfig(policy).policy;
    assert.deepEqual(parsed.public_http_servers, ["external", "partner"]);
    assert.deepEqual(parsed.public_env, [
        { name: "INTERNAL_BASE_URL", type: "internal", source: "http-server-url", http_server: "internal" },
    ]);
    assert.ok(!("public_http_servers" in appConfig('app_name = "demo"\npublic_http_servers = []\n').policy));
});

test("cloud app new rejects reserved public listeners and malformed HTTP declarations before sending requests", async () => {
    const requests = provisioner({});
    for (const declaration of [
        'public_http_servers = ["internal"]',
        'public_http_servers = ["webui"]',
        'public_http_servers = "external"',
        'public_http_servers = [123]',
        '[public_env]\nURL = { type = "internal", source = "http-server-url" }',
        '[public_env]\nURL = { type = "internal", source = "api-url", http_server = "internal" }',
    ]) {
        const result = await run(["app", "new"], "", `app_name = "demo"\n${declaration}\n`);
        assert.equal(result.exit_code, 1, declaration);
        assert.match(result.stderr, /Invalid app config/);
    }
    assert.deepEqual(requests, []);
});

test("deploy sends cloud integrations and does not require the env they supply", async () => {
    const policy = 'app_name = "demo"\n[cloud.integrations]\nllm = { type = "llm", env = "LLM_BASE_URL" }\n[public_env]\nLLM_BASE_URL = {}\n';
    const requests = provisioner({ "POST /v1/apps": appRow() });
    await prepareDeploy("", policy);
    const body = JSON.parse(requests.find((request) => request.method === "POST").body);
    assert.deepEqual(body, { app_toml: policy, env: {}, secrets: {} });
    assert.throws(() => appConfig('app_name = "demo"\n[cloud.integrations]\nllm = { type = "llm", env = "MISSING" }\n'), /environment-backed/);
});

test("deploy stages the config of an existing app", async () => {
    const requests = provisioner({
        "GET /v1/apps/demo": appRow({ status: "stopped" }),
        "PUT /v1/apps/demo/config": appRow({ status: "stopped", revision: 2 }),
    });
    const target = await prepareDeploy("demo", POLICY);
    assert.deepEqual(target, { created: false, revision: 2, log: "Deploying demo\n→ obelisk cloud app stage\n" });
    const stage = requests.find((request) => request.method === "PUT");
    assert.equal(stage.headers["content-type"], "application/toml");
    assert.equal(stage.body, POLICY);
});

test("finish-deploy applies the staged revision with the uploaded deployment", async () => {
    const requests = provisioner({
        "GET /v1/apps/demo/env": { env: { MODE: "prod" } },
        "GET /v1/apps/demo/secrets": { secrets: [{ name: "API_KEY" }] },
        "POST /v1/apps/demo/apply": appRow({ outcome: { configuration: "applied", vm: "started" } }),
    });
    const deployed = await finishDeploy("demo", POLICY, "Dep_1", 2, false, null);
    assert.equal(JSON.parse(deployed.app_json).webhook_url, "https://demo.obelisk.works");
    assert.match(deployed.log, /^Optional configuration not set: secret EXTRA\. Run [^\n]*\n→ obelisk cloud app apply\n/);
    const apply = requests.find((request) => request.method === "POST");
    assert.deepEqual(JSON.parse(apply.body), { force: false, revision: 2, deployment_id: "Dep_1" });
    assert.ok(!requests.some((request) => request.path.endsWith("/start")));
});

test("finish-deploy stops at unset required configuration and requires a running app", async () => {
    let requests = provisioner({ "GET /v1/apps/demo/env": { env: {} }, "GET /v1/apps/demo/secrets": { secrets: [] } });
    await assert.rejects(finishDeploy("demo", POLICY, "Dep_1", 1, false, null), /^Error: Missing required configuration: env MODE, secret API_KEY\. /);
    assert.ok(!requests.some((request) => request.method === "POST"));
    provisioner({
        "GET /v1/apps/demo/env": { env: { MODE: "prod" } },
        "GET /v1/apps/demo/secrets": { secrets: [{ name: "API_KEY" }] },
        "POST /v1/apps/demo/apply": appRow({ status: "stopped" }),
    });
    await assert.rejects(finishDeploy("demo", POLICY, "Dep_1", 1, false, null), /\nError: App is "stopped"; inspect it with/);
});

test("app apply sends the staged revision with the app API's deployment id", async () => {
    const requests = provisioner({
        "GET /v1/apps/demo": appRow({ revision: 3 }),
        "GET /v1/apps/demo/env": { env: { MODE: "prod" } },
        "GET /v1/apps/demo/secrets": { secrets: [{ name: "API_KEY" }] },
        [`GET ${APP_API}/v1/info`]: serverInfo({ deployment_id: "Dep_active" }),
        "POST /v1/apps/demo/apply": appRow({ outcome: { configuration: "applied" } }),
    });
    const applied = await run(["app", "--app", "demo", "apply", "--force"], "", null);
    assert.equal(applied.exit_code, 0, applied.stderr);
    const apply = requests.find((request) => request.method === "POST");
    assert.deepEqual(JSON.parse(apply.body), { force: true, revision: 3, deployment_id: "Dep_active" });
    assert.equal(requests.find((request) => request.origin === APP_API).headers.authorization, "Bearer cloud-token");
});

test("app apply stops before mutation when server info is incomplete", async () => {
    const requests = provisioner({
        "GET /v1/apps/demo": appRow({ revision: 3 }),
        "GET /v1/apps/demo/env": { env: { MODE: "prod" } },
        "GET /v1/apps/demo/secrets": { secrets: [{ name: "API_KEY" }] },
        [`GET ${APP_API}/v1/info`]: { deployment_id: "Dep_active" },
    });
    const result = await run(["app", "--app", "demo", "apply"], "", null);
    assert.equal(result.exit_code, 1);
    assert.match(result.stderr, /Invalid ServerInfoResponse/);
    assert.ok(!requests.some(request => request.method === "POST"));
});

test("app apply refuses a local policy that the provisioner reports as differing unless --staged", async () => {
    const changed = POLICY.replace("MODE = {}", "MODE = {}\nOTHER = {}");
    const requests = provisioner({
        "GET /v1/apps/demo": appRow(),
        "POST /v1/apps/demo/config/compare": { policy: "differs", cloud: "equal", changes: ["/policy/public_env/2"], revision: 4 },
    });
    const refused = await run(["app", "apply"], "", changed);
    assert.equal(refused.exit_code, 1);
    assert.match(refused.stderr, /app\.toml differs from staged configuration revision 4: \/policy\/public_env\/2\nRun `obelisk cloud app --app demo stage -a app\.toml`/);
    assert.equal(requests.find((request) => request.path.endsWith("/compare")).body, changed);
    provisioner({
        "GET /v1/apps/demo": appRow(),
        "GET /v1/apps/demo/env": { env: { MODE: "prod" } },
        "GET /v1/apps/demo/secrets": { secrets: [{ name: "API_KEY" }] },
        [`GET ${APP_API}/v1/info`]: serverInfo({ deployment_id: "Dep_active" }),
        "POST /v1/apps/demo/apply": appRow(),
    });
    const staged = await run(["app", "apply", "--staged"], "", changed);
    assert.match((await run(["app", "apply", "-a", "app.toml", "--staged"], "", changed)).stderr, /cannot be used with/);
    assert.equal(staged.exit_code, 0, staged.stderr);
});

test("app apply with a matching ./app.toml applies the revision the provisioner compared against", async () => {
    const requests = provisioner({
        "GET /v1/apps/demo": appRow({ revision: 4 }),
        "POST /v1/apps/demo/config/compare": { policy: "equal", cloud: "equal", changes: [], revision: 5 },
        "GET /v1/apps/demo/env": { env: { MODE: "prod" } },
        "GET /v1/apps/demo/secrets": { secrets: [{ name: "API_KEY" }] },
        [`GET ${APP_API}/v1/info`]: serverInfo({ deployment_id: "Dep_active" }),
        "POST /v1/apps/demo/apply": appRow(),
    });
    const applied = await run(["app", "apply"], "", POLICY);
    assert.equal(applied.exit_code, 0, applied.stderr);
    const apply = requests.find((request) => request.path.endsWith("/apply"));
    assert.deepEqual(JSON.parse(apply.body), { force: false, revision: 5, deployment_id: "Dep_active" });
});

test("app status and stage report configuration revisions", async () => {
    provisioner({
        "GET /v1/apps/demo/status": { app: appRow({ revision: 3, applied_revision: 2 }), api_ready: true },
        "POST /v1/apps/demo/config/compare": { changes: ["/cloud/memory_mb"], revision: 3 },
        "PUT /v1/apps/demo/config": { ...appRow({ revision: 3 }), changed: false },
    });
    const status = await run(["app", "status"], "", POLICY);
    assert.equal(status.exit_code, 0, status.stderr);
    assert.match(status.stderr, /Configuration: staged revision 3, applied revision 2 \(apply pending\)\n/);
    assert.match(status.stderr, /app\.toml: differs from the staged configuration: \/cloud\/memory_mb\. Run `obelisk cloud app --app demo stage` to stage it\.\n/);
    const staged = await run(["app", "stage", "-a", "app.toml"], "", POLICY);
    assert.match(staged.stderr, /^Configuration unchanged at staged revision 3\.\n/);
});

test("app status shows an idle-suspended app as resuming on request", async () => {
    const status = async (machine_state, api_ready) => {
        provisioner({ "GET /v1/apps/demo/status": { app: appRow(), machine_state, api_ready } });
        const result = await run(["app", "status"], "", POLICY);
        assert.equal(result.exit_code, 0, result.stderr);
        return result.stderr;
    };
    const suspended = await status("suspended", null);
    assert.match(suspended, /^demo: running \(suspended\)\n/);
    assert.match(suspended, /\nAPI: resumes on request\n/);
    assert.doesNotMatch(suspended, /reconcile/);
    const stopped = await status("stopped", false);
    assert.match(stopped, /^demo: running\n/);
    assert.match(stopped, /VM is stopped although the app is running\./);
    assert.match(stopped, /\nAPI: unavailable\n/);
});

test("app status shows health and a failing wake-up", async () => {
    provisioner({ "GET /v1/apps/demo/status": {
        app: appRow(), machine_state: "started", api_ready: false,
        health: { status: "critical", critical_since: 1762180000000 },
        wake_failure: { wake_at: 1762180000000, attempts: 3, retry_after: 1762180060000, error: "host unavailable" },
    } });
    const result = await run(["app", "status"], "", POLICY);
    assert.equal(result.exit_code, 0, result.stderr);
    assert.match(result.stderr, /\nHealth: critical since 2025-11-03 14:26:40 UTC\n/);
    assert.match(result.stderr, /\nWake-up failing: 3 attempts since 2025-11-03 14:26:40 UTC, next retry at 2025-11-03 14:27:40 UTC\nWake-up error: host unavailable\n/);
    provisioner({ "GET /v1/apps/demo/status": { app: appRow(), machine_state: "suspended", api_ready: null, health: null, wake_failure: null } });
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
    const requests = provisioner({ "GET /v1/apps/demo/status": { app: appRow(), api_ready: true } });
    const other = POLICY.replace('app_name = "demo"', 'app_name = "other"');
    for (const command of ["new", "status", "stage", "apply", "fill"]) {
        const result = await run(["app", "--app", "demo", command, "-a", "app.toml"], "", other);
        assert.equal(result.exit_code, 1, command);
        assert.match(result.stderr, /app\.toml is for app `other`, but the selected app is `demo`/, command);
    }
    const staged = await run(["app", "--app", "demo", "stage"], "", other);
    assert.match(staged.stderr, /is for app `other`/);
    assert.equal(requests.length, 0);
    const status = await run(["app", "--app", "demo", "status"], "", other);
    assert.equal(status.exit_code, 0, status.stderr);
    assert.doesNotMatch(status.stderr, /app\.toml/);
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

test("run reports provisioner errors with the command id and rejects credential flags", async () => {
    provisioner({
        "POST /v1/apps/demo/disable": () => new Response(JSON.stringify({ error: "app is busy" }), { status: 409 }),
    });
    const stopped = await run(["app", "--app", "demo", "disable", "--command-id", "E_cmd"], "", null);
    assert.equal(stopped.exit_code, 1);
    assert.equal(stopped.stderr, "Error: app is busy (HTTP 409). Command ID: E_cmd\n");

    const flagged = await run(["apps", "list", "--api-token", "x"], "", null);
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

test("endpoint webhook prints the app's webhook URL", async () => {
    provisioner({ "GET /v1/apps/demo": appRow() });
    const endpoint = await run(["app", "--app", "demo", "endpoint", "webhook"], "", null);
    assert.equal(endpoint.exit_code, 0, endpoint.stderr);
    assert.equal(endpoint.stdout, "https://demo.obelisk.works\n");
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
