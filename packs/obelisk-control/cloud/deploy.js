// obelisk-agent:tools/cloud.prepare-deploy:
//   func(app: string, app-toml: string, draft: string, env: list<string>, fill: bool,
//        exported: list<tuple<string, string>>)
//     -> result<record { created: bool, draft: option<string>, revision: u64, log: string }, string>
//
// PORT: obelisk's src/command/cloud/deploy.rs before deployment upload.
import { appliedRevision, cloudRequest, draftRequest, lookupApp, appRequest } from "./client.js";
import { appConfig, validateCloudAppName } from "./policy.js";
import { applyRequest, explicitValues, initialValues, needsUserSecrets, stageValues, unsetOptional, userSuppliedPolicy } from "./fill.js";
import { draftChanges, draftValues } from "./output.js";

export default async function prepare_deploy(app, appToml, draft, env, fill, exported) {
    const lines = [];
    const log = (line) => lines.push(`${line}\n`);
    const config = appConfig(appToml);
    const name = app || config.appName;
    validateCloudAppName(name);
    const variables = Object.fromEntries(exported);
    log(`Deploying ${name}`);
    const step = (command) => log(`→ obelisk cloud app ${command}`);
    try {
        const explicit = explicitValues(env, variables);
        const current = await lookupApp(name);
        if (current !== null) {
            step(`stage --draft ${draft}`);
            await draftRequest(name, draft, "POST", []);
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
            try {
                const peers = await appRequest(name, "GET", ["drafts"]);
                for (const other of Array.isArray(peers?.drafts) ? peers.drafts : []) {
                    if (other?.key !== draft && other?.summary?.changed === true) {
                        log(`Draft \`${other.key}\` (${draftChanges(other)}) will be discarded when this deploy is applied`);
                    }
                }
            } catch { /* the warning is best effort */ }
            applyRequest(name, draft, staged, current, "", false, log);
            return { created: false, draft, revision: appliedRevision(current), log: lines.join("") };
        }
        if (fill) step("fill");
        const values = initialValues(name, userSuppliedPolicy(config), explicit, fill ? variables : null);
        step("new");
        const created = await cloudRequest("POST", ["v1", "apps"], {
            kind: "secret-command",
            body: { app_toml: appToml, env: values.env, secrets: values.secrets },
        });
        const revision = appliedRevision(created);
        log(`Re-applying revision ${revision}`);
        return { created: true, draft: null, revision, log: lines.join("") };
    } catch (error) {
        throw `${lines.join("")}Error: ${error}`;
    }
}
