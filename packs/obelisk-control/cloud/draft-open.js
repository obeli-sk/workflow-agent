import { provisionerResponse } from "./client.js";
import { validateCloudAppName } from "./policy.js";

export default async function openDraft(app, key, parentRevision) {
    validateCloudAppName(app);
    if (!/^[a-z0-9._-]{1,64}$/.test(key)) throw "invalid draft key";
    return provisionerResponse("PUT", ["v1", "apps", app, "drafts", key], JSON.stringify({ parent_revision: parentRevision }));
}
