import { provisionerResponse } from "./client.js";
import { validateCloudAppName } from "./policy.js";

export default async function openDraft(app, key, parentRevision, reuse) {
    validateCloudAppName(app);
    if (!/^[a-z0-9._-]{1,64}$/.test(key)) throw "invalid draft key";
    const path = ["v1", "apps", app, "drafts", key];
    let response = await provisionerResponse("GET", path);
    if (response.status === 404) {
        response = await provisionerResponse("POST", path, JSON.stringify({ parent_revision: parentRevision, reuse: true }));
        if (response.status === 409) {
            const found = await provisionerResponse("GET", path);
            if (found.status === 200) {
                response = found;
            }
        }
    }
    if (response.status >= 200 && response.status < 300) {
        const draft = JSON.parse(response.body);
        if (!reuse && draft.parent_revision !== parentRevision) {
            return { status: 409, body: JSON.stringify({ error: `Draft \`${key}\` has parent revision ${draft.parent_revision}, expected ${parentRevision}; the applied revision changed while opening it` }) };
        }
    }
    return response;
}
