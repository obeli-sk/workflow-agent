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
    case "has-execution": {
        const ffqn = process.argv[3];
        process.exit(executions(json()).some((row) => row.ffqn === ffqn) ? 0 : 1);
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
    case "wrap-ok":
        process.stdout.write(JSON.stringify({ ok: input().trimEnd() }));
        break;
    case "redeploy-params": {
        const manifest = fs.readFileSync(process.argv[3], "utf8");
        process.stdout.write(JSON.stringify([manifest, "[]", "e2e no-op redeploy", false, ""]));
        break;
    }
    case "deployment-id": {
        const result = json();
        process.stdout.write(JSON.parse(result.ok).deployment_id ?? "");
        break;
    }
    default:
        console.error(`unknown command: ${command ?? ""}`);
        process.exit(2);
}
