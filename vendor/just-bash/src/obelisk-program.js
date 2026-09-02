// PORT: vendor/just-bash-rs/src/obelisk_program.rs
//
// Command adapter for Obelisk-backed shell programs with this contract:
// func(stdin: string, args: list<string>) -> result<record {
//     stdout: string, stderr: string, exit-code: u32
// }, string>
//
// `host` is duck-typed as `{ callJson(ffqn, paramsJson) -> string|null }`
// (throws on error), matching workflow-rs's `ObeliskHost` trait so this
// module is host-implementation-agnostic and testable with a plain fake (see
// obelisk-program.test.js) - no `obelisk` global required here.

// Custom-command handlers receive the full argv including argv[0] (see
// interpreter.js's `invoke`), unlike workflow-rs's `CustomCommandHandler`
// (argv[0] already stripped) - `args.slice(1)` below accounts for that.
export function commandHandler(commandName, ffqn, host) {
    return (_interp, args, stdin) => executeProgram(commandName, ffqn, args.slice(1), stdin, host);
}

function executeProgram(commandName, ffqn, args, stdin, host) {
    const params = JSON.stringify([stdin, args]);
    let raw;
    try {
        raw = host.callJson(ffqn, params);
    } catch (error) {
        return failure(commandName, typeof error === "string" ? error : String(error));
    }
    if (raw === null) return failure(commandName, "program returned no output");
    return decodeOutput(commandName, raw);
}

function decodeOutput(commandName, raw) {
    let value;
    try {
        value = JSON.parse(raw);
    } catch (error) {
        return failure(commandName, `program returned invalid JSON: ${error.message}`);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return failure(commandName, "program output was not a record");
    }
    if (typeof value.stdout !== "string") return failure(commandName, "program output has no stdout");
    if (typeof value.stderr !== "string") return failure(commandName, "program output has no stderr");
    if (typeof value.exit_code !== "number") return failure(commandName, "program output has no exit_code");
    return { stdout: value.stdout, stderr: value.stderr, exitCode: value.exit_code };
}

function failure(commandName, message) {
    return { stdout: "", stderr: `${commandName}: ${message}\n`, exitCode: 1 };
}
