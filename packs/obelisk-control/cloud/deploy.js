// obelisk-agent:tools/cloud.prepare-deploy:
//   func(app: string, app-toml: string, draft: string, env: list<string>, fill: bool,
//        exported: list<tuple<string, string>>)
//     -> result<record { log: string }, string>
//
// PORT: obelisk's src/command/cloud/deploy.rs before deployment upload.
import { draftRequest } from "./client.js";
import { appConfig, validateCloudAppName } from "./policy.js";
import { explicitValues, needsUserSecrets, stageValues, unsetOptional } from "./fill.js";
import { draftValues } from "./output.js";

export default async function prepare_deploy(app, appToml, draft, env, fill, exported) {
    const lines = [];
    const log = (line) => lines.push(`${line}\n`);
    const config = appConfig(appToml);
    const name = app || config.appName;
    validateCloudAppName(name);
    const variables = Object.fromEntries(exported);
    const step = (command) => log(`→ obelisk cloud app ${command}`);
    try {
        const explicit = explicitValues(env, variables);
        step(`stage --draft ${draft}`);
        await draftRequest(name, draft, "POST", []);
        // Values are checked before the upload; `finish-deploy` stages the deployment.
        let staged;
        try {
            staged = await draftRequest(name, draft, "PUT", ["config"], { toml: appToml });
            if (fill) step("fill");
            let filled;
            ({ draft: staged, filled } = await stageValues(name, draft, staged, explicit, fill ? variables : null));
            const missing = draftValues(staged, "missing");
            const secrets = missing.filter((value) => value.startsWith("secret ")).map((value) => value.slice("secret ".length));
            if (secrets.length > 0) throw needsUserSecrets(name, secrets);
            if (missing.length > 0) {
                throw `Missing values: ${missing.join(", ")}. Pass them with \`--env NAME[=VALUE]\`, or retry with \`--fill-non-interactive\``;
            }
            const unset = unsetOptional(filled);
            if (unset.length > 0) {
                log(`Optional configuration not set: ${unset.join(", ")}. Pass them with \`--env\`, or deploy with \`--fill-non-interactive\`.`);
            }
        } catch (error) {
            try { await draftRequest(name, draft, "DELETE", []); } catch { /* best effort, like the CLI */ }
            throw error;
        }
        return { log: lines.join("") };
    } catch (error) {
        throw `${lines.join("")}Error: ${error}`;
    }
}
