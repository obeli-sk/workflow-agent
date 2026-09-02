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

const { executeObelisk, commandHandler, mount, refreshDeploymentMount, registerDeferredMount, blobLoader,
    simplifyManifest, manifestWithDigests, ownedSourceLocations, deploymentSources } = obelisk;

// A fake host backed by an in-memory ffqn -> canned-JSON-response queue, for
// tests only. A call to an ffqn with no fixture throws, mirroring a call to
// something nothing implements. Multiple `.with`/`.withErr` calls for one
// ffqn enqueue successive responses (so a test can model a preflight that
// reports missing files then a retry that succeeds); the last response
// repeats once the queue is down to one. Records every call so tests can
// assert on the exact params sent.
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
    };
    return host;
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
    let out = executeObelisk(i, words("deployment -h"), "", host);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /^Usage: obelisk deployment/);

    out = executeObelisk(i, words("deployment submit --help"), "", host);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /PATH-TO-DEPLOYMENT\.TOML/);

    // `call -h` reaches the call help even though the ffqn sits in the
    // action slot, but a help flag after `--` is a positional parameter.
    out = executeObelisk(i, words("call -h"), "", host);
    assert.equal(out.exitCode, 0);
    assert.match(out.stdout, /^Usage: obelisk call/);

    assert.equal(host.calls.length, 0, "no help path ever hits the host");
});

test("command groups with no action fall through to unknown-command", () => {
    const host = fakeHost();
    const i = interp();
    for (const group of ["functions", "executions", "deployment"]) {
        const out = executeObelisk(i, [group], "", host);
        assert.equal(out.exitCode, 2);
        assert.notEqual(out.stderr, "");
    }
    assert.equal(host.calls.length, 0);
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
    const out = executeObelisk(interp(), words("functions list --prefix foo --length 5"), "", host);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "foo:bar/api.run : func(input: string, retries: u32) -> result<string, error>\n");
    assert.equal(host.calls[0][1], JSON.stringify(["foo", 5]));
});

test("functions list --json preserves structured output", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.list-functions", JSON.stringify([{ ffqn: "a", extension: null }]));
    const out = executeObelisk(interp(), words("functions list --json"), "", host);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, '[\n  {\n    "ffqn": "a",\n    "extension": null\n  }\n]\n');
});

test("functions list defaults when flags absent", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.list-functions", "[]");
    executeObelisk(interp(), words("functions list"), "", host);
    assert.equal(host.calls[0][1], JSON.stringify(["", 100]));
});

test("functions list formats a double-JSON-encoded body (backcompat)", () => {
    const host = fakeHost().with(
        "obelisk-agent:tools/webapi.list-functions",
        JSON.stringify(JSON.stringify([{ ffqn: "a", parameter_types: [], return_type: "string", extension: null }])),
    );
    const out = executeObelisk(interp(), words("functions list"), "", host);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "a : func() -> string\n");
});

test("functions wit prints non-JSON text verbatim", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.get-function-wit", JSON.stringify("interface foo { bar: func() }"));
    const out = executeObelisk(interp(), words("functions wit a:b/c.d"), "", host);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "interface foo { bar: func() }\n");
});

test("functions wit requires ffqn", () => {
    const out = executeObelisk(interp(), words("functions wit"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk: ffqn is required\n");
});

test("executions list forwards all flags in order", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.list-executions", "[]");
    executeObelisk(interp(), words("executions list --ffqn-prefix pfx --show-derived --length 7"), "", host);
    assert.equal(host.calls[0][1], JSON.stringify(["pfx", "", true, false, "", "", "", "", false, 7]));
});

test("executions get requires id", () => {
    const out = executeObelisk(interp(), words("executions get"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk: execution id is required\n");
});

test("executions logs forwards id and length", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.get-logs", JSON.stringify("log"));
    const out = executeObelisk(interp(), words("executions logs exec-1 --length 50"), "", host);
    assert.equal(out.stdout, "log\n");
    assert.equal(host.calls[0][1], JSON.stringify(["exec-1", true, true, true, [], [], "", "", false, 50]));
});

test("executions result forwards id", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.get-result-json", JSON.stringify({ ok: 1 }));
    const out = executeObelisk(interp(), words("executions result exec-1"), "", host);
    assert.equal(out.stdout, '{\n  "ok": 1\n}\n');
});

test("call uses explicit params over stdin", () => {
    const host = fakeHost().with("obelisk-control:tools/native.call", "42");
    const out = executeObelisk(interp(), words("call some:ffqn [1]"), "[2]", host);
    assert.equal(out.stdout, "42\n");
    assert.equal(host.calls[0][1], JSON.stringify(["some:ffqn", "[1]"]));
});

test("call prints only the target result", () => {
    let host = fakeHost().with("obelisk-control:tools/native.call", JSON.stringify(JSON.stringify({ answer: 42 })));
    let out = executeObelisk(interp(), words("call some:ffqn []"), "", host);
    assert.equal(out.stdout, '{\n  "answer": 42\n}\n');

    host = fakeHost().with("obelisk-control:tools/native.call", JSON.stringify(JSON.stringify("plain result")));
    out = executeObelisk(interp(), words("call some:ffqn []"), "", host);
    assert.equal(out.stdout, "plain result\n");
});

test("call failure is a command error, not a result", () => {
    const out = executeObelisk(interp(), words("call some:ffqn []"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stdout, "");
    assert.match(out.stderr, /^obelisk: no fixture for/);
});

test("call falls back to stdin then to an empty array", () => {
    let host = fakeHost().with("obelisk-control:tools/native.call", "1");
    executeObelisk(interp(), words("call some:ffqn"), "[9]", host);
    assert.equal(host.calls[0][1], JSON.stringify(["some:ffqn", "[9]"]));

    host = fakeHost().with("obelisk-control:tools/native.call", "1");
    executeObelisk(interp(), words("call some:ffqn"), "", host);
    assert.equal(host.calls[0][1], JSON.stringify(["some:ffqn", "[]"]));
});

test("call accepts positional params after --", () => {
    const host = fakeHost().with("obelisk-control:tools/native.call", "1");
    executeObelisk(
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
    const out = executeObelisk(interp(), words("call some:ffqn 1 2"), "", host);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /expected one params JSON array/);
    assert.equal(host.calls.length, 0);
});

test("call rejects an explicitly empty params argument", () => {
    const host = fakeHost().with("obelisk-control:tools/native.call", "1");
    const out = executeObelisk(interp(), ["call", "some:ffqn", ""], "", host);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /params-json argument is empty/);
    assert.equal(host.calls.length, 0);
});

test("call requires ffqn", () => {
    const out = executeObelisk(interp(), words("call"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk: ffqn is required\n");
});

test("deployment current calls host", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify("dep-1"));
    const out = executeObelisk(interp(), words("deployment current"), "", host);
    assert.equal(out.stdout, "dep-1\n");
});

test("deployment switch requires id and forwards the flag", () => {
    const i = interp();
    let out = executeObelisk(i, words("deployment switch"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk: deployment id is required\n");

    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-switch", "null");
    executeObelisk(i, words("deployment switch dep-2 --allow-missing-runtime-config"), "", host);
    assert.equal(host.calls[0][1], JSON.stringify(["dep-2", true]));
});

test("deployment apply requires id", () => {
    const out = executeObelisk(interp(), words("deployment apply"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk: deployment id is required\n");
});

test("deployment unknown action", () => {
    const out = executeObelisk(interp(), words("deployment bogus"), "", fakeHost());
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

test("generate requires a known subcommand", () => {
    let out = executeObelisk(interp(), words("generate"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /a subcommand is required/);

    out = executeObelisk(interp(), words("generate bogus"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.equal(out.stderr, "obelisk generate: unknown action 'bogus'\n");
});

test("a host error propagates with the obelisk: prefix", () => {
    const out = executeObelisk(interp(), words("functions list"), "", fakeHost());
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /^obelisk: no fixture for/);
});

test("commandHandler strips the command name before dispatch", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.list-functions", "[]");
    const bash = new Bash({ cwd: "/workspace" });
    bash.registerCommand("obelisk", commandHandler(host));
    const out = bash.exec("obelisk functions list | cat");
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

test("manifestWithDigests expands component_files and backtrace, pinning digests from file bytes", () => {
    const collapsed = [
        "[[webhook_endpoint]]",
        'location = "webhook/ui-api.js"',
        'component_files = { "webhook/ui-api.js" = "auto", "webhook/ui/shell.js" = "auto" }',
        "[webhook_endpoint.backtrace.sources]",
        '"/abs/src/lib.rs" = "src/lib.rs"',
        "",
    ].join("\n");
    const i = interp();
    const dir = "/workspace/deployment/current";
    i.vfs.writeFile(`${dir}/webhook/ui-api.js`, "api");
    i.vfs.writeFile(`${dir}/webhook/ui/shell.js`, "shell");
    i.vfs.writeFile(`${dir}/src/lib.rs`, "rs");

    const api = sha256("api");
    const shell = sha256("shell");
    const rs = sha256("rs");
    const expected = [
        "[[webhook_endpoint]]",
        'location = "webhook/ui-api.js"',
        `component_files = { "webhook/ui-api.js" = "${api}", "webhook/ui/shell.js" = "${shell}" }`,
        `content_digest = "${api}"`,
        "[webhook_endpoint.backtrace.sources]",
        `"/abs/src/lib.rs" = { path = "src/lib.rs", content_digest = "${rs}" }`,
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

// -- the deployment-mount VFS layout --

test("mount checks out the deployment and symlinks current", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const host = fakeHost()
        .with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify("dep-1"))
        .with(
            "obelisk-agent:tools/webapi.deployment-checkout",
            JSON.stringify({ deployment_toml: manifest, files: [{ path: "a.wasm", digest: "sha256:1", size: 12 }] }),
        );
    const fs = new Vfs();
    const result = mount(fs, host);
    assert.deepEqual(result, { deploymentId: "dep-1", files: 2 });
    assert.ok(!host.calls.some(([ffqn]) => ffqn === "obelisk-agent:tools/webapi.deployment-read-blob"));
    assert.ok(fs.isDir("/workspace/deployment/current"));
    assert.equal(fs.readFile("/workspace/deployment/current/deployment.toml"), simplifyManifest(manifest));
    assert.ok(fs.isFile("/workspace/deployment/current/a.wasm"));

    fs.setBlobLoader(fixtureLoader({ "sha256:1": "binary-bytes" }));
    assert.equal(fs.readFile("/workspace/deployment/current/a.wasm"), "binary-bytes");
    assert.equal(fs.readFile("/workspace/deployment/dep-1/a.wasm"), "binary-bytes");
});

test("mount registers backtrace sources from the nested table", () => {
    const manifest = [
        "[[workflow_wasm]]",
        'name = "wf"',
        'location = "components/w.wasm"',
        'content_digest = "sha256:1"',
        "",
        "[workflow_wasm.backtrace.sources]",
        '".../src/lib.rs" = { path = "workflow/workflow-rs/src/lib.rs", content_digest = "sha256:2" }',
        "",
    ].join("\n");
    const host = fakeHost()
        .with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify("dep-1"))
        .with(
            "obelisk-agent:tools/webapi.deployment-checkout",
            JSON.stringify({
                deployment_toml: manifest,
                files: [
                    { path: "components/w.wasm", digest: "sha256:1", size: 12 },
                    { path: "workflow/workflow-rs/src/lib.rs", digest: "sha256:2", size: 16 },
                ],
            }),
        );
    const fs = new Vfs();
    const result = mount(fs, host);
    assert.equal(result.files, 3); // manifest + wasm + backtrace source
    assert.ok(fs.isFile("/workspace/deployment/current/workflow/workflow-rs/src/lib.rs"));
    fs.setBlobLoader(fixtureLoader({ "sha256:2": "fn workflow() {}" }));
    assert.equal(fs.readFile("/workspace/deployment/current/workflow/workflow-rs/src/lib.rs"), "fn workflow() {}");
});

test("mount peels a double-quoted deployment id before checkout", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const host = fakeHost()
        .with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify(JSON.stringify("Dep_X")))
        .with(
            "obelisk-agent:tools/webapi.deployment-checkout",
            JSON.stringify(
                JSON.stringify({ deployment_toml: manifest, files: [{ path: "a.wasm", digest: "sha256:1", size: 5 }] }),
            ),
        );
    const fs = new Vfs();
    const result = mount(fs, host);
    assert.equal(result.deploymentId, "Dep_X");
    assert.deepEqual(host.calls[1], ["obelisk-agent:tools/webapi.deployment-checkout", JSON.stringify(["Dep_X"])]);
    assert.ok(fs.isDir("/workspace/deployment/Dep_X"));
});

test("mount with no active deployment is a no-op", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify(""));
    const fs = new Vfs();
    const result = mount(fs, host);
    assert.deepEqual(result, { deploymentId: null, files: 0 });
    assert.ok(!fs.exists("/workspace/deployment"));
});

test("refresh replaces the manifest and repoints current at the new dir", () => {
    const v1 = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const v2 = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:2"\n';
    const fs = new Vfs();
    fs.setBlobLoader(fixtureLoader({ "sha256:1": "v1", "sha256:2": "v2" }));

    const host1 = fakeHost()
        .with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify("dep-1"))
        .with(
            "obelisk-agent:tools/webapi.deployment-checkout",
            JSON.stringify({ deployment_toml: v1, files: [{ path: "a.wasm", digest: "sha256:1", size: 2 }] }),
        );
    mount(fs, host1);

    const host2 = fakeHost()
        .with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify("dep-2"))
        .with(
            "obelisk-agent:tools/webapi.deployment-checkout",
            JSON.stringify({ deployment_toml: v2, files: [{ path: "a.wasm", digest: "sha256:2", size: 2 }] }),
        );
    const result = refreshDeploymentMount(fs, host2, true);
    assert.equal(result.deploymentId, "dep-2");
    assert.equal(fs.readFile("/workspace/deployment/dep-1/a.wasm"), "v1");
    assert.equal(fs.readFile("/workspace/deployment/current/a.wasm"), "v2");
});

test("blobLoader decodes a plain string body via the read-blob ffqn", () => {
    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-read-blob", JSON.stringify("bytes"));
    const loader = blobLoader(host);
    assert.equal(loader("sha256:1"), "bytes");
    assert.equal(host.calls[0][1], JSON.stringify(["sha256:1"]));
});

// -- deployment CLI actions that touch the mount --

test("deployment refresh calls mount and reports JSON", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const host = fakeHost()
        .with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify("dep-1"))
        .with(
            "obelisk-agent:tools/webapi.deployment-checkout",
            JSON.stringify({ deployment_toml: manifest, files: [{ path: "a.wasm", digest: "sha256:1", size: 5 }] }),
        );
    const out = executeObelisk(interp(), words("deployment refresh"), "", host);
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, '{\n  "deployment_id": "dep-1",\n  "files": 2\n}\n');
});

test("deployment check reports the manifest size and owned sources", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp();
    i.vfs.writeFile("/workspace/deployment/dep-1/deployment.toml", manifest);
    i.vfs.writeFile("/workspace/deployment/dep-1/a.wasm", "bytes");
    const out = executeObelisk(i, words("deployment check /workspace/deployment/dep-1"), "", fakeHost());
    assert.equal(out.exitCode, 0, out.stderr);
    const parsed = JSON.parse(out.stdout);
    assert.equal(parsed.directory, "/workspace/deployment/dep-1");
    assert.deepEqual(parsed.owned_sources, ["a.wasm"]);
});

test("deployment check defaults its directory to cwd", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp("/workspace/deployment/current");
    i.vfs.writeFile("/workspace/deployment/current/deployment.toml", manifest);
    const out = executeObelisk(i, words("deployment check"), "", fakeHost());
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).directory, "/workspace/deployment/current");
});

test("deployment submit preflights, then attaches the missing blob", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp();
    i.vfs.writeFile("/workspace/deployment/dep-1/deployment.toml", manifest);
    i.vfs.writeFile("/workspace/deployment/dep-1/a.wasm", "bytes");
    const digest = sha256("bytes");
    const host = fakeHost()
        .withErr("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify({ permanent_missing_files: [{ path: "a.wasm", digest }] }))
        .with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_new"));
    const out = executeObelisk(i, words("deployment submit /workspace/deployment/dep-1"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.match(out.stdout, /Dep_new/);

    const preflight = JSON.parse(host.calls[0][1]);
    assert.equal(preflight[0], `[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "${digest}"\n`);
    assert.deepEqual(preflight[1], []);
    assert.equal(preflight[2], "Submitted from workflow-agent VFS");
    assert.equal(preflight[3], false);
    assert.equal(preflight[4], "dep-1");

    const retry = JSON.parse(host.calls[1][1]);
    assert.deepEqual(retry[1], [{ path: "a.wasm", digest, content: "bytes" }]);
});

test("deployment submit from current sends an empty deployment id", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp();
    i.vfs.writeFile("/workspace/deployment/current/deployment.toml", manifest);
    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_x"));
    executeObelisk(i, words("deployment submit /workspace/deployment/current"), "", host);
    assert.equal(JSON.parse(host.calls[0][1])[4], "");
});

test("deployment submit options do not shadow the path", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp("/workspace/deployment/current");
    i.vfs.writeFile("/workspace/deployment/current/deployment.toml", manifest);
    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_x"));
    const out = executeObelisk(i, words("deployment submit --description wh"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    const params = JSON.parse(host.calls[0][1]);
    assert.equal(params[2], "wh");
    assert.equal(params[4], "");
});

test("deployment submit accepts a path to the toml file itself", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp();
    i.vfs.writeFile("/workspace/deployment/dep-1/deployment.toml", manifest);
    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_new"));
    const out = executeObelisk(i, words("deployment submit /workspace/deployment/dep-1/deployment.toml"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    assert.equal(JSON.parse(host.calls[0][1])[4], "dep-1");
});

test("deployment submit skips unmodified lazy sources", () => {
    const manifest = [
        "[[workflow_wasm]]",
        'location = "w.wasm"',
        'content_digest = "sha256:1"',
        "[workflow_wasm.backtrace.sources]",
        '"w.wasm" = { path = "src/lib.rs", content_digest = "sha256:2" }',
    ].join("\n") + "\n";
    const i = interp();
    i.vfs.setBlobLoader(fixtureLoader({ "sha256:1": "wasm-bytes", "sha256:2": "rust source" }));
    i.vfs.writeFile("/workspace/deployment/current/deployment.toml", manifest);
    i.vfs.registerLazy("/workspace/deployment/current/w.wasm", "sha256:1", 10);
    i.vfs.registerLazy("/workspace/deployment/current/src/lib.rs", "sha256:2", 11);

    const host = fakeHost().with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_x"));
    const out = executeObelisk(i, words("deployment submit /workspace/deployment/current"), "", host);
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
    i.vfs.writeFile("/workspace/deployment/current/deployment.toml", manifest);
    i.vfs.registerLazy("/workspace/deployment/current/a.js", "sha256:a", 5);
    i.vfs.registerLazy("/workspace/deployment/current/b.js", "sha256:b", 5);
    i.vfs.writeFile("/workspace/deployment/current/a.js", "new-a"); // edit a.js only

    const aDigest = sha256("new-a");
    const host = fakeHost()
        .withErr("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify({ permanent_missing_files: [{ path: "a.js", digest: aDigest }] }))
        .with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_x"));
    executeObelisk(i, words("deployment submit /workspace/deployment/current"), "", host);
    assert.equal(host.calls.length, 2);
    assert.deepEqual(JSON.parse(host.calls[0][1])[1], []);
    assert.deepEqual(JSON.parse(host.calls[1][1])[1], [{ path: "a.js", digest: aDigest, content: "new-a" }]);
});

test("deployment submit pins a digest for a new component with no content_digest line", () => {
    const manifest = ['[[activity_js]]', 'name = "program_http"', 'location = "activity/http.js"'].join("\n") + "\n";
    const i = interp();
    i.vfs.writeFile("/workspace/deployment/current/deployment.toml", manifest);
    i.vfs.writeFile("/workspace/deployment/current/activity/http.js", "export default 1");

    const digest = sha256("export default 1");
    const host = fakeHost()
        .withErr("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify({ permanent_missing_files: [{ path: "activity/http.js", digest }] }))
        .with("obelisk-agent:tools/webapi.deployment-submit", JSON.stringify("Dep_x"));
    const out = executeObelisk(i, words("deployment submit /workspace/deployment/current"), "", host);
    assert.equal(out.exitCode, 0, out.stderr);
    const preflight = JSON.parse(host.calls[0][1]);
    assert.equal(
        preflight[0],
        `[[activity_js]]\nname = "program_http"\nlocation = "activity/http.js"\ncontent_digest = "${digest}"\n`,
    );
    const retry = JSON.parse(host.calls[1][1]);
    assert.deepEqual(retry[1], [{ path: "activity/http.js", digest, content: "export default 1" }]);
});

test("deployment submit propagates a terminal (non-missing-files) error", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp();
    i.vfs.writeFile("/workspace/deployment/current/deployment.toml", manifest);
    const host = fakeHost().withErr("obelisk-agent:tools/webapi.deployment-submit", "deployment cannot be submitted: unexpected files: x");
    const out = executeObelisk(i, words("deployment submit /workspace/deployment/current"), "", host);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /unexpected files/);
    assert.equal(host.calls.length, 1);
});

test("deployment submit stops instead of looping forever when a blob stays missing", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const i = interp();
    i.vfs.writeFile("/workspace/deployment/current/deployment.toml", manifest);
    i.vfs.writeFile("/workspace/deployment/current/a.wasm", "bytes");
    const missing = JSON.stringify({ permanent_missing_files: [{ path: "a.wasm", digest: "sha256:zz" }] });
    const host = fakeHost()
        .withErr("obelisk-agent:tools/webapi.deployment-submit", missing)
        .withErr("obelisk-agent:tools/webapi.deployment-submit", missing);
    const out = executeObelisk(i, words("deployment submit /workspace/deployment/current"), "", host);
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /still missing/);
    assert.equal(host.calls.length, 2);
});

// -- deferred deployment mount --

test("registerDeferredMount does not touch the host until the tree is accessed", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\ncontent_digest = "sha256:1"\n';
    const host = fakeHost()
        .with("obelisk-agent:tools/webapi.current-deployment-id", JSON.stringify("dep-1"))
        .with(
            "obelisk-agent:tools/webapi.deployment-checkout",
            JSON.stringify({ deployment_toml: manifest, files: [{ path: "a.wasm", digest: "sha256:1", size: 12 }] }),
        );
    const fs = new Vfs();
    registerDeferredMount(fs, host);

    // The root pre-exists (so it lists under its parent) but nothing fired.
    assert.ok(fs.isDir("/workspace/deployment"));
    assert.equal(host.calls.length, 0);

    // A path outside the deployment root never triggers it.
    fs.ensureMountedFor("/workspace/other");
    assert.equal(host.calls.length, 0);

    // The first access under the root fires the checkout.
    fs.ensureMountedFor("/workspace/deployment/current/deployment.toml");
    assert.equal(fs.readFile("/workspace/deployment/current/deployment.toml"), simplifyManifest(manifest));
    assert.equal(host.calls.length, 2);

    // A further access is a no-op (the mount already fired).
    fs.ensureMountedFor("/workspace/deployment");
    assert.equal(host.calls.length, 2);
});

test("registerDeferredMount records a mount failure instead of throwing", () => {
    const host = fakeHost(); // no fixtures: current-deployment-id call fails
    const fs = new Vfs();
    registerDeferredMount(fs, host);
    fs.ensureMountedFor("/workspace/deployment/current");
    assert.match(fs.readFile("/workspace/.mount-error"), /no fixture for/);
});

test("deploymentSources reports only files present under the deployment dir", () => {
    const manifest = '[[activity_wasm]]\nlocation = "a.wasm"\n[[activity_wasm]]\nlocation = "b.wasm"\n';
    const fs = new Vfs();
    fs.writeFile("/workspace/deployment/current/a.wasm", "x");
    // b.wasm is not present at all -> excluded from the report.
    assert.deepEqual(deploymentSources(fs, "/workspace/deployment/current", manifest), ["a.wasm"]);
});
