// obelisk-agent:tools/cloud.prepare-deploy:
//   func(app: string, app-toml: string, fill-env: option<list<tuple<string, string>>>)
//     -> result<record { created: bool, revision: u64, log: string }, string>
//
// PORT: obelisk's src/command/cloud/deploy.rs up to the deployment enqueue:
// stage the config of an existing app or create a new one, so the shell can
// enqueue the deployment on its API before `finish-deploy` applies the staged revision.
import { cloudRequest, lookupApp, appRequest, stagedRevision } from "./client.js";
import { appConfig, validateCloudAppName } from "./policy.js";
import { initialValues, userSuppliedPolicy } from "./fill.js";

export default async function prepare_deploy(app, appToml, fillEnv) {
    const lines = [];
    const log = (line) => lines.push(`${line}\n`);
    const config = appConfig(appToml);
    const name = app || config.appName;
    if (!name) throw "Set app_name in ./app.toml, --app or OBELISK_APP_NAME";
    validateCloudAppName(name);
    log(`Deploying ${name}`);
    const step = (command) => log(`→ obelisk cloud app ${command}`);
    const desired = { policy: config.policy, cloud: config.cloud };
    try {
        if ((await lookupApp(name)) !== null) {
            step("stage");
            const staged = await appRequest(name, "PUT", ["config"], { kind: "command", body: desired });
            return { created: false, revision: stagedRevision(staged), log: lines.join("") };
        }
        if (fillEnv) step("fill");
        const values = initialValues(userSuppliedPolicy(config), fillEnv ? Object.fromEntries(fillEnv) : null);
        step("new");
        const created = await cloudRequest("POST", ["v1", "apps"], {
            kind: "secret-command",
            body: { ...desired, app_name: name, env: values.env, secrets: values.secrets },
        });
        return { created: true, revision: stagedRevision(created), log: lines.join("") };
    } catch (error) {
        throw `${lines.join("")}Error: ${error}`;
    }
}
