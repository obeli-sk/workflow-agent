// obelisk-agent:tools/cloud.prepare-deploy:
//   func(app: string, app-toml: string, draft: string, env: list<string>, secrets: list<string>,
//        fill: bool, exported: list<tuple<string, string>>)
//     -> result<record { created: bool, draft: option<string>, changed: bool, revision: u64, log: string }, string>
//
// PORT: obelisk's src/command/cloud/deploy.rs before deployment upload.
import { appliedRevision, cloudRequest, draftRequest, lookupApp, appRequest } from "./client.js";
import { appConfig, validateCloudAppName } from "./policy.js";
import { applyRequest, explicitValues, initialValues, stageValues, unsetOptional, userSuppliedPolicy } from "./fill.js";
import { draftChanges, draftValues } from "./output.js";

export default async function prepare_deploy(app, appToml, draft, env, secrets, fill, exported) {
    const lines = [];
    const log = (line) => lines.push(`${line}\n`);
    const config = appConfig(appToml);
    const name = app || config.appName;
    validateCloudAppName(name);
    const variables = Object.fromEntries(exported);
    log(`Deploying ${name}`);
    const step = (command) => log(`→ obelisk cloud app ${command}`);
    try {
        const explicit = explicitValues(env, secrets, variables);
        const current = await lookupApp(name);
        if (current !== null) {
            const resume = (error) => `Draft \`${draft}\` keeps the staged changes; retry with \`obelisk cloud app deploy --app ${name} --draft ${draft}\` or discard it with \`obelisk cloud app unstage --app ${name} --draft ${draft}\`\n\nCaused by:\n    ${error}`;
            step(`stage --draft ${draft}`);
            let staged = await draftRequest(name, draft, "PUT", ["config"], { toml: appToml });
            if (fill) step("fill");
            let filled;
            try {
                ({ draft: staged, filled } = await stageValues(name, draft, staged, explicit, fill ? variables : null));
            } catch (error) {
                throw resume(error);
            }
            const missing = draftValues(staged, "missing");
            if (missing.length > 0) {
                throw resume(`Missing values: ${missing.join(", ")}. Pass them with \`--env NAME[=VALUE]\` or \`--secret NAME\`, or retry with \`--fill\` or \`--fill-non-interactive\``);
            }
            const unset = unsetOptional(filled);
            if (unset.length > 0) {
                log(`Optional configuration not set: ${unset.join(", ")}. Pass them with \`--env\` or \`--secret\`, or deploy with \`--fill\`.`);
            }
            try {
                const peers = await appRequest(name, "GET", ["drafts"]);
                for (const other of Array.isArray(peers?.drafts) ? peers.drafts : []) {
                    if (other?.key !== draft && other?.summary?.changed === true) {
                        log(`Draft \`${other.key}\` (${draftChanges(other)}) will be discarded when this deploy is applied`);
                    }
                }
            } catch { /* the warning is best effort */ }
            let body;
            try {
                body = applyRequest(name, draft, staged, current, "", false, log);
            } catch (error) {
                throw resume(error);
            }
            return { created: false, draft, changed: body.draft !== undefined, revision: body.revision, log: lines.join("") };
        }
        if (fill) step("fill");
        const values = initialValues(userSuppliedPolicy(config), explicit, fill ? variables : null);
        step("new");
        const created = await cloudRequest("POST", ["v1", "apps"], {
            kind: "secret-command",
            body: { app_toml: appToml, env: values.env, secrets: values.secrets },
        });
        const revision = appliedRevision(created);
        log(`Re-applying revision ${revision}`);
        return { created: true, draft: null, changed: false, revision, log: lines.join("") };
    } catch (error) {
        throw `${lines.join("")}Error: ${error}`;
    }
}
