// obelisk-agent:tools/cloud.finish-deploy:
//   func(app: string, deployment-id: string, draft: string, command-id: string)
//     -> result<record { app-json: string, log: string }, string>
//
// PORT: obelisk's src/command/cloud/deploy.rs after deployment upload.
// Retried with the caller's `commandId`: deploying the app this activity runs in
// interrupts it, and the provisioner answers the retry with the apply's result.
import { appRequest, draftRequest, lookupApp, provisionerResponse } from "./client.js";
import { validateCloudAppName } from "./policy.js";
import { applyRequest } from "./fill.js";
import { draftChanges, lifecycleOutcome } from "./output.js";

export default async function finish_deploy(app, deploymentId, draft, commandId) {
    const lines = [];
    const log = (line) => lines.push(`${line}\n`);
    validateCloudAppName(app);
    try {
        let body = { force: false, draft };
        // A retry finds the apply accepted, its draft no longer open.
        if ((await provisionerResponse("GET", ["v1", "commands", commandId])).status === 404) {
            let staged;
            try {
                staged = await draftRequest(app, draft, "PUT", ["deployment"], { body: { deployment_id: deploymentId } });
            } catch (error) {
                try { await draftRequest(app, draft, "DELETE", []); } catch { /* best effort, like the CLI */ }
                throw error;
            }
            try {
                const peers = await appRequest(app, "GET", ["drafts"]);
                for (const other of Array.isArray(peers?.drafts) ? peers.drafts : []) {
                    if (other?.key !== draft && other?.summary?.changed === true) {
                        log(`Draft \`${other.key}\` (${draftChanges(other)}) will be discarded when this deploy is applied`);
                    }
                }
            } catch { /* the warning is best effort */ }
            body = applyRequest(app, draft, staged, await lookupApp(app), false, log);
        }
        log(`→ obelisk cloud app apply --draft ${draft}`);
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
