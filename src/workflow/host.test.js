import { test } from "node:test";
import assert from "node:assert/strict";
import { createCloud, decodeChildErrorValue } from "./host.js";
import { Bash } from "../vendor/just-bash/src/bash.js";
import { commandHandler } from "../vendor/just-bash/src/obelisk-pack.js";
import { sha256Hex } from "../vendor/just-bash/src/commands/hash.js";
import { utf8Encode } from "../vendor/just-bash/src/utf8.js";

test("child activity errors decode string-or-variant values", () => {
    assert.equal(decodeChildErrorValue("bad input"), "bad input");
    assert.equal(decodeChildErrorValue({ permanent_error: "bad input" }), "bad input");
    assert.equal(decodeChildErrorValue({ transient_error: "try again" }), "try again");
    assert.equal(decodeChildErrorValue({ other: "detail" }), '{"other":"detail"}');
});

test("deployment submit invokes a separate retryable activity for each requested file and manifest", () => {
    const deployment = "/v1/deployments/Dep_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const sources = ["export default () => 1;", "export default () => 2;"];
    const missing = sources.map((source, index) => ({ path: `${index}.js`, digest: `sha256:${sha256Hex(utf8Encode(source))}`, field_path: `activity_js[${index}].location` }));
    const uploads = [];
    const mutations = [];
    const cloud = createCloud({
        upload(app, path, contentType, body) {
            uploads.push({ app, path, contentType, body });
            return path === deployment && uploads.length === 1
                ? { status: 409, body: JSON.stringify({ missing_files: missing }) }
                : { status: 204, body: "" };
        },
        tenant(...args) {
            mutations.push(args);
            return { status: 428, body: "requires a precondition" };
        },
    }, {});
    const bash = new Bash({ cwd: "/workspace" });
    bash.registerCommand("obelisk", commandHandler(null, cloud));
    bash.vfs.writeFile("/workspace/deployment.toml", sources.map((_, index) => `[[activity_js]]\nlocation = "${index}.js"\n`).join(""));
    sources.forEach((source, index) => bash.vfs.writeFile(`/workspace/${index}.js`, source));
    const result = bash.exec("obelisk cloud app deployment submit --app demo --deployment-id Dep_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(uploads.map(({ path }) => path), [deployment, ...missing.map(({ digest }) => `/v1/files/${digest}`), deployment]);
    assert.deepEqual(uploads.slice(1, 3).map(({ body }) => body), sources);
    assert.equal(uploads[0].body, uploads[3].body);
    assert.equal(mutations.length, 0);

    for (const [method, path] of [["PUT", `${deployment}/switch`], ["DELETE", deployment], ["POST", "/v1/executions"]]) {
        assert.equal(cloud.send("demo", method, path, "application/json", "{}").status, 428);
    }
    assert.equal(mutations.length, 3);
    assert.equal(uploads.length, 4);
});
