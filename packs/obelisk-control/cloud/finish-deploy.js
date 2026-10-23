// obelisk-agent:tools/cloud.finish-deploy:
//   func(app: string, app-toml: string, deployment-id: string)
//     -> result<record { webhook-url: option<string>, log: string }, string>
//
// PORT: obelisk's src/command/cloud/deploy.rs after the deployment enqueue:
// check the app's values, then apply the config with the enqueued deployment.
import { appRequest } from "./client.js";
import { appConfig } from "./policy.js";
import { checkFill } from "./fill.js";
import { lifecycleOutcome } from "./output.js";

export default async function finish_deploy(app, appToml, deploymentId) {
    const lines = [];
    const log = (line) => lines.push(`${line}\n`);
    const config = appConfig(appToml);
    const name = app || config.appName;
    await checkFill(name, config.policy, log);
    log("→ obelisk cloud app apply");
    const body = { force: false, config: { policy: config.policy, cloud: config.cloud }, deployment_id: deploymentId };
    const row = await appRequest(name, "POST", ["apply"], { kind: "command", body });
    log(lifecycleOutcome(row));
    if (row?.status !== "running") {
        throw `App is ${row?.status ?? "unknown"}; inspect it with \`obelisk cloud app --app ${name} status\``;
    }
    const webhook = typeof row.webhook_url === "string" ? row.webhook_url : null;
    return { webhook_url: webhook, log: lines.join("") };
}
