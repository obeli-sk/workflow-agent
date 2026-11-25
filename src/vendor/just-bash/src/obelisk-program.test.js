import { test } from "node:test";
import assert from "node:assert/strict";
import { commandHandler } from "./obelisk-program.js";

function fakeHost(ffqn, response) {
    const calls = [];
    return {
        calls,
        callJson(actualFfqn, paramsJson) {
            calls.push([actualFfqn, paramsJson]);
            if (actualFfqn !== ffqn) throw `no fixture for ${actualFfqn}`;
            if (response instanceof Error) throw response.message;
            return response;
        },
    };
}

test("program adapter forwards stdin and argv, stripping the command name", () => {
    const host = fakeHost(
        "obelisk-agent:programs/program.curl",
        JSON.stringify({ stdout: "body\n", stderr: "", exit_code: 0 }),
    );
    const handler = commandHandler("curl", "obelisk-agent:programs/program.curl", host);
    const output = handler(null, ["curl", "-s", "https://obeli.sk"], "input");

    assert.equal(output.stdout, "body\n");
    assert.equal(output.stderr, "");
    assert.equal(output.exitCode, 0);
    assert.equal(host.calls[0][1], JSON.stringify(["input", ["-s", "https://obeli.sk"]]));
});

test("malformed program output is a normal command failure, not a throw", () => {
    const host = fakeHost("obelisk-agent:programs/program.curl", JSON.stringify({ stdout: "body" }));
    const handler = commandHandler("curl", "obelisk-agent:programs/program.curl", host);
    const output = handler(null, ["curl"], "");

    assert.equal(output.exitCode, 1);
    assert.equal(output.stderr, "curl: program output has no stderr\n");
});

test("a host error becomes a command failure with the command name prefixed", () => {
    const host = fakeHost("obelisk-agent:programs/program.curl", new Error("tool exploded"));
    const handler = commandHandler("curl", "obelisk-agent:programs/program.curl", host);
    const output = handler(null, ["curl"], "");

    assert.equal(output.exitCode, 1);
    assert.equal(output.stderr, "curl: tool exploded\n");
});
