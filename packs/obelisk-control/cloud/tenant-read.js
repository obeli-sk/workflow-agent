// obelisk-agent:tools/cloud.tenant-read:
//   func(app: string, path: string) -> result<record { status: u16, body: string }, string>
//
// GET `path` on the app's API. Every response, including an error status, is
// returned for the shell to report, so only a failed request is an error and
// gets retried. `/v1/app-toml` serves only TOML and answers 406 to anything else.
import { appApiRequest } from "./client.js";

export default async function tenantRead(app, path) {
    return appApiRequest(app, "GET", path, null, null, path === "/v1/app-toml" ? "application/toml" : "application/json");
}
