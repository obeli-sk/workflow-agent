import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "./fs.js";
import { Interpreter, OutputLog } from "./interpreter.js";
import { Bash } from "./bash.js";
import { sha256Hex } from "./commands/hash.js";
import { utf8Encode } from "./utf8.js";
import { executeObelisk, commandHandler, manifestWithDigests, manifestWithGeneratedFiles } from "./obelisk-pack.js";

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
        runs: [],
        deploys: [],
        get: (app, path) => respond(app, "GET", path, null, null),
        send: (app, method, path, contentType, body) => respond(app, method, path, contentType, body),
        run(args, stdin, appToml, fillEnv) {
            cloud.runs.push({ args, stdin, appToml, fillEnv });
            return { stdout: "ok\n", stderr: "", exitCode: 0 };
        },
        prepareDeploy(app, appToml, fillEnv) {
            cloud.deploys.push({ app, appToml, fillEnv });
            return { created: true, revision: 1, log: "→ prepare\n" };
        },
        finishDeploy(app, appToml, deploymentId, revision, created, fillEnv) {
            cloud.deploys.push({ app, deploymentId, revision, created, fillEnv });
            return { app: { name: app, webhook_url: "https://demo.test/hook", outcome: "applied" }, log: "→ finish\n" };
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

// `obelisk cloud app --app demo ...`
function api(i, args, cloud, stdin = "") {
    return run(i, ["cloud", "app", "--app", "demo", ...(typeof args === "string" ? words(args) : args)], cloud, stdin);
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

test("the app comes from --app anywhere, then exported OBELISK_APP_NAME, then ./app.toml", () => {
    const cloud = fakeCloud({ "GET /v1/info": { deployment_id: "Dep_1" } });
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

test("--json is global and active prints the ID as a value", () => {
    const cloud = fakeCloud({ "GET /v1/info": { deployment_id: "Dep_1" } });
    assert.equal(api(interp(), "deployment active", cloud).stdout, "Dep_1\n");
    assert.equal(run(interp(), "cloud --json app --app demo deployment active", cloud).stdout, '"Dep_1"\n');
});

test("commandHandler strips the command name and runs inside the shell", () => {
    const bash = new Bash({ cwd: "/workspace" });
    bash.registerCommand("obelisk", commandHandler(null, fakeCloud({ "GET /v1/info": { deployment_id: "Dep_1" } })));
    const out = bash.exec("obelisk cloud app --app demo deployment active | tr D d");
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stdout, "dep_1\n");
});

// -- provisioner commands and deploy --

test("provisioner commands forward args, policy, OBELISK_APP_NAME and --from-env", () => {
    const i = interp("/workspace", { OBELISK_APP_NAME: "demo", API_KEY: "s3cret" });
    i.vfs.writeFile("/workspace/app.toml", 'app_name = "demo"\n');
    const cloud = fakeCloud();
    let out = run(i, "cloud app secrets set API_KEY --from-env API_KEY", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.deepEqual(cloud.runs[0], {
        args: words("app secrets set API_KEY --stdin --app demo"), stdin: "s3cret", appToml: 'app_name = "demo"\n', fillEnv: null,
    });

    out = run(i, "cloud app fill --non-interactive", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.deepEqual(new Map(cloud.runs[1].fillEnv).get("API_KEY"), "s3cret");

    out = run(i, "cloud app secrets set X --from-env MISSING", cloud);
    assert.equal(out.stderr, "Error: environment variable MISSING is not set\n");
});

test("cloud app deploy prepares the app, enqueues the deployment, then finishes with its id", () => {
    const i = interp("/workspace/app");
    i.vfs.writeFile("/workspace/app/app.toml", 'app_name = "demo"\n');
    i.vfs.writeFile("/workspace/app/deployment.toml", '[[activity_js]]\nlocation = "a.js"\n');
    i.vfs.writeFile("/workspace/app/a.js", "a");
    const cloud = fakeCloud({
        "PUT /v1/deployments/*": { status: 201, body: "" },
        "PUT /v1/deployments/*/switch": { ok: "restart_required" },
    });
    const out = run(i, "cloud app deploy", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    const id = cloud.deploys[1].deploymentId;
    assert.match(id, /^Dep_[0-9A-Z]{26}$/);
    assert.deepEqual(cloud.deploys, [
        { app: "demo", appToml: 'app_name = "demo"\n', fillEnv: null },
        { app: "demo", deploymentId: id, revision: 1, created: true, fillEnv: null },
    ]);
    const submit = cloud.calls.find((call) => call.path === `/v1/deployments/${id}`);
    assert.deepEqual(JSON.parse(submit.body), {
        deployment_toml: `[[activity_js]]\nlocation = "a.js"\ncontent_digest = "${sha256("a")}"\n`,
        description: null,
        allow_unavailable_runtime_config: true,
    });
    assert.equal(out.stdout, "https://demo.test/hook\n");
    assert.equal(out.stderr, `→ prepare\n→ obelisk cloud app deployment enqueue\nSubmitted as ${id}\nDeployment staged for cloud app apply.\n→ finish\nDeployed demo\n`);

    const json = run(i, "cloud app deploy --json", cloud);
    assert.deepEqual(JSON.parse(json.stdout).outcomes, ["applied"]);
});

test("cloud app deploy stops before finishing when the enqueue fails", () => {
    const i = interp("/workspace/app");
    i.vfs.writeFile("/workspace/app/app.toml", 'app_name = "demo"\n');
    i.vfs.writeFile("/workspace/app/deployment.toml", "");
    const cloud = fakeCloud({ "PUT /v1/deployments/*": { status: 400, body: "invalid deployment" } });
    const out = run(i, "cloud app deploy", cloud);
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /Error: Deployment staging failed; inspect `obelisk cloud app --app demo status` and retry deploy\n\nCaused by:\n {4}server returned 400 Bad Request: invalid deployment\n$/);
    assert.equal(cloud.deploys.length, 1);
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

    out = run(interp(), "cloud --verbose app --app demo execution list", cloud);
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
    assert.equal(out.stdout, "E_x\n");
    assert.equal(out.stderr, 'Locked\nFinished: OK\nExecution finished: OK: {"value":1}\n');

    out = api(interp(), "execution submit -e E_x a:b/c.d -f --json", cloud);
    assert.equal(out.stdout, '{"ok":"E_x"}\n{"ok":{"value":1}}\n');
    assert.equal(out.stderr, "");
});

test("execution result exits 1 on an error or execution failure", () => {
    let cloud = fakeCloud({ "GET /v1/executions/E_1?follow=false": { err: null } });
    let out = api(interp(), "execution result E_1", cloud);
    assert.equal(out.exitCode, 1);
    assert.equal(out.stderr, "Execution finished: Error: (no return value)\n");

    cloud = fakeCloud({ "GET /v1/executions/E_1?follow=false": { execution_failed: { kind: "timed_out", reason: "slow", detail: "d" } } });
    out = api(interp(), "execution result E_1", cloud);
    assert.equal(out.stderr, "Execution finished: Execution failure (TimedOut): `slow`\nd\n");
});

test("execution status prints the status text, or JSON", () => {
    const cloud = fakeCloud({ "GET /v1/executions/E_1/status": { ffqn: "a:b/c.d", pending_state: { status: "blocked_by_join_set", join_set_id: "o:1", closing: true } } });
    assert.equal(api(interp(), "execution get E_1", cloud).stderr, "Blocked by o:1 (closing)\n");
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

// -- deployment --

test("deployment submit preflights, then attaches only the missing files", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/deployment.toml", '[[activity_js]]\nlocation = "a.js"\n');
    i.vfs.writeFile("/workspace/a.js", "a");
    const digest = sha256("a");
    const cloud = fakeCloud({
        "PUT /v1/deployments/Dep_01ARZ3NDEKTSV4RRFFQ69G5FAV": seq(
            { status: 409, body: { missing_files: [{ field_path: "activity_js[0].location", path: "a.js", digest }] } },
            { status: 201, body: "" },
        ),
    });
    const out = api(i, "deployment submit --deployment-id Dep_01ARZ3NDEKTSV4RRFFQ69G5FAV --description first", cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stdout, "Dep_01ARZ3NDEKTSV4RRFFQ69G5FAV\n");
    assert.equal(out.stderr, "Submitted as Dep_01ARZ3NDEKTSV4RRFFQ69G5FAV\n");
    const [preflight, retry] = cloud.calls;
    assert.equal(JSON.parse(preflight.body).description, "first");
    const boundary = retry.contentType.match(/^multipart\/form-data; boundary=(.+)$/)[1];
    assert.ok(retry.body.includes(`name="${digest}"; filename="a.js"\r\nContent-Type: application/octet-stream\r\n\r\na\r\n`), retry.body);
    assert.ok(retry.body.includes('name="allow_unavailable_runtime_config"\r\n\r\nfalse\r\n'));
    assert.ok(retry.body.endsWith(`--${boundary}--\r\n`));
});

test("deployment submit reuses the active deployment when nothing changed", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/deployment.toml", "# comment\n[[activity_js]]\nlocation = 'a.js'\n");
    i.vfs.writeFile("/workspace/a.js", "a");
    const cloud = fakeCloud({
        "GET /v1/info": { deployment_id: "Dep_1" },
        "GET /v1/deployments/Dep_1": { deployment_toml: `[[activity_js]]\ncontent_digest = "${sha256("a")}"\nlocation = "a.js"\n`, description: null },
    });
    const out = api(i, "deployment apply", cloud);
    assert.equal(out.exitCode, 1);
    assert.equal(out.stderr, "Deployment content unchanged; using Dep_1\nError: server returned 404 Not Found: no route for PUT /v1/deployments/Dep_1/switch\n");
});

test("deployment submit reports server rejections like the real CLI", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/deployment.toml", "");
    let cloud = fakeCloud({ "PUT /v1/deployments/*": { status: 409, body: { unexpected_files: [{ field_path: "x" }], missing_files: [{ field_path: "y", message: "gone" }] } } });
    assert.equal(api(i, "deployment submit", cloud).stderr, "Error: deployment submit rejected: missing file at y (gone); unexpected file x\n");

    cloud = fakeCloud({ "PUT /v1/deployments/*": { status: 422, body: { error: "missing_runtime_config", secrets: ["TOKEN"] } } });
    assert.match(api(i, "deployment submit", cloud).stderr, /^Error: deployment rejected by the server: configuration references secret\(s\) `TOKEN` not registered/);
});

test("deployment submit rejects generated metadata and an ID with --description", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/deployment.toml", '[[activity_js]]\nlocation = "a.js"\ncontent_digest = "sha256:1"\n');
    assert.equal(api(i, "deployment submit", fakeCloud()).stderr,
        "Error: activity_js.content_digest is generated submission metadata; remove it from deployment.toml\n");
    assert.equal(api(i, "deployment enqueue Dep_01ARZ3NDEKTSV4RRFFQ69G5FAV --description x", fakeCloud()).stderr,
        "Error: --description cannot be used with an existing deployment ID\n");
    assert.match(api(i, "deployment submit missing.toml", fakeCloud()).stderr, /^Error: cannot read deployment manifest "missing.toml"/);
});

test("deployment enqueue and apply switch the deployment and report the outcome", () => {
    const id = "Dep_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    let cloud = fakeCloud({ [`PUT /v1/deployments/${id}/switch`]: { ok: "switched" } });
    let out = api(interp(), `deployment enqueue ${id} --allow-unavailable-runtime-config`, cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stderr, "Deployment already active; it will remain active after restart.\n");
    assert.deepEqual(JSON.parse(cloud.calls[0].body), { allow_unavailable_runtime_config: true, apply: false });

    out = api(interp(), `deployment apply ${id}`, cloud);
    assert.equal(out.stderr, "Applied successfully.\n");
    assert.deepEqual(JSON.parse(cloud.calls[1].body), { allow_unavailable_runtime_config: false, apply: true });

    cloud = fakeCloud({ [`PUT /v1/deployments/${id}/switch`]: { ok: "restart_required" } });
    out = api(interp(), `deployment apply ${id}`, cloud);
    assert.equal(out.stderr, "Error: Could not apply immediately; deployment enqueued. Restart the server to apply.\n");
    assert.equal(api(interp(), `deployment apply ${id} --allow-unavailable-runtime-config`, cloud).exitCode, 2);
});

test("deployment list prints a table", () => {
    const cloud = fakeCloud({
        "GET /v1/deployments": [{ deployment_id: "Dep_1", status: "active", description: "first", created_at: "2026-01-01T00:00:00.123Z", last_active_at: null }],
    });
    assert.equal(api(interp(), "deployment list", cloud).stderr,
        `${"ID".padEnd(32)}  ${"STATUS".padEnd(12)}  DESCRIPTION\n${"Dep_1".padEnd(32)}  ${"Active".padEnd(12)}  first\n`);
    assert.match(run(interp(), "cloud app --app demo --verbose deployment list", cloud).stderr, /2026-01-01 00:00:00 {2}/);
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
        "GET /v1/info": { node_run_id: "Run_1" },
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
    assert.match(i.vfs.readFile("/workspace/My Cool_App/README.md"), /^# my-cool-app\n[^]*obelisk cloud app deploy\n/);
    assert.equal(i.vfs.readFile("/workspace/My Cool_App/app.toml"), 'app_name = "my-cool-app"\n');
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
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /invalid app name/);
});

test("generate new requires --template and lists the available ones", () => {
    const out = generate(interp("/workspace/app"), "generate new");
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /--template is required; templates at obeli-sk\/obelisk@v0\.42\.0: minimal, url-health-dashboard/);
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
