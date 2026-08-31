#!/usr/bin/env node

import fs from "node:fs";

const command = process.argv[2];
const input = () => fs.readFileSync(0, "utf8");
const json = () => JSON.parse(input());
const executions = (value) => Array.isArray(value) ? value : value.executions ?? [];
const shellStream = (result, stream) => (result?.output ?? [])
    .map((chunk) => chunk?.[stream])
    .filter((text) => typeof text === "string")
    .join("");

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
    case "response-cursor": {
        process.stdout.write(String(json()?.transcript?.response_cursor ?? 0));
        break;
    }
    case "pending-ask-id": {
        process.stdout.write(json()?.transcript?.human_input_events
            ?.findLast((event) => event.kind === "requested")?.id ?? "");
        break;
    }
    case "shell-input": {
        const offerId = process.argv[3];
        const id = process.argv[4];
        const script = process.argv[5];
        process.stdout.write(JSON.stringify({
            offer_id: offerId,
            input: { shell: { id, script, stdin: "" } },
        }));
        break;
    }
    case "check-shell-session": {
        const ffqns = executions(json()).map((row) => row.ffqn);
        const valid = !ffqns.includes("obelisk-agent:llm/chat.completion")
            && ffqns.includes("obelisk-agent:programs/program.curl")
            && ffqns.filter((ffqn) => ffqn === "obelisk-agent:stub/stub.injection").length >= 2;
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
        process.stdout.write(shellStream(result, "stdout"));
        process.stderr.write(shellStream(result, "stderr"));
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
            && start.created_at !== output.created_at
            && typeof projection?.transcript?.input_offer?.id === "string"
            && projection.transcript.agent_working !== true;
        if (!valid) console.error(`unexpected shell projection: ${JSON.stringify(projection)}`);
        process.exit(valid ? 0 : 1);
        break;
    }
    case "check-agent-error": {
        const projection = json();
        const expected = process.argv[3];
        const error = projection?.transcript?.replies
            ?.find((candidate) => candidate?.reply?.error?.includes(expected));
        const valid = Boolean(error)
            && error.turn_complete === true
            && typeof projection?.transcript?.input_offer?.id === "string"
            && projection.transcript.input_offer.id.length > 0
            && projection.transcript.agent_working === false;
        if (!valid) console.error(`expected recovered agent error: ${JSON.stringify(projection)}`);
        process.exit(valid ? 0 : 1);
        break;
    }
    case "check-human-input-request": {
        const projection = json();
        const event = projection?.transcript?.human_input_events
            ?.find((candidate) => candidate.kind === "requested");
        const valid = typeof event?.id === "string"
            && event.id.length > 0
            && event.question === "Continue?"
            && event.turn_index === 0;
        if (!valid) console.error(`unexpected human input request: ${JSON.stringify(projection)}`);
        process.exit(valid ? 0 : 1);
        break;
    }
    case "check-human-input-resolved": {
        const projection = json();
        const events = projection?.transcript?.human_input_events || [];
        const requested = events.find((event) => event.kind === "requested");
        const resolved = events.find((event) => event.kind === "resolved" && event.id === requested?.id);
        const shell = projection?.transcript?.shell_events
            ?.find((event) => event.id === "shell-e2e-ask");
        const valid = Boolean(requested && resolved)
            && shellStream(shell?.result, "stdout") === "yes\n"
            && shell?.result?.exit_code === 0
            && shell.turn_complete === true;
        if (!valid) console.error(`unexpected resolved human input: ${JSON.stringify(projection)}`);
        process.exit(valid ? 0 : 1);
        break;
    }
    case "interrupt-offer": {
        // Offer id published for a still-running script (shell-started event).
        const id = process.argv[3];
        const start = json()?.transcript?.shell_starts?.find((candidate) => candidate.id === id);
        process.stdout.write(start?.offer_id ?? "");
        break;
    }
    case "check-shell-interrupted": {
        const [id, exitCode, kind] = [process.argv[3], Number(process.argv[4]), process.argv[5]];
        const event = json()?.transcript?.shell_events?.find((candidate) => candidate.id === id);
        const valid = event?.turn_complete === true
            && event?.result?.exit_code === exitCode
            && event?.result?.interrupted === kind
            && shellStream(event.result, "stdout").length > 0;
        if (!valid) {
            console.error(`unexpected interrupt outcome: ${JSON.stringify(json()?.transcript?.shell_events)}`);
        }
        process.exit(valid ? 0 : 1);
        break;
    }
    case "check-tool-result-ok": {
        const id = process.argv[3];
        const result = json()?.transcript?.sent_results?.find((candidate) => candidate.id === id);
        const valid = Boolean(result) && "ok" in result && result.ok?.exit_code === 0;
        if (!valid) console.error(`no completed tool result for ${id}: ${JSON.stringify(result)}`);
        process.exit(valid ? 0 : 1);
        break;
    }
    case "check-tool-result-interrupted": {
        const [id, exitCode, kind] = [process.argv[3], Number(process.argv[4]), process.argv[5]];
        const result = json()?.transcript?.sent_results?.find((candidate) => candidate.id === id);
        const valid = result && "ok" in result
            && result.ok?.exit_code === exitCode
            && result.ok?.interrupted === kind;
        if (!valid) console.error(`unexpected tool result: ${JSON.stringify(result)}`);
        process.exit(valid ? 0 : 1);
        break;
    }
    case "check-final-reply": {
        const needle = process.argv[3];
        const hit = (json()?.transcript?.replies ?? []).some((reply) =>
            typeof reply?.reply?.response === "string" && reply.reply.response.includes(needle));
        process.exit(hit ? 0 : 1);
        break;
    }
    case "redeploy-params": {
        const manifest = fs.readFileSync(process.argv[3], "utf8");
        process.stdout.write(JSON.stringify([manifest, [], "e2e no-op redeploy", false, ""]));
        break;
    }
    // --- chat suite -----------------------------------------------------------
    case "program-stdout": {
        // Print the stdout of a direct chat-program invocation ({ok: {stdout,
        // stderr, exit_code}}); a nonzero exit or err side fails loudly.
        const result = json();
        if (result?.err !== undefined) {
            console.error(`program errored: ${JSON.stringify(result.err)}`);
            process.exit(1);
        }
        const output = result?.ok;
        if (!output || typeof output.stdout !== "string") {
            console.error(`unexpected program result: ${JSON.stringify(result)}`);
            process.exit(1);
        }
        if (output.exit_code !== 0) {
            console.error(`program exited ${output.exit_code}: ${output.stderr}`);
            process.exit(1);
        }
        process.stdout.write(output.stdout);
        break;
    }
    case "program-stderr": {
        // Stderr of a finished-but-failing program invocation (for logs).
        const result = json();
        process.stderr.write(result?.ok?.stderr ?? JSON.stringify(result?.err ?? result));
        break;
    }
    case "shell-event-stdout": {
        const event = json()?.transcript?.shell_events?.find((candidate) => candidate.id === process.argv[3]);
        if (!event) process.exit(1);
        process.stdout.write(shellStream(event.result, "stdout"));
        break;
    }
    case "check-current-id": {
        // `chat current` output: identity JSON of the invoking session.
        const current = json();
        const id = process.argv[3];
        const expectedName = process.argv[4] === "--name" ? (process.argv[5] ?? "") : null;
        const valid = current?.execution_id === id
            && (expectedName === null || current?.name === expectedName);
        if (!valid) console.error(`unexpected chat current: ${JSON.stringify(current)}`);
        process.exit(valid ? 0 : 1);
        break;
    }
    case "check-shell-event-done": {
        const event = json()?.transcript?.shell_events?.find((candidate) => candidate.id === process.argv[3]);
        process.exit(event?.turn_complete === true ? 0 : 1);
        break;
    }
    case "check-shell-script": {
        // A completed shell event matched by its script (the id is generated
        // inside the workflow), optionally asserting its stdout contains the
        // fourth argument.
        const script = process.argv[3];
        const event = json()?.transcript?.shell_events?.find((candidate) => candidate.script === script);
        const valid = event?.turn_complete === true && event?.result?.exit_code === 0
            && (process.argv.length < 5 || shellStream(event.result, "stdout").includes(process.argv[4]));
        if (!valid) {
            console.error(`no completed shell event for ${JSON.stringify(script)}: ${JSON.stringify(json()?.transcript?.shell_events)}`);
        }
        process.exit(valid ? 0 : 1);
        break;
    }
    case "check-runs-name": {
        const name = process.argv[3];
        const hit = json()?.runs?.some((run) => run.name === name);
        if (!hit) console.error(`no run named ${name} in ${JSON.stringify(json())}`);
        process.exit(hit ? 0 : 1);
        break;
    }
    case "check-pending-offer": {
        const runId = process.argv[3];
        const state = json();
        const valid = typeof state?.pending_offer_id === "string"
            && state.pending_offer_id.startsWith(runId + ".")
            && state.working === false;
        if (!valid) console.error(`unexpected chat state: ${JSON.stringify(state)}`);
        process.exit(valid ? 0 : 1);
        break;
    }
    case "check-state-name": {
        const name = process.argv[3];
        const state = json();
        const valid = state?.name === name;
        if (!valid) console.error(`expected session named ${name}: ${JSON.stringify(state)}`);
        process.exit(valid ? 0 : 1);
        break;
    }
    case "check-runs-parent": {
        const [parent, child] = [process.argv[3], process.argv[4]];
        const row = json()?.runs?.find((run) => run.id === child);
        const valid = row?.parent_id === parent;
        if (!valid) {
            console.error(`expected ${child} nested under ${parent}: ${JSON.stringify(row ?? json()?.runs?.map((run) => run.id))}`);
        }
        process.exit(valid ? 0 : 1);
        break;
    }
    case "check-user-message": {
        const text = process.argv[3];
        const hit = json()?.transcript?.user_messages?.some((message) => message.text === text);
        process.exit(hit ? 0 : 1);
        break;
    }
    case "deployment-id": {
        const result = json();
        // deployment-submit's ok side is the deployment id string.
        const ok = result.ok;
        process.stdout.write(typeof ok === "string" ? ok : (ok?.deployment_id ?? ""));
        break;
    }
    default:
        console.error(`unknown command: ${command ?? ""}`);
        process.exit(2);
}
