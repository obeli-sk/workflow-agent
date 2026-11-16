import { provisionerResponse } from "./client.js";
import { configName, validateCloudAppName } from "./policy.js";

export default async function draftRequest(app, key, draftId, method, section, contentType, body) {
    validateCloudAppName(app);
    if (!/^[a-z0-9._-]{1,64}$/.test(key)) throw "invalid draft key";
    const readOrDiscard = section.length === 0 && ["GET", "DELETE"].includes(method);
    const edit = method === "PUT" && ((section.length === 1 && ["config", "deployment"].includes(section[0])) || (section.length === 2 && section[0] === "env"));
    if (!readOrDiscard && !edit) throw "unsupported draft request";
    if (section[0] === "env") configName(section[1]);
    return provisionerResponse(method, ["v1", "apps", app, "drafts", key, ...section], body, null, contentType, draftId);
}
