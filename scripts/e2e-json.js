#!/usr/bin/env node

import fs from "node:fs";

const command = process.argv[2];
const input = () => fs.readFileSync(0, "utf8");
const json = () => JSON.parse(input());
const executions = (value) => Array.isArray(value) ? value : value.executions ?? [];

switch (command) {
    case "execution-id": {
        const ffqn = process.argv[3];
        const row = executions(json()).find((candidate) => candidate.ffqn === ffqn);
        process.stdout.write(row?.execution_id ?? "");
        break;
    }
    case "execution-ids": {
        const ffqn = process.argv[3];
        const ids = executions(json())
            .filter((candidate) => candidate.ffqn === ffqn)
            .map((candidate) => candidate.execution_id)
            .filter(Boolean);
        process.stdout.write(ids.join("\n"));
        break;
    }
    case "has-execution": {
        const ffqn = process.argv[3];
        process.exit(executions(json()).some((row) => row.ffqn === ffqn) ? 0 : 1);
        break;
    }
    case "input-offer-id": {
        process.stdout.write(json()?.transcript?.input_offer?.id ?? "");
        break;
    }
    case "check-shell-session": {
        const ffqns = executions(json()).map((row) => row.ffqn);
        const valid = !ffqns.includes("obelisk-agent:llm/chat.completion")
            && ffqns.includes("obelisk-agent:programs/program.curl")
            && ffqns.filter((ffqn) => ffqn === "obelisk-agent:agent/session.injection").length >= 2;
        process.exit(valid ? 0 : 1);
        break;
    }
    case "shell-event": {
        // Build the typed injection stub payload for one shell turn. Script is
        // read from a file so multi-line scripts need no shell-side escaping.
        const id = process.argv[3];
        const script = fs.readFileSync(process.argv[4], "utf8");
        process.stdout.write(JSON.stringify({ ok: { shell: { id, script, stdin: "" } } }));
        break;
    }
    case "shell-stdout": {
        // Extract stdout from a record-output result. `execution result -j`
        // yields {ok: {shell_output: {id, script, result}}}. Stderr and a
        // non-zero exit go to stderr so a failing turn is visible in the log.
        const outer = json();
        if (outer && typeof outer === "object" && outer.err !== undefined) {
            console.error(`record-output returned an error: ${JSON.stringify(outer.err)}`);
            process.exit(1);
        }
        const record = outer?.ok?.shell_output;
        if (!record) {
            console.error(`record-output returned an unexpected value: ${JSON.stringify(outer)}`);
            process.exit(1);
        }
        const result = record.result ?? {};
        process.stdout.write(result.stdout ?? "");
        if (result.stderr) process.stderr.write(result.stderr);
        if (result.exit_code) process.stderr.write(`\n[exit ${result.exit_code}]\n`);
        break;
    }
    case "check-shell-notification": {
        const record = json()?.ok?.shell_output;
        const valid = record?.id === "shell-e2e-1"
            && record.turn_index === 0
            && record.turn_complete === true
            && Number.isInteger(record.duration_milliseconds)
            && record.duration_milliseconds >= 0;
        process.exit(valid ? 0 : 1);
        break;
    }
    case "check-shell-projection": {
        const projection = json();
        const transcript = projection?.transcript;
        const output = transcript?.shell_events?.find((event) => event.id === "shell-e2e-1");
        const start = transcript?.turn_starts?.find((event) => event.id === "shell-e2e-1");
        const valid = output?.turn_index === 0
            && output.turn_complete === true
            && typeof start?.created_at === "string"
            && start.created_at.length > 0
            && typeof projection?.transcript?.input_offer?.id === "string"
            && projection.transcript.agent_working === false;
        process.exit(valid ? 0 : 1);
        break;
    }
    case "redeploy-params": {
        const manifest = fs.readFileSync(process.argv[3], "utf8");
        process.stdout.write(JSON.stringify([manifest, "[]", "e2e no-op redeploy", false, ""]));
        break;
    }
    case "deployment-id": {
        const result = json();
        process.stdout.write(result.ok?.deployment_id ?? "");
        break;
    }
    default:
        console.error(`unknown command: ${command ?? ""}`);
        process.exit(2);
}
