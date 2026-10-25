// obelisk-agent:tools/cloud.finish-deploy:
//   func(app: string, app-toml: string, deployment-id: string, revision: u64, created: bool,
//        fill-env: option<list<tuple<string, string>>>)
//     -> result<record { app-json: string, log: string }, string>
//
// PORT: obelisk's src/command/cloud/deploy.rs after the deployment enqueue:
// fill an existing app's values, then apply the staged revision with the enqueued deployment.
import { appRequest } from "./client.js";
import { appConfig } from "./policy.js";
import { fillValues, unsetOptional, userSuppliedPolicy } from "./fill.js";
import { lifecycleOutcome } from "./output.js";

export default async function finish_deploy(app, appToml, deploymentId, revision, created, fillEnv) {
    const lines = [];
    const log = (line) => lines.push(`${line}\n`);
    const config = appConfig(appToml);
    const name = app || config.appName;
    try {
        if (!created) {
            if (fillEnv) log("→ obelisk cloud app fill");
            const filled = await fillValues(name, userSuppliedPolicy(config), fillEnv ? Object.fromEntries(fillEnv) : null);
            const unset = unsetOptional(filled);
            if (unset.length > 0) {
                log(`Optional configuration not set: ${unset.join(", ")}. Run \`obelisk cloud app --app ${name} fill\` or \`deploy --fill\` to set it.`);
            }
        }
        log("→ obelisk cloud app apply");
        const body = { force: false, revision, deployment_id: deploymentId };
        const row = await appRequest(name, "POST", ["apply"], { kind: "command", body });
        log(lifecycleOutcome(row));
        if (row?.status !== "running") {
            throw `App is ${JSON.stringify(row?.status ?? null)}; inspect it with \`obelisk cloud app --app ${name} status\``;
        }
        return { app_json: JSON.stringify(row), log: lines.join("") };
    } catch (error) {
        throw `${lines.join("")}Error: ${error}`;
    }
}
