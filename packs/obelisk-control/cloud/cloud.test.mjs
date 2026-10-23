import assert from "node:assert/strict";
import test from "node:test";

const { default: run } = await import("./cli.js");
const { default: prepareDeploy } = await import("./deploy.js");
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
    const hosts = `
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
    assert.throws(() => appConfig(`[[outbound_http.allowed_host]]\nurl_prefix = "https://a.b"\npattern = "https://a.b"\n`), /cannot be combined/);
    assert.throws(() => appConfig(`[[outbound_http.allowed_host]]\npattern = "https://a.b"\nurl_regex_suffix = "/x"\n`), /requires url_prefix/);
});

const APP_API = "https://demo.obelisk.works:5005";

// A fake provisioner: `routes` maps "METHOD /path" to a response body, or a function of the request.
function provisioner(routes) {
    process.env.OBELISK_CLOUD_API_URL = "https://cloud.test/";
    process.env.OBELISK_CLOUD_API_TOKEN = "cloud-token";
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
        const { origin, pathname, search } = new URL(url);
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
        applied_revision: 1,
        api_url: `${APP_API}/`,
        webhook_url: "https://demo.obelisk.works",
        webui_url: "https://demo.obelisk.works:5006",
        policy: config.policy,
        cloud: config.cloud,
        ...overrides,
    };
}

test("deploy creates a missing app and stops at unset required configuration", async () => {
    const requests = provisioner({
        "POST /v1/apps": appRow({ applied_revision: 0 }),
        "GET /v1/apps/demo/env": { env: { MODE: "prod" } },
        "GET /v1/apps/demo/secrets": { secrets: [{ name: "EXTRA" }] },
    });
    await assert.rejects(prepareDeploy("", POLICY), (error) => {
        assert.match(error, /^Missing required configuration: secret API_KEY\. /);
        assert.match(error, /obelisk cloud app --app demo secrets set NAME --stdin/);
        return true;
    });
    const create = requests.find((request) => request.method === "POST");
    assert.equal(create.headers.authorization, "Bearer cloud-token");
    assert.match(create.headers["idempotency-key"], /^E_[0-9A-Z]{26}$/);
    assert.deepEqual(JSON.parse(create.body).policy, appConfig(POLICY).policy);
});

test("deploy keeps an unchanged config, starts a stopped app and returns its API origin", async () => {
    const requests = provisioner({
        "GET /v1/apps/demo": appRow({ status: "stopped" }),
        "GET /v1/apps/demo/env": { env: { MODE: "prod" } },
        "GET /v1/apps/demo/secrets": { secrets: [{ name: "API_KEY" }] },
        "POST /v1/apps/demo/start": appRow(),
    });
    const target = await prepareDeploy("demo", POLICY);
    assert.equal(target.api_url, APP_API);
    assert.equal(target.webhook_url, "https://demo.obelisk.works");
    assert.match(target.log, /^App configuration unchanged\.\nOptional configuration not set: secret EXTRA\n→ obelisk cloud app --app demo start  Starting VM\n/);
    assert.ok(!requests.some((request) => request.path === "/v1/apps/demo/config"));
});

test("tenant runs webapi tools against the app API with the cloud token", async () => {
    const requests = provisioner({
        "GET /v1/apps/demo": appRow(),
        [`GET ${APP_API}/v1/executions`]: [{ execution_id: "E_1" }],
        [`PUT ${APP_API}/v1/deployments/Dep_1`]: () =>
            new Response(JSON.stringify({ missing_files: [{ path: "a.wasm", digest: "sha256:aa" }] }), { status: 409 }),
    });
    const listed = JSON.parse(await tenant("demo", "list-executions", JSON.stringify(["", "", false, false, "", "", "", "", false, 5])));
    assert.ok("ok" in listed);
    const call = requests.find((request) => request.origin === APP_API);
    assert.equal(call.headers.authorization, "Bearer cloud-token");

    const submitted = JSON.parse(await tenant("demo", "deployment-submit", JSON.stringify(["[[x]]", [], "", false, "Dep_1"])));
    assert.deepEqual(submitted, { missing_files: [{ path: "a.wasm", digest: "sha256:aa" }] });
    await assert.rejects(tenant("demo", "toString", "[]"), /unknown app API operation/);
});

test("run reports provisioner errors with the command id and rejects credential flags", async () => {
    provisioner({
        "POST /v1/apps/demo/stop": () => new Response(JSON.stringify({ error: "app is busy" }), { status: 409 }),
    });
    const stopped = await run(["app", "--app", "demo", "deactivate", "--command-id", "E_cmd"], "", null);
    assert.equal(stopped.exit_code, 1);
    assert.equal(stopped.stderr, "obelisk: app is busy (HTTP 409). Command ID: E_cmd\n");

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

test("tenant-read runs reads and refuses operations that change the app", async () => {
    provisioner({
        "GET /v1/apps/demo": appRow(),
        [`GET ${APP_API}/v1/deployment-id`]: "Dep_1",
    });
    const current = JSON.parse(await tenantRead("demo", "current-deployment-id", "[]"));
    assert.deepEqual(current, { ok: '"Dep_1"' });
    await assert.rejects(tenantRead("demo", "apply-deployment", '["Dep_1"]'), /apply-deployment is not a read-only operation/);
});
