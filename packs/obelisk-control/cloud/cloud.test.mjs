import assert from "node:assert/strict";
import test from "node:test";

const { default: run } = await import("./cli.js");
const { default: prepareDeploy } = await import("./deploy.js");
const { default: tenant } = await import("./tenant.js");
const { appConfig } = await import("./policy.js");

const POLICY = `app_name = "demo"
[secrets]
API_KEY = {}
EXTRA = { optional = true }
[public_env]
MODE = {}
`;

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
    const stopped = await run(["app", "--app", "demo", "stop", "--command-id", "E_cmd"], "", null);
    assert.equal(stopped.exit_code, 1);
    assert.equal(stopped.stderr, "obelisk: app is busy (HTTP 409). Command ID: E_cmd\n");

    const flagged = await run(["apps", "list", "--api-token", "x"], "", null);
    assert.equal(flagged.exit_code, 1);
    assert.match(flagged.stderr, /OBELISK_CLOUD_API_TOKEN/);
});

// The single-app cloud: no cloud token, so the TARGET_OBELISK_* server is the one fixed app.
function singleTarget(appName = "solo") {
    delete process.env.OBELISK_CLOUD_API_TOKEN;
    process.env.TARGET_OBELISK_API_URL = "http://target.test:5005";
    process.env.TARGET_OBELISK_TOKEN = "target-token";
    delete process.env.TARGET_OBELISK_WEBHOOK_URL;
    const requests = [];
    globalThis.fetch = async (url, init = {}) => {
        const { pathname } = new URL(url);
        requests.push({ url, method: init.method ?? "GET", headers: init.headers ?? {} });
        if (pathname === "/v1/info") return Response.json(appName === null ? {} : { app_name: appName });
        if (pathname === "/v1/deployment-id") return new Response('"Dep_1"');
        return new Response(`no route ${pathname}`, { status: 404 });
    };
    return requests;
}

test("the single-app cloud lists the target as its only app and refuses lifecycle commands", async () => {
    singleTarget();
    const listed = await run(["apps", "list", "--json"], "", null);
    assert.equal(listed.exit_code, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout), {
        apps: [{ app_name: "solo", status: "running", api_url: "http://target.test:5005", webhook_url: null }],
    });

    const status = await run(["app", "status", "--json"], "", 'app_name = "solo"\nunknown_field = 1\n');
    assert.equal(status.exit_code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).api_ready, true);

    const other = await run(["app", "--app", "other", "get"], "", null);
    assert.equal(other.exit_code, 1);
    assert.match(other.stderr, /single app, solo; there is no app other\. Use --app solo/);

    for (const args of [["app", "--app", "solo", "delete"], ["app", "new"], ["app", "env", "set", "A", "b"]]) {
        const refused = await run(args, "", null);
        assert.equal(refused.exit_code, 1);
        assert.match(refused.stderr, /is not available: this cloud has a single fixed app \(solo\)/);
    }
});

test("the single-app cloud deploys and proxies to the target without a policy", async () => {
    const requests = singleTarget(null);
    const target = await prepareDeploy("target", "");
    assert.equal(target.api_url, "http://target.test:5005");
    assert.match(target.log, /App target has a fixed policy; skipping provisioning\./);
    await assert.rejects(prepareDeploy("other", ""), /single app, target/);

    const current = JSON.parse(await tenant("target", "current-deployment-id", "[]"));
    assert.deepEqual(current, { ok: '"Dep_1"' });
    assert.equal(requests.at(-1).headers.authorization, "Bearer target-token");
    await assert.rejects(tenant("other", "current-deployment-id", "[]"), /single app, target/);
});
