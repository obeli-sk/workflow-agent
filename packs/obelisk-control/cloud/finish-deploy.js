// obelisk-agent:tools/cloud.finish-deploy:
//   func(app: string, deployment-id: string, revision: u64, draft: option<string>, discard: option<string>)
//     -> result<record { app-json: string, log: string }, string>
//
// PORT: obelisk's src/command/cloud/deploy.rs after deployment upload.
import { appRequest, draftRequest } from "./client.js";
import { validateCloudAppName } from "./policy.js";
import { lifecycleOutcome } from "./output.js";

export default async function finish_deploy(app, deploymentId, revision, draft, discard) {
    const lines = [];
    const log = (line) => lines.push(`${line}\n`);
    validateCloudAppName(app);
    try {
        log("→ obelisk cloud app apply");
        const body = { force: false, revision, deployment_id: deploymentId };
        if (draft) body.draft = draft;
        let row;
        try {
            row = await appRequest(app, "POST", ["apply"], { kind: "command", body });
        } catch (error) {
            const key = draft ?? discard;
            throw key ? `Draft \`${key}\` keeps the staged changes; retry with \`obelisk cloud app deploy --app ${app} --draft ${key}\`\n\nCaused by:\n    ${error}` : error;
        }
        // An unchanged generated draft was not applied and would linger.
        if (discard) {
            try { await draftRequest(app, discard, "DELETE", []); } catch { /* best effort, like the CLI */ }
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
