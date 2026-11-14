// obelisk-agent:tools/cloud.finish-deploy:
//   func(app: string, deployment-id: string, revision: u64, draft: option<string>, command-id: string)
//     -> result<record { app-json: string, log: string }, string>
//
// PORT: obelisk's src/command/cloud/deploy.rs after deployment upload.
// Retried with the caller's `commandId`: deploying the app this activity runs in
// interrupts it, and the provisioner answers the retry with the apply's result.
import { appRequest } from "./client.js";
import { validateCloudAppName } from "./policy.js";
import { lifecycleOutcome } from "./output.js";

export default async function finish_deploy(app, deploymentId, revision, draft, commandId) {
    const lines = [];
    const log = (line) => lines.push(`${line}\n`);
    validateCloudAppName(app);
    try {
        log("→ obelisk cloud app apply");
        const body = { force: false, deployment_id: deploymentId, ...(draft ? { draft } : { revision }) };
        let row;
        try {
            row = await appRequest(app, "POST", ["apply"], { kind: "command", body, commandId });
        } catch (error) {
            // A draft left by a failed apply is discarded by the next successful one.
            throw `Retry with \`obelisk cloud app deploy --app ${app}\`\n\nCaused by:\n    ${error}`;
        }
        log(lifecycleOutcome(row));
        if (row?.status !== "running") {
            throw `App is ${JSON.stringify(row?.status ?? null)}; inspect it with \`obelisk cloud app status --app ${app}\``;
        }
        return { app_json: JSON.stringify(row), log: lines.join("") };
    } catch (error) {
        throw `${lines.join("")}Error: ${error}`;
    }
}
