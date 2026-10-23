import { test } from "node:test";
import assert from "node:assert/strict";
import { Vfs } from "./fs.js";
import { Interpreter, OutputLog } from "./interpreter.js";
import { Bash } from "./bash.js";
import { sha256Hex } from "./commands/hash.js";
import { utf8Encode } from "./utf8.js";
import * as obelisk from "./obelisk-pack.js";

function sha256(text) {
    return `sha256:${sha256Hex(utf8Encode(text))}`;
}

const { executeObelisk, commandHandler, blobLoader,
    simplifyManifest, manifestWithDigests, ownedSourceLocations, deploymentSources } = obelisk;

// A fake host backed by an in-memory ffqn -> canned-JSON-response queue, for
// tests only. A call to an ffqn with no fixture throws, mirroring a call to
// something nothing implements. Multiple `.with`/`.withErr` calls for one
// ffqn enqueue successive responses (so a test can model a preflight that
// reports missing files then a retry that succeeds); the last response
// repeats once the queue is down to one. Records every call so tests can
// assert on the exact params sent.
const APP_CONFIG_FFQN = "obelisk-agent:tools/webapi.get-app-config";

function fakeHost() {
    const responses = new Map();
    const calls = [];
    const host = {
        calls,
        with(ffqn, responseJson) {
            if (!responses.has(ffqn)) responses.set(ffqn, []);
            responses.get(ffqn).push({ ok: true, value: responseJson });
            return host;
        },
        withErr(ffqn, message) {
            if (!responses.has(ffqn)) responses.set(ffqn, []);
            responses.get(ffqn).push({ ok: false, value: message });
            return host;
        },
        callJson(ffqn, paramsJson) {
            calls.push([ffqn, paramsJson]);
            const queue = responses.get(ffqn);
            if (!queue || queue.length === 0) throw `no fixture for ${ffqn}`;
            const entry = queue.length > 1 ? queue.shift() : queue[0];
            if (!entry.ok) throw entry.value;
            return entry.value;
        },
        // The pack's control plane over the ffqn-keyed fixtures: each method
        // sends the same params array its WIT function takes.
        listFunctions: (prefix, length) => decodeFixture(webapi("list-functions", [prefix, length])),
        getFunctionWit: (ffqn) => text(webapi("get-function-wit", [ffqn])),
        listExecutions: (ffqnPrefix, idPrefix, showDerived, hideFinished, length) =>
            text(webapi("list-executions", [ffqnPrefix, idPrefix, showDerived, hideFinished, "", "", "", "", false, length])),
        getExecution: (id) => text(webapi("get-execution", [id])),
        getLogs: (id, length) => text(webapi("get-logs", [id, true, true, true, [], [], "", "", false, length])),
        getResultJson: (id) => text(webapi("get-result-json", [id])),
        listDeployments: (length) => text(webapi("list-deployments", ["", false, length])),
        getDeployment: (id) => text(webapi("get-deployment", [id, null, null, null, null])),
        currentDeploymentId: () => text(webapi("current-deployment-id", [])),
        // Unfixtured means no app config, so mount tests need not stub it.
        getAppConfig: () => (responses.has(APP_CONFIG_FFQN) ? webapi("get-app-config", []) : null),
        deploymentCheckout: (id) => decodeFixture(webapi("deployment-checkout", [id])),
        deploymentReadBlob: (digest) => text(webapi("deployment-read-blob", [digest])),
        deploymentSubmit(manifest, attachments, description, allowMissing, deploymentId) {
            try {
                return text(webapi("deployment-submit", [manifest, attachments, description, allowMissing, deploymentId]));
            } catch (message) {
                // The fixture error arm is the verbatim `permanent_missing_files` JSON.
                let missingFiles;
                try {
                    missingFiles = JSON.parse(message).permanent_missing_files;
                } catch {
                    throw message;
                }
                if (!Array.isArray(missingFiles)) throw message;
                throw { missingFiles };
            }
        },
        deploymentSwitch: (id, allowMissing) => text(webapi("deployment-switch", [id, allowMissing])),
        applyDeployment: (id) => text(webapi("apply-deployment", [id])),
        callTarget: (ffqn, paramsJson) => text(call("obelisk-agent:tools/webapi.call-target", [ffqn, paramsJson])),
    };
    function call(ffqn, params) {
        const raw = host.callJson(ffqn, JSON.stringify(params));
        if (raw === null) return null;
        try {
            return JSON.parse(raw);
        } catch {
            return raw;
        }
    }
    function webapi(fn, params) {
        return call(`obelisk-agent:tools/webapi.${fn}`, params);
    }
    function text(value) {
        if (typeof value === "string") return value;
        return value === null ? "" : JSON.stringify(value);
    }
    function decodeFixture(value) {
        return typeof value === "string" ? JSON.parse(value) : value;
    }
    return host;
}

const APP = "demo";

// A cloud with the one app `demo`, served by `host`.
function oneAppCloud(host) {
    return {
        run: () => ({ stdout: JSON.stringify({ apps: [{ app_name: APP }] }), stderr: "", exitCode: 0 }),
        prepareDeploy: () => { throw "not deployable"; },
        controlPlane: () => host,
    };
}

// `obelisk cloud app --app demo ARGS` with `host` as the app's control plane.
function app(i, args, stdin, host) {
    return executeObelisk(i, ["cloud", "app", "--app", APP, ...args], stdin, null, null, oneAppCloud(host));
}

function words(s) {
    return s.split(" ").filter((w) => w !== "");
}

function interp(cwd = "/workspace") {
    return new Interpreter({
        vfs: new Vfs(),
        cwd,
        env: {},
        now: () => 0,
        sleep: () => {},
        customCommands: new Map(),
        dispatchBuiltin: () => ({ stdout: "", stderr: "command not found\n", exitCode: 127 }),
        commandNames: [],
        log: new OutputLog(),
    });
}

// A digest-addressed blob loader for the lazy-mount tests, mirroring the CAS.
function fixtureLoader(entries) {
    const map = new Map(Object.entries(entries));
    return (digest) => {
        if (!map.has(digest)) throw new Error(`no blob for ${digest}`);
        return map.get(digest);
    };
}

// -- subcommand routing / argument parsing (direct calls, bypassing the
// shell so test args don't have to survive quoting/splitting) --

test("bare obelisk prints command list", () => {
    const host = fakeHost();
    const out = executeObelisk(interp(), [], "", host);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /^Usage: obelisk <command>/);
});

test("help flags print usage at every level", () => {
    const host = fakeHost();
    const i = interp();
    for (const args of [["--help"], ["-h"]]) {
        const out = executeObelisk(i, args, "", host);
        assert.equal(out.exitCode, 0);
        assert.match(out.stdout, /^Usage: obelisk <command>/);
    }
    let out = app(i, words("deployment -h"), "", host);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /^Usage: obelisk cloud app \[--app NAME\] deployment/);

    // Help needs no app, so a cloud without one still prints it.
    const noApps = { run: () => ({ stdout: '{"apps":[]}', stderr: "", exitCode: 0 }), controlPlane: () => host };
    out = executeObelisk(i, words("cloud app deployment submit --help"), "", null, null, noApps);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, [
        "Usage: obelisk cloud app [--app NAME] deployment submit [OPTIONS] PATH-TO-DEPLOYMENT.TOML",
        "",
        "Store the edited deployment as a new inactive deployment and print its ID. PATH",
        "is the path to the deployment TOML file to submit (any filename -- not just the",
        'literal "deployment.toml"); it must be a file, not a directory, matching real',
        "obelisk. Digests are recomputed from the files, so leave them out.",
        "",
        "Options:",
        "--description TEXT               Human-readable description for the new deployment.",
        "--allow-missing-runtime-config  Tolerate runtime config unavailable on this server.",
        "(alias: --allow-unavailable-runtime-config)",
        "",
    ].join("\n"));

    // `call -h` reaches the call help even though the ffqn sits in the
    // action slot, but a help flag after `--` is a positional parameter.
    out = app(i, words("call -h"), "", host);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /^Usage: obelisk cloud app \[--app NAME\] call/);

    assert.equal(host.calls.length, 0, "no help path ever hits the host");
});

test("command groups with no action fall through to unknown-command", () => {
    const host = fakeHost();
    const i = interp();
    for (const group of ["functions", "executions", "deployment"]) {
        const out = app(i, [group], "", host);
        assert.equal(out.exitCode, 2);
        assert.notEqual(out.stderr, "");
    }
    assert.equal(host.calls.length, 0);
});

test("app commands at the top level point at obelisk cloud app", () => {
    const host = fakeHost();
    for (const args of [words("functions list"), words("executions get E_1"), words("call some:ffqn []"), words("deployment active")]) {
        const out = executeObelisk(interp(), args, "", host);
        assert.equal(out.exitCode, 2);
        assert.equal(out.stderr, `obelisk: \`obelisk ${args[0]}\` runs against a cloud app: use \`obelisk cloud app [--app NAME] ${args.join(" ")}\` (see \`obelisk cloud apps list\`)\n`);
    }
    assert.equal(host.calls.length, 0);
});

test("ask-user stays a top-level call answered by the session", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.call-target", "42");
    const out = executeObelisk(interp(), ["call", "obelisk-agent:stub/stub.ask-user", '["ok?"]'], "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stdout, "42\n");
    assert.deepEqual(host.calls, [["obelisk-agent:tools/webapi.call-target", JSON.stringify(["obelisk-agent:stub/stub.ask-user", '["ok?"]'])]]);
});

test("the app defaults to the cloud's only app, else asks for --app", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.current-deployment-id", '"Dep_1"');
    let out = executeObelisk(interp(), words("cloud app deployment active"), "", null, null, oneAppCloud(host));
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "Dep_1\n");

    const two = { run: () => ({ stdout: '{"apps":[{"app_name":"a"},{"app_name":"b"}]}', stderr: "", exitCode: 0 }), controlPlane: () => host };
    out = executeObelisk(interp(), words("cloud app deployment active"), "", null, null, two);
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk: Select an app with --app NAME (apps: a, b) or app_name in ./app.toml\n");

    const i = interp();
    i.vfs.writeFile("/workspace/app.toml", 'app_name = "b"\n');
    let asked = null;
    out = executeObelisk(i, words("cloud app deployment active"), "", null, null, { ...two, controlPlane: (name) => { asked = name; return host; } });
    assert.equal(out.exitCode, 0);
    assert.equal(asked, "b");
});

test("unknown command reports help", () => {
    const host = fakeHost();
    const out = executeObelisk(interp(), ["nonsense"], "", host);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /unknown command 'nonsense'/);
    assert.match(out.stderr, /Usage: obelisk <command>/);
});

test("functions list forwards prefix and length", () => {
    const host = fakeHost().with(
        "obelisk-agent:tools/webapi.list-functions",
        JSON.stringify([
            {
                ffqn: "foo:bar/api.run",
                parameter_types: [
                    { name: "input", wit_type: "string" },
                    { name: "retries", wit_type: "u32" },
                ],
                return_type: "result<string, error>",
                extension: null,
            },
            { ffqn: "foo:bar/api.run-submit", parameter_types: [], return_type: "execution-id", extension: "submit" },
        ]),
    );
    const out = app(interp(), words("functions list --prefix foo --length 5"), "", host);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "foo:bar/api.run : func(input: string, retries: u32) -> result<string, error>\n");
    assert.equal(host.calls[0][1], JSON.stringify(["foo", 5]));
});

test("functions list --json preserves structured output", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.list-functions", JSON.stringify([{ ffqn: "a", extension: null }]));
    const out = app(interp(), words("functions list --json"), "", host);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, '[\n  {\n    "ffqn": "a",\n    "extension": null\n  }\n]\n');
});

test("functions list defaults when flags absent", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.list-functions", "[]");
    app(interp(), words("functions list"), "", host);
    assert.equal(host.calls[0][1], JSON.stringify(["", 100]));
});

test("functions wit prints non-JSON text verbatim", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.get-function-wit", JSON.stringify("interface foo { bar: func() }"));
    const out = app(interp(), words("functions wit a:b/c.d"), "", host);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "interface foo { bar: func() }\n");
});

test("functions wit requires ffqn", () => {
    const out = app(interp(), words("functions wit"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk: ffqn is required\n");
});

test("executions list forwards all flags in order", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.list-executions", "[]");
    app(interp(), words("executions list --ffqn-prefix pfx --show-derived --length 7"), "", host);
    assert.equal(host.calls[0][1], JSON.stringify(["pfx", "", true, false, "", "", "", "", false, 7]));
});

test("executions get requires id", () => {
    const out = app(interp(), words("executions get"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk: execution id is required\n");
});

test("executions logs forwards id and length", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.get-logs", JSON.stringify("log"));
    const out = app(interp(), words("executions logs exec-1 --length 50"), "", host);
    assert.equal(out.stdout, "log\n");
    assert.equal(host.calls[0][1], JSON.stringify(["exec-1", true, true, true, [], [], "", "", false, 50]));
});

test("executions result forwards id", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.get-result-json", JSON.stringify({ ok: 1 }));
    const out = app(interp(), words("executions result exec-1"), "", host);
    assert.equal(out.stdout, '{\n  "ok": 1\n}\n');
});

test("call uses explicit params over stdin", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.call-target", "42");
    const out = app(interp(), words("call some:ffqn [1]"), "[2]", host);
    assert.equal(out.stdout, "42\n");
    assert.equal(host.calls[0][1], JSON.stringify(["some:ffqn", "[1]"]));
});

test("call prints only the target result", () => {
    let host = fakeHost().with("obelisk-agent:tools/webapi.call-target", JSON.stringify(JSON.stringify({ answer: 42 })));
    let out = app(interp(), words("call some:ffqn []"), "", host);
    assert.equal(out.stdout, '{\n  "answer": 42\n}\n');

    host = fakeHost().with("obelisk-agent:tools/webapi.call-target", JSON.stringify(JSON.stringify("plain result")));
    out = app(interp(), words("call some:ffqn []"), "", host);
    assert.equal(out.stdout, "plain result\n");
});

test("call failure is a command error, not a result", () => {
    const out = app(interp(), words("call some:ffqn []"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /^obelisk: no fixture for/);
});

test("call falls back to stdin then to an empty array", () => {
    let host = fakeHost().with("obelisk-agent:tools/webapi.call-target", "1");
    app(interp(), words("call some:ffqn"), "[9]", host);
    assert.equal(host.calls[0][1], JSON.stringify(["some:ffqn", "[9]"]));

    host = fakeHost().with("obelisk-agent:tools/webapi.call-target", "1");
    app(interp(), words("call some:ffqn"), "", host);
    assert.equal(host.calls[0][1], JSON.stringify(["some:ffqn", "[]"]));
});

test("call accepts positional params after --", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.call-target", "1");
    app(
        interp(),
        ["call", "some:ffqn", "--", "1", "true", "null", '{"field":2}', "plain text", '"42"'],
        "ignored stdin",
        host,
    );
    assert.equal(
        host.calls[0][1],
        JSON.stringify(["some:ffqn", JSON.stringify([1, true, null, { field: 2 }, "plain text", "42"])]),
    );
});

test("call rejects multiple arguments without --", () => {
    const host = fakeHost();
    const out = app(interp(), words("call some:ffqn 1 2"), "", host);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /expected one params JSON array/);
    assert.equal(host.calls.length, 0);
});

test("call rejects an explicitly empty params argument", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.call-target", "1");
    const out = app(interp(), ["call", "some:ffqn", ""], "", host);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /params-json argument is empty/);
    assert.equal(host.calls.length, 0);
});

test("call requires ffqn", () => {
    const out = app(interp(), words("call"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk: ffqn is required\n");
});

test("deployment active calls host", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify("dep-1"));
    const out = app(interp(), words("deployment active"), "", host);
    assert.equal(out.stdout, "dep-1\n");
});

test("deployment active --json quotes the id", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify("dep-1"));
    const out = app(interp(), words("deployment active --json"), "", host);
    assert.equal(out.stdout, '"dep-1"\n');
});

test("deployment enqueue requires id, forwards the flag, and reports the outcome", () => {
    const i = interp();
    let out = app(i, words("deployment enqueue"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk: deployment id is required\n");

    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-switch", JSON.stringify({ ok: "restart_required" }));
    out = app(i, words("deployment enqueue dep-2 --allow-missing-runtime-config"), "", host);
    assert.equal(host.calls[0][1], JSON.stringify(["dep-2", true]));
    assert.equal(out.stdout, "Deployment enqueued. Restart the server to apply.\n");
});

test("deployment enqueue reports an already-active deployment", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-switch", JSON.stringify({ ok: "switched" }));
    const out = app(interp(), words("deployment enqueue dep-2"), "", host);
    assert.equal(out.stdout, "Deployment already active; it will remain active after restart.\n");
});

test("deployment apply requires id", () => {
    const out = app(interp(), words("deployment apply"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk: deployment id or PATH-TO-DEPLOYMENT.TOML is required\n");
});

test("deployment apply reports success", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.apply-deployment", JSON.stringify({ ok: "switched" }));
    const out = app(interp(), words("deployment apply Dep_2"), "", host);
    assert.equal(host.calls[0][1], JSON.stringify(["Dep_2"]));
    assert.equal(out.stdout, "Applied successfully.\n");
});

test("deployment apply submits a manifest path first, like real obelisk", () => {
    const i = interp("/workspace/app");
    i.vfs.writeFile("/workspace/app/deployment.toml", '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n');
    const host = fakeHost()
        .with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_new"))
        .with("obelisk-agent:tools/webapi.apply-deployment", JSON.stringify({ ok: "switched" }));
    const out = app(i, words("deployment apply deployment.toml"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(out.stdout, "Submitted as Dep_new\nApplied successfully.\n");
    assert.equal(JSON.parse(host.calls[0][1])[3], false);
    assert.deepEqual(host.calls[1], ["obelisk-agent:tools/webapi.apply-deployment", JSON.stringify(["Dep_new"])]);
});

test("deployment apply fails when only a restart could apply it", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.apply-deployment", JSON.stringify({ ok: "restart_required" }));
    const out = app(interp(), words("deployment apply Dep_2"), "", host);
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk: Could not apply immediately; deployment enqueued. Restart the server to apply.\n");
});

test("deployment list renders a table, newest first", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.list-deployments", JSON.stringify([
        { deployment_id: "Dep_2", description: "second", status: "active", created_at: "2026-09-14T08:22:17.592Z", last_active_at: "2026-09-14T09:00:00.000Z" },
        { deployment_id: "Dep_1", description: "", status: "inactive", created_at: "2026-09-13T07:00:00.000Z", last_active_at: null },
    ]));
    const out = app(interp(), words("deployment list"), "", host);
    assert.equal(host.calls[0][1], JSON.stringify(["", false, 20]));
    const lines = out.stdout.split("\n");
    assert.equal(lines[0], "ID                                STATUS        CREATED_AT           LAST_ACTIVE_AT       DESCRIPTION");
    assert.equal(lines[1], "Dep_2                             Active        2026-09-14 08:22:17  2026-09-14 09:00:00  second");
    assert.equal(lines[2], "Dep_1                             Inactive      2026-09-13 07:00:00                       ");
});

test("deployment list reports an empty catalog", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.list-deployments", JSON.stringify([]));
    const out = app(interp(), words("deployment list"), "", host);
    assert.equal(out.stdout, "No deployments found.\n");
});

test("deployment show prints the stored manifest", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.get-deployment", JSON.stringify({ deployment_toml: "[[activity_js]]\nname = \"x\"\n" }));
    const out = app(interp(), words("deployment show Dep_1"), "", host);
    assert.equal(host.calls[0][1], JSON.stringify(["Dep_1", null, null, null, null]));
    assert.equal(out.stdout, "[[activity_js]]\nname = \"x\"\n");
});

test("deployment show requires id", () => {
    const out = app(interp(), words("deployment show"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk: deployment id is required\n");
});

test("deployment unknown action", () => {
    const out = app(interp(), words("deployment bogus"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk deployment: unknown action 'bogus'\n");
});

test("generate deployment prints the embedded template", () => {
    const host = fakeHost();
    const out = executeObelisk(interp(), words("generate deployment"), "", host);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /\[\[activity_wasm\]\]/);
    assert.ok(out.stdout.endsWith("\n"));
    assert.equal(host.calls.length, 0);
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

test("generate new fetches the chosen template at OBELISK_VERSION", () => {
    const i = interp("/workspace/My Cool_App");
    const host = fakeHost();
    let source = templateSource();
    let out = executeObelisk(i, words("generate new --template minimal"), "", host, source.generate);
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
    assert.deepEqual(host.calls, []);

    // A second run must not overwrite anything.
    out = executeObelisk(i, words("generate new --template minimal"), "", host, templateSource().generate);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /already exists/);

    out = executeObelisk(i, words("generate new --template minimal chosen-app"), "", host, templateSource().generate);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(i.vfs.isFile("/workspace/My Cool_App/chosen-app/workflow/run.js"), true);

    out = executeObelisk(i, ["generate", "new", "--template", "minimal", "Bad Name"], "", host, templateSource().generate);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /invalid app name/);
});

test("generate new requires --template and lists the available ones", () => {
    const out = executeObelisk(interp("/workspace/app"), words("generate new"), "", fakeHost(), templateSource().generate);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /--template is required; templates at obeli-sk\/obelisk@v0\.42\.0: minimal, url-health-dashboard/);
});

test("generate new falls back to main when OBELISK_VERSION has no such template", () => {
    for (const version of ["v0.43.0-rc.6", "latest"]) {
        const i = interp("/workspace/app");
        const source = templateSource(version, "main");
        const out = executeObelisk(i, words("generate new --template minimal"), "", fakeHost(), source.generate);
        assert.equal(out.exitCode, 0, out.stderr);
        assert.equal(i.vfs.readFile("/workspace/app/workflow/run.js"), "42\n");
    }
    const out = executeObelisk(interp("/workspace/app"), words("generate new --template bogus"), "", fakeHost(), templateSource().generate);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /@v0\.42\.0:examples\/templates\/bogus: 404 Not Found.*@main:examples\/templates\/bogus: 404/);
});

test("generate requires a known subcommand", () => {
    let out = executeObelisk(interp(), words("generate"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /a subcommand is required/);

    out = executeObelisk(interp(), words("generate bogus"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk generate: unknown action 'bogus'\n");
});

test("a host error propagates with the obelisk: prefix", () => {
    const out = app(interp(), words("functions list"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /^obelisk: no fixture for/);
});

test("commandHandler strips the command name before dispatch", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.list-functions", "[]");
    const bash = new Bash({ cwd: "/workspace" });
    bash.registerCommand("obelisk", commandHandler(null, null, oneAppCloud(host)));
    const out = bash.exec("obelisk cloud app functions list | cat");
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "");
});

// -- ownedSourceLocations, over raw manifest text --

test("ownedSourceLocations scans top-level tables, skips oci:// and non-top-level nesting", () => {
    const toml = [
        "[[activity_wasm]]",
        'location = "a.wasm"',
        'content_digest = "sha256:1"',
        "",
        "[[activity_wasm]]",
        'location = "oci://example/img"',
        'content_digest = "sha256:2"',
        "",
        "[[webhook_endpoint.other]]",
        'location = "nested.wasm"',
        'content_digest = "sha256:3"',
        "",
    ].join("\n");
    assert.deepEqual(ownedSourceLocations(toml), ["a.wasm"]);
});

test("ownedSourceLocations reads both the nested-table and inline backtrace forms", () => {
    const nested = [
        "[[workflow_wasm]]",
        'name = "wf"',
        'location = "w.wasm"',
        'content_digest = "sha256:9"',
        "",
        "[workflow_wasm.backtrace.sources]",
        '".../src/lib.rs" = { path = "src/lib.rs", content_digest = "sha256:1" }',
        '".../src/util.rs" = { path = "src/util.rs", content_digest = "sha256:2" }',
        "",
    ].join("\n");
    assert.deepEqual(ownedSourceLocations(nested), ["w.wasm", "src/lib.rs", "src/util.rs"]);

    const inline = [
        "[[workflow_wasm]]",
        'name = "wf"',
        'location = "w.wasm"',
        'content_digest = "sha256:9"',
        'backtrace.sources = { ".../src/lib.rs" = { path = "src/lib.rs", content_digest = "sha256:1" } }',
        "",
    ].join("\n");
    assert.deepEqual(ownedSourceLocations(inline), ["w.wasm", "src/lib.rs"]);
});

test("ownedSourceLocations groups interleaved arrays like a TOML document", () => {
    const manifest = `
[[activity_js]]
location = "first.js"

[[workflow_js]]
location = "workflow.js"

[[activity_js]]
location = "second.js"
`;
    assert.deepEqual(ownedSourceLocations(manifest), ["first.js", "second.js", "workflow.js"]);
});

// -- the TOML editor: simplify / expand --

test("simplifyManifest tolerates a reformatted multi-line component_files", () => {
    const stored = [
        "[[webhook_endpoint]]",
        'location = "webhook/ui-api.js"',
        'content_digest = "sha256:aa"',
        "component_files = {",
        '  "webhook/ui-api.js" = "sha256:aa",',
        '  "webhook/ui/shell.js" = "sha256:bb",',
        "}",
        "",
    ].join("\n");
    const simplified = simplifyManifest(stored);
    assert.ok(!simplified.includes("sha256:aa"), simplified);
    assert.ok(!simplified.includes("sha256:bb"), simplified);
    assert.ok(!simplified.includes("content_digest"), simplified);
    assert.equal((simplified.match(/"auto"/g) || []).length, 2, simplified);
});

test("simplifyManifest collapses every digest shape", () => {
    const stored = [
        "[[webhook_endpoint]]",
        'location = "webhook/ui-api.js"',
        'content_digest = "sha256:aa"',
        'component_files = { "webhook/ui-api.js" = "sha256:aa", "webhook/ui/shell.js" = "sha256:bb" }',
        "[webhook_endpoint.backtrace.sources]",
        '"/abs/src/lib.rs" = { path = "src/lib.rs", content_digest = "sha256:cc" }',
        "",
    ].join("\n");
    const expected = [
        "[[webhook_endpoint]]",
        'location = "webhook/ui-api.js"',
        'component_files = { "webhook/ui-api.js" = "auto", "webhook/ui/shell.js" = "auto" }',
        "[webhook_endpoint.backtrace.sources]",
        '"/abs/src/lib.rs" = "src/lib.rs"',
        "",
    ].join("\n");
    assert.equal(simplifyManifest(stored), expected);
});

test("manifestWithDigests expands component_files, pinning digests from file bytes, and leaves backtrace.sources as paths", () => {
    // backtrace.sources stays untouched here: its digest is tracked via
    // component_files (added by manifestWithGeneratedFiles, which always runs
    // first in `submit`), not as an inline `{ path, content_digest }` table -
    // the server rejects that shape.
    const collapsed = [
        "[[webhook_endpoint]]",
        'location = "webhook/ui-api.js"',
        'component_files = { "webhook/ui-api.js" = "auto", "webhook/ui/shell.js" = "auto" }',
        "[webhook_endpoint.backtrace.sources]",
        '"/abs/src/lib.rs" = "src/lib.rs"',
        "",
    ].join("\n");
    const i = interp();
    const dir = "/workspace/checkout";
    i.vfs.writeFile(`${dir}/webhook/ui-api.js`, "api");
    i.vfs.writeFile(`${dir}/webhook/ui/shell.js`, "shell");

    const api = sha256("api");
    const shell = sha256("shell");
    const expected = [
        "[[webhook_endpoint]]",
        'location = "webhook/ui-api.js"',
        `component_files = { "webhook/ui-api.js" = "${api}", "webhook/ui/shell.js" = "${shell}" }`,
        `content_digest = "${api}"`,
        "[webhook_endpoint.backtrace.sources]",
        '"/abs/src/lib.rs" = "src/lib.rs"',
        "",
    ].join("\n");
    assert.equal(manifestWithDigests(i.vfs, dir, collapsed), expected);
});

test("TOML editor preserves every unrelated byte across a realistic multi-component fixture", () => {
    // A multi-block fixture combining the real shapes seen in this repo's own
    // deployment.toml: comments, blank lines, a nested `[[x.allowed_host]]`
    // array-of-tables, env_vars, name/description keys, a component_files
    // inline table, and a backtrace.sources nested table - none of which
    // `simplifyManifest` should touch except the digest-bearing fields.
    const fixture = [
        "## Top-of-file comment block, must survive untouched.",
        "# blank lines and comments interleaved below too.",
        "",
        "[[activity_js]]",
        'name = "program_curl"',
        'location = "activity/curl.js"',
        'content_digest = "sha256:curl1"',
        "# a per-component comment",
        'env_vars = ["ENV1", {key = "ENV2", value = "literal"}]',
        "",
        "[[activity_js.allowed_host]]",
        'pattern = "api.github.com"',
        'methods = "*"',
        "",
        "[[workflow_wasm]]",
        'name = "wf"',
        'location = "target/wasm32-wasip2/release/workflow.wasm"',
        'content_digest = "sha256:wfdigest"',
        "",
        "[workflow_wasm.backtrace.sources]",
        '"/abs/src/lib.rs" = { path = "src/lib.rs", content_digest = "sha256:1" }',
        '"/abs/src/util.rs" = { path = "src/util.rs", content_digest = "sha256:2" }',
        "",
        "[[webhook_endpoint]]",
        'name = "ui"',
        'location = "webhook/ui-api.js"',
        'content_digest = "sha256:uiapi"',
        'component_files = { "webhook/ui-api.js" = "sha256:uiapi", "webhook/ui/shell.js" = "sha256:uishell" }',
        "",
        "## Trailing file comment.",
        "",
    ].join("\n");

    const simplified = simplifyManifest(fixture);

    // Untouched regions survive byte-for-byte: comments, the allowed_host
    // block, env_vars, names/locations, and the trailing comment.
    for (const untouched of [
        "## Top-of-file comment block, must survive untouched.",
        "# blank lines and comments interleaved below too.",
        '[[activity_js]]\nname = "program_curl"\nlocation = "activity/curl.js"',
        "# a per-component comment",
        'env_vars = ["ENV1", {key = "ENV2", value = "literal"}]',
        '[[activity_js.allowed_host]]\npattern = "api.github.com"\nmethods = "*"',
        '[[workflow_wasm]]\nname = "wf"\nlocation = "target/wasm32-wasip2/release/workflow.wasm"',
        '[[webhook_endpoint]]\nname = "ui"\nlocation = "webhook/ui-api.js"',
        "## Trailing file comment.",
    ]) {
        assert.ok(simplified.includes(untouched), `expected untouched text present:\n${untouched}\n---\n${simplified}`);
    }

    // Every digest-bearing field is rewritten.
    assert.ok(!simplified.includes("sha256:curl1"), simplified);
    assert.ok(!simplified.includes("sha256:wfdigest"), simplified);
    assert.ok(!simplified.includes("sha256:uiapi"), simplified);
    assert.ok(!simplified.includes("sha256:uishell"), simplified);
    assert.ok(!simplified.includes("sha256:1"), simplified);
    assert.ok(!simplified.includes("sha256:2"), simplified);
    assert.equal((simplified.match(/"auto"/g) || []).length, 2);
    assert.equal(simplified, simplified.replace(/content_digest = "[^"]*"\n/g, ""));
    assert.ok(simplified.includes('"/abs/src/lib.rs" = "src/lib.rs"'));
    assert.ok(simplified.includes('"/abs/src/util.rs" = "src/util.rs"'));

    // The line count differs by exactly the number of removed content_digest
    // lines (3: activity_js, workflow_wasm, webhook_endpoint); every other
    // line is preserved 1:1 and in order.
    const originalLines = fixture.split("\n").filter((l) => !/^content_digest = /.test(l));
    const simplifiedLines = simplified.split("\n");
    assert.equal(simplifiedLines.length, originalLines.length);
});

test("deployment pull pins a snapshot, loads blobs on demand, and submits edits as a new deployment", () => {
    const host = fakeHost()
        .with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify(JSON.stringify("Dep_1")))
        .with("obelisk-agent:tools/webapi.deployment-checkout", JSON.stringify({
            deployment_toml: '[[activity_js]]\nlocation = "src/run.js"\ncontent_digest = "sha256:old"\n',
            files: [{ path: "src/run.js", digest: "sha256:old", size: 3 }],
        }))
        .with(APP_CONFIG_FFQN, JSON.stringify('app_name = "demo"\n'))
        .with("obelisk-agent:tools/webapi.deployment-read-blob", JSON.stringify("old"));
    const i = interp();
    const out = app(i, words("deployment pull ./checkout"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.deepEqual(JSON.parse(out.stdout), { deployment_id: "Dep_1", directory: "/workspace/checkout", files: 2 });
    assert.equal(i.vfs.readFile("/workspace/checkout/app.toml"), 'app_name = "demo"\n');
    assert.equal(host.calls.filter(([name]) => name.endsWith("deployment-read-blob")).length, 0);
    assert.ok(!i.vfs.exists("/workspace/cloud"));
    host.with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify("Dep_2"));
    assert.equal(i.vfs.readFile("/workspace/checkout/src/run.js"), "old");
    assert.deepEqual(host.calls.at(-1), ["obelisk-agent:tools/webapi.deployment-read-blob", '["sha256:old"]']);
    i.vfs.writeFile("/workspace/checkout/src/run.js", "new");
    host.with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_new"));
    const submitted = app(i, words("deployment submit /workspace/checkout/deployment.toml"), "", host);
    assert.equal(submitted.exitCode, 0, submitted.stderr);
    const params = JSON.parse(host.calls.at(-1)[1]);
    assert.equal(params[4], "");
    assert.ok(params[0].includes(sha256("new")));
});

test("deployment pull protects existing files and reports lookup errors directly", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/checkout/keep.txt", "edited");
    const host = fakeHost();
    let out = app(i, words("deployment pull checkout"), "", host);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /empty directory/);
    assert.equal(i.vfs.readFile("/workspace/checkout/keep.txt"), "edited");
    assert.equal(host.calls.length, 0);
    out = app(i, words("deployment pull fresh"), "", host);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /no fixture/);
    assert.ok(!i.vfs.exists("/workspace/.mount-error"));
    assert.ok(!i.vfs.exists("/workspace/fresh"));
    host.with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify(""));
    out = app(i, words("deployment pull empty"), "", host);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /no active deployment/);
    for (const args of ["deployment pull", "deployment pull a b", "deployment pull --force"]) {
        assert.equal(app(i, words(args), "", host).exitCode, 2);
    }
});

test("deployment pull keeps empty destinations unchanged when policy lookup fails", () => {
    const host = fakeHost()
        .with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify("Dep_1"))
        .with("obelisk-agent:tools/webapi.deployment-checkout", JSON.stringify({ deployment_toml: "", files: [] }))
        .withErr(APP_CONFIG_FFQN, "denied");
    const i = interp();
    i.vfs.mkdirp("/workspace/checkout");
    const out = app(i, words("deployment pull checkout"), "", host);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /denied/);
    assert.deepEqual(i.vfs.readdir("/workspace/checkout"), []);
});

test("app API reads do not create deployment mounts", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify("Dep_1"));
    const i = interp();
    assert.equal(app(i, words("deployment active"), "", host).exitCode, 0);
    assert.ok(!i.vfs.exists("/workspace/cloud"));
    assert.equal(host.calls.length, 1);
});

test("blobLoader decodes a plain string body via the read-blob ffqn", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-read-blob", JSON.stringify("bytes"));
    const loader = blobLoader(host);
    assert.equal(loader("sha256:1"), "bytes");
    assert.equal(host.calls[0][1], JSON.stringify(["sha256:1"]));
});

// -- deployment CLI actions that touch the mount --

test("deployment check reports the manifest size and owned sources", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp();
    i.vfs.writeFile("/workspace/checkout/deployment.toml", manifest);
    i.vfs.writeFile("/workspace/checkout/a.wasm", "bytes");
    const out = app(i, words("deployment check /workspace/checkout/deployment.toml"), "", fakeHost());
    assert.equal(out.exitCode, 0, out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.directory, "/workspace/checkout");
    assert.deepEqual(parsed.owned_sources, ["a.wasm"]);
});

test("deployment check defaults its directory to cwd", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp("/workspace/checkout");
    i.vfs.writeFile("/workspace/checkout/deployment.toml", manifest);
    const out = app(i, words("deployment check"), "", fakeHost());
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).directory, "/workspace/checkout");
});

test("deployment submit preflights, then attaches the missing blob", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp();
    i.vfs.writeFile("/workspace/checkout/deployment.toml", manifest);
    i.vfs.writeFile("/workspace/checkout/a.wasm", "bytes");
    const digest = sha256("bytes");
    const host = fakeHost()
        .withErr("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify({ permanent_missing_files: [{ path: "a.wasm", digest }] }))
        .with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_new"));
    const out = app(i, words("deployment submit /workspace/checkout/deployment.toml"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.match(out.stdout, /Dep_new/);

    const preflight = JSON.parse(host.calls[0][1]);
    assert.equal(preflight[0], `[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "${digest}"\n`);
    assert.deepEqual(preflight[1], []);
    assert.equal(preflight[2], "Submitted from workflow-agent VFS");
    assert.equal(preflight[3], false);
    assert.equal(preflight[4], "");

    const retry = JSON.parse(host.calls[1][1]);
    assert.deepEqual(retry[1], [{ path: "a.wasm", digest, content: "bytes" }]);
});

test("deployment submit requests a fresh deployment id", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp();
    i.vfs.writeFile("/workspace/checkout/deployment.toml", manifest);
    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_x"));
    app(i, words("deployment submit /workspace/checkout/deployment.toml"), "", host);
    assert.equal(JSON.parse(host.calls[0][1])[4], "");
});

test("deployment submit options do not shadow the path", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp();
    i.vfs.writeFile("/workspace/checkout/deployment.toml", manifest);
    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_x"));
    const out = app(i, words("deployment submit --description wh /workspace/checkout/deployment.toml"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    const params = JSON.parse(host.calls[0][1]);
    assert.equal(params[2], "wh");
    assert.equal(params[4], "");
});

test("deployment submit without a PATH is a clear error, not a silent default", () => {
    // Real obelisk's `submit` requires an explicit file path; unlike `check`
    // (an agent-only convenience with no real-CLI counterpart), it does not
    // default to ./deployment.toml.
    const i = interp("/workspace/checkout");
    i.vfs.writeFile("/workspace/checkout/deployment.toml", "[[activity_wasm]]\n");
    const out = app(i, words("deployment submit"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /PATH-TO-DEPLOYMENT\.TOML is required/);
});

test("deployment submit rejects a directory, matching real obelisk", () => {
    const i = interp();
    i.vfs.writeFile("/workspace/checkout/deployment.toml", "[[activity_wasm]]\n");
    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_x"));
    const out = app(i, words("deployment submit /workspace/checkout"), "", host);
    assert.equal(out.exitCode, 2);
    // Path-first, matching just-bash's grep/cat.
    assert.equal(out.stderr, "obelisk: /workspace/checkout: Is a directory\n");
});

test("deployment submit accepts a path to the toml file itself", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp();
    i.vfs.writeFile("/workspace/checkout/deployment.toml", manifest);
    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_new"));
    const out = app(i, words("deployment submit /workspace/checkout/deployment.toml"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(JSON.parse(host.calls[0][1])[4], "");
});

test("deployment submit accepts a manifest not literally named deployment.toml", () => {
    // Regression: PATH resolution used to string-match the basename against
    // the literal "deployment.toml", so any other manifest name was
    // treated as a directory and `<dir>/deployment.toml` didn't exist
    // there, failing with a misleading "No such file or directory" instead
    // of reading the file that was actually passed.
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp("/workspace/workflow-agent");
    i.vfs.writeFile("/workspace/workflow-agent/deployment.toml", manifest);
    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_new"));
    const out = app(i, words("deployment submit deployment.toml"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
});

test("deployment submit outside the deployment root sends an empty deployment id", () => {
    // Regression: the deployment_id was always the manifest's parent
    // directory's basename (unless literally "current"), a convention that
    // only holds for DEPLOYMENT_ROOT/<id> checkouts. Submitting straight
    // from a source-repo checkout like
    // /workspace/workflow-agent/deployment.toml sent "workflow-agent" as
    // the deployment_id, which the server rejects with "invalid
    // deployment_id: wrong prefix in `workflow-agent`, expected prefix
    // `Dep_`" instead of letting it assign a fresh one.
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp("/workspace/workflow-agent");
    i.vfs.writeFile("/workspace/workflow-agent/deployment.toml", manifest);
    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_new"));
    const out = app(i, words("deployment submit deployment.toml"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(JSON.parse(host.calls[0][1])[4], "");
});

test("deployment submit skips unmodified lazy sources", () => {
    const manifest = [
        "[[workflow_wasm]]",
        'location = "w.wasm"',
        'content_digest = "sha256:1"',
        'component_files = { "src/lib.rs" = "sha256:2" }',
        "[workflow_wasm.backtrace.sources]",
        '"w.wasm" = { path = "src/lib.rs", content_digest = "sha256:2" }',
    ].join("\n") + "\n";
    const i = interp();
    i.vfs.setBlobLoader(fixtureLoader({ "sha256:1": "wasm-bytes", "sha256:2": "rust source" }));
    i.vfs.writeFile("/workspace/checkout/deployment.toml", manifest);
    i.vfs.registerLazy("/workspace/checkout/w.wasm", "sha256:1", 10);
    i.vfs.registerLazy("/workspace/checkout/src/lib.rs", "sha256:2", 11);

    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_x"));
    const out = app(i, words("deployment submit /workspace/checkout/deployment.toml"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    // Preflight only: unchanged lazy sources keep their CAS digest, so the
    // manifest round-trips unchanged and nothing is attached.
    assert.equal(host.calls.length, 1);
    const params = JSON.parse(host.calls[0][1]);
    assert.equal(params[0], manifest);
    assert.deepEqual(params[1], []);
});

test("deployment submit sends only locally modified sources", () => {
    const manifest = [
        "[[workflow_js]]",
        'location = "a.js"',
        'content_digest = "sha256:a"',
        "[[workflow_js]]",
        'location = "b.js"',
        'content_digest = "sha256:b"',
    ].join("\n") + "\n";
    const i = interp();
    i.vfs.setBlobLoader(fixtureLoader({ "sha256:a": "old-a", "sha256:b": "old-b" }));
    i.vfs.writeFile("/workspace/checkout/deployment.toml", manifest);
    i.vfs.registerLazy("/workspace/checkout/a.js", "sha256:a", 5);
    i.vfs.registerLazy("/workspace/checkout/b.js", "sha256:b", 5);
    i.vfs.writeFile("/workspace/checkout/a.js", "new-a"); // edit a.js only

    const aDigest = sha256("new-a");
    const host = fakeHost()
        .withErr("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify({ permanent_missing_files: [{ path: "a.js", digest: aDigest }] }))
        .with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_x"));
    app(i, words("deployment submit /workspace/checkout/deployment.toml"), "", host);
    assert.equal(host.calls.length, 2);
    assert.deepEqual(JSON.parse(host.calls[0][1])[1], []);
    assert.deepEqual(JSON.parse(host.calls[1][1])[1], [{ path: "a.js", digest: aDigest, content: "new-a" }]);
});

test("deployment submit rehashes and uploads a pending file with a foreign digest", () => {
    // Simulates a file copied in unmodified from a git/web mount: it is still
    // `pending` (never locally edited), but its digest is the remote's own
    // foreign hash (here a 40-hex git blob SHA-1), not this server's CAS
    // sha256. Submit must not reuse that foreign digest as `content_digest`,
    // nor skip the file as "already uploaded" - it must be fetched, rehashed,
    // and sent like any other new/modified source.
    const manifest = ["[[workflow_js]]", 'location = "a.js"', 'content_digest = "sha256:a"'].join("\n") + "\n";
    const gitSha = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3";
    const i = interp();
    i.vfs.setBlobLoader(fixtureLoader({ [gitSha]: "test" }));
    i.vfs.writeFile("/workspace/checkout/deployment.toml", manifest);
    i.vfs.registerLazy("/workspace/checkout/a.js", gitSha, 4);

    const realDigest = sha256("test");
    const host = fakeHost()
        .withErr("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify({ permanent_missing_files: [{ path: "a.js", digest: realDigest }] }))
        .with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_x"));
    const out = app(i, words("deployment submit /workspace/checkout/deployment.toml"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(host.calls.length, 2);
    const preflight = JSON.parse(host.calls[0][1]);
    assert.equal(preflight[0], `[[workflow_js]]\nlocation = "a.js"\ncontent_digest = "${realDigest}"\n`);
    const retry = JSON.parse(host.calls[1][1]);
    assert.deepEqual(retry[1], [{ path: "a.js", digest: realDigest, content: "test" }]);
});

test("deployment submit pins a digest for a new component with no content_digest line", () => {
    const manifest = ['[[activity_js]]', 'name = "program_http"', 'location = "activity/http.js"'].join("\n") + "\n";
    const i = interp();
    i.vfs.writeFile("/workspace/checkout/deployment.toml", manifest);
    i.vfs.writeFile("/workspace/checkout/activity/http.js", "export default 1");

    const digest = sha256("export default 1");
    const host = fakeHost()
        .withErr("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify({ permanent_missing_files: [{ path: "activity/http.js", digest }] }))
        .with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_x"));
    const out = app(i, words("deployment submit /workspace/checkout/deployment.toml"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    const preflight = JSON.parse(host.calls[0][1]);
    assert.equal(
        preflight[0],
        `[[activity_js]]\nname = "program_http"\nlocation = "activity/http.js"\ncontent_digest = "${digest}"\n`,
    );
    const retry = JSON.parse(host.calls[1][1]);
    assert.deepEqual(retry[1], [{ path: "activity/http.js", digest, content: "export default 1" }]);
});

test("deployment submit generates WIT and JS module component files", () => {
    const manifest = [
        "[[activity_js]]",
        'name = "multi"',
        'ffqn = "test:pkg/api.run"',
        'wit = "wit"',
        'location = "src/index.js"',
    ].join("\n") + "\n";
    const i = interp();
    i.vfs.writeFile("/workspace/checkout/deployment.toml", manifest);
    i.vfs.writeFile("/workspace/checkout/src/index.js", 'import { value } from "./lib.js"; export default () => value;');
    i.vfs.writeFile("/workspace/checkout/src/lib.js", "export const value = 1;");
    i.vfs.writeFile("/workspace/checkout/wit/world.wit", "package test:pkg; world api { export run: func(); }");
    i.vfs.writeFile("/workspace/checkout/wit/deps/dep/dep.wit", "package test:dep; interface unused {}");

    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_x"));
    const out = app(i, words("deployment submit /workspace/checkout/deployment.toml"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    const prepared = JSON.parse(host.calls[0][1])[0];
    for (const path of ["src/index.js", "src/lib.js", "wit/world.wit", "wit/deps/dep/dep.wit"]) {
        assert.ok(prepared.includes(`"${path}" = "sha256:`), prepared);
    }
});

test("deployment submit does not mistake a later comment for an export...from clause", () => {
    // Regression: the `from` scanner used to lazily skip across an entire
    // function body (including comments) looking for the next `from "..."`
    // anywhere in the file, so `export default async function` paired with
    // an unrelated later comment containing `from "..."` was misread as a
    // bare module specifier.
    const manifest = [
        "[[activity_js]]",
        'name = "chat"',
        'ffqn = "test:pkg/api.run"',
        'wit = "wit"',
        'location = "src/index.js"',
    ].join("\n") + "\n";
    const i = interp();
    i.vfs.writeFile("/workspace/checkout/deployment.toml", manifest);
    i.vfs.writeFile(
        "/workspace/checkout/src/index.js",
        [
            "export default async function chat(stdin, args) {",
            "    return stdin;",
            "}",
            "",
            "// Empty when it is still working, so callers can tell apart",
            '// from "it finished with an empty message".',
        ].join("\n"),
    );
    i.vfs.writeFile("/workspace/checkout/wit/world.wit", "package test:pkg; world api { export run: func(); }");

    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_x"));
    const out = app(i, words("deployment submit /workspace/checkout/deployment.toml"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
});

test("deployment submit propagates a terminal (non-missing-files) error", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp();
    i.vfs.writeFile("/workspace/checkout/deployment.toml", manifest);
    const host = fakeHost().withErr("obelisk-agent:tools/webapi.deployment-submit", "deployment cannot be submitted: unexpected files: x");
    const out = app(i, words("deployment submit /workspace/checkout/deployment.toml"), "", host);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /unexpected files/);
    assert.equal(host.calls.length, 1);
});

test("deployment submit stops instead of looping forever when a blob stays missing", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp();
    i.vfs.writeFile("/workspace/checkout/deployment.toml", manifest);
    i.vfs.writeFile("/workspace/checkout/a.wasm", "bytes");
    const missing = JSON.stringify({ permanent_missing_files: [{ path: "a.wasm", digest: "sha256:zz" }] });
    const host = fakeHost()
        .withErr("obelisk-agent:tools/webapi.deployment-submit", missing)
        .withErr("obelisk-agent:tools/webapi.deployment-submit", missing);
    const out = app(i, words("deployment submit /workspace/checkout/deployment.toml"), "", host);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /still missing/);
    assert.equal(host.calls.length, 2);
});

test("deploymentSources reports only files present under the deployment dir", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\n[[activity_wasm]]\nlocation = "b.wasm"\n';
    const fs = new Vfs();
    fs.writeFile("/workspace/checkout/a.wasm", "x");
    // b.wasm is not present at all -> excluded from the report.
    assert.deepEqual(deploymentSources(fs, "/workspace/checkout", manifest), ["a.wasm"]);
});

// -- obelisk cloud --

// A fake `obelisk-agent:tools/cloud`: records provisioner runs and hands out `apps[name]` control planes.
function fakeCloud(apps = {}) {
    const cloud = {
        runs: [],
        deploys: [],
        run(args, stdin, appToml) {
            cloud.runs.push({ args, stdin, appToml });
            return { stdout: "ok\n", stderr: "", exitCode: 0 };
        },
        prepareDeploy(app, appToml) {
            cloud.deploys.push({ app, appToml });
            return { apiUrl: "https://demo.test", log: "→ prepare\n" };
        },
        finishDeploy(app, appToml, deploymentId) {
            cloud.deploys.push({ app, appToml, deploymentId });
            return { webhookUrl: "https://demo.test/hook", log: "→ finish\n" };
        },
        controlPlane(app) {
            if (!apps[app]) throw `no app ${app}`;
            return apps[app];
        },
    };
    return cloud;
}

test("cloud app deploy prepares the app, enqueues the deployment there, then finishes with its id", () => {
    const i = interp("/workspace/app");
    i.vfs.writeFile("/workspace/app/app.toml", 'app_name = "demo"\n');
    i.vfs.writeFile("/workspace/app/deployment.toml", '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n');
    const app = fakeHost()
        .with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_new"))
        .with("obelisk-agent:tools/webapi.deployment-switch", JSON.stringify({ ok: "restart_required" }));
    const local = fakeHost();
    const cloud = fakeCloud({ demo: app });
    const out = executeObelisk(i, words("cloud app deploy"), "", local, null, cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    const policy = 'app_name = "demo"\n';
    assert.deepEqual(cloud.deploys, [{ app: "demo", appToml: policy }, { app: "demo", appToml: policy, deploymentId: "Dep_new" }]);
    assert.deepEqual(app.calls.at(-1), ["obelisk-agent:tools/webapi.deployment-switch", JSON.stringify(["Dep_new", true])]);
    assert.equal(out.stdout, "https://demo.test/hook\n");
    assert.equal(out.stderr, "→ prepare\n→ obelisk cloud app deployment enqueue\n→ finish\nDeployed demo\n");
    assert.equal(local.calls.length, 0);
});

test("cloud app deploy stops before applying when the enqueue fails", () => {
    const i = interp("/workspace/app");
    i.vfs.writeFile("/workspace/app/app.toml", 'app_name = "demo"\n');
    i.vfs.writeFile("/workspace/app/deployment.toml", '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n');
    const app = fakeHost().withErr("obelisk-agent:tools/webapi.deployment-submit", "invalid deployment");
    const cloud = fakeCloud({ demo: app });
    const out = executeObelisk(i, words("cloud app deploy"), "", fakeHost(), null, cloud);
    assert.notEqual(out.exitCode, 0);
    assert.match(out.stderr, /Deployment staging failed; inspect `obelisk cloud app --app demo status` and retry deploy: .*invalid deployment/);
    assert.equal(cloud.deploys.length, 1);
});

test("cloud app API subcommands run against the selected app's control plane", () => {
    const app = fakeHost().with("obelisk-agent:tools/webapi.get-execution", JSON.stringify({ execution_id: "E_1" }));
    const out = executeObelisk(interp(), words("cloud app --app demo executions get E_1"), "", fakeHost(), null, fakeCloud({ demo: app }));
    assert.equal(out.exitCode, 0, out.stderr);
    assert.deepEqual(app.calls, [["obelisk-agent:tools/webapi.get-execution", JSON.stringify(["E_1"])]]);
});

test("cloud secrets set --from-env sends the variable as stdin", () => {
    const i = interp();
    i.setVar("API_KEY", "s3cret");
    const cloud = fakeCloud();
    const out = executeObelisk(i, words("cloud app --app demo secrets set API_KEY --from-env API_KEY"), "", fakeHost(), null, cloud);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.deepEqual(cloud.runs, [{ args: words("app --app demo secrets set API_KEY --stdin"), stdin: "s3cret", appToml: null }]);
});

test("cloud without the cloud tools is an error", () => {
    const out = executeObelisk(interp(), words("cloud apps list"), "", fakeHost());
    assert.equal(out.exitCode !== 0, true);
    assert.match(out.stderr, /not available/);
});
