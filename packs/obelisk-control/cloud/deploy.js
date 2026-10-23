// obelisk-agent:tools/cloud.prepare-deploy:
//   func(app: string, app-toml: string) -> result<record { api-url: string, log: string }, string>
//
// PORT: obelisk's src/command/cloud/deploy.rs up to the deployment enqueue:
// stage the config of an existing app or create a new one, then hand back its
// API URL so the shell enqueues the deployment there before `finish-deploy`.
import { apiOrigin, appRequest, cloudRequest, lookupApp } from "./client.js";
import { appConfig, validateAppName } from "./policy.js";
import { requiredValues } from "./fill.js";

export default async function prepare_deploy(app, appToml) {
    const lines = [];
    const log = (line) => lines.push(`${line}\n`);
    if (!appToml) throw "Cannot read policy app.toml: pass -a APP.TOML or write ./app.toml with app_name";
    const config = appConfig(appToml);
    const name = app || config.appName;
    if (!name) throw "Select an app with --app or app_name in app.toml";
    validateAppName(name);
    log(`Deploying ${name}`);
    const step = (command) => log(`→ obelisk cloud app ${command}`);
    const command = { kind: "command" };
    const desired = { policy: config.policy, cloud: config.cloud };

    let row = await lookupApp(name);
    if (row !== null) {
        step("stage");
        row = await appRequest(name, "PUT", ["config"], { ...command, body: desired });
    } else {
        // A new app has no values yet, and `--fill` is not available here.
        const missing = requiredValues(config.policy);
        if (missing.length > 0) {
            throw `Missing required configuration: ${missing.join(", ")}. Create the app with \`obelisk cloud app new ${name}\`, set the values with \`env set\` and \`secrets set\`, then retry the deploy`;
        }
        step("new");
        row = await cloudRequest("POST", ["v1", "apps"], {
            ...command,
            body: { ...desired, app_name: name, env: {}, secrets: {} },
        });
    }
    return { api_url: apiOrigin(row?.api_url), log: lines.join("") };
}
