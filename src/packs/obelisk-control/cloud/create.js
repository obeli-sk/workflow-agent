import { provisionerResponse } from "./client.js";

export default async function create(body, commandId) {
    return provisionerResponse("POST", ["v1", "apps"], body, commandId);
}
