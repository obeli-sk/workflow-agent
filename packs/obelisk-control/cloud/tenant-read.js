// obelisk-agent:tools/cloud.tenant-read:
//   func(app: string, path: string) -> result<record { status: u16, body: string }, string>
//
// GET `path` on the app's API. Every response, including an error status, is
// returned for the shell to report, so only a failed request is an error and
// gets retried.
import { appApiRequest } from "./client.js";

export default async function tenantRead(app, path) {
    return appApiRequest(app, "GET", path, null, null);
}
