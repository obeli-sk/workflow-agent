import { appApiRequest } from "./client.js";
import { isDeploymentUpload } from "../../../shared/deployment-upload.js";

export default async function upload(app, path, contentType, body) {
    if (!isDeploymentUpload(path)) throw `unsupported upload path ${path}`;
    const response = await appApiRequest(app, "PUT", path, contentType, body);
    if (response.status >= 500) throw `Cloud upload returned ${response.status}: ${response.body}`;
    return response;
}
