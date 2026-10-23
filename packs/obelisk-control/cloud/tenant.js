// obelisk-agent:tools/cloud.tenant:
//   func(app: string, method: string, path: string, content-type: option<string>, body: option<string>)
//     -> result<record { status: u16, body: string }, string>
//
// A request that changes the app (submits, deployment switches, execution
// controls), sent once: max_retries = 0, as a retry could repeat it.
import { appApiRequest } from "./client.js";

export default async function tenant(app, method, path, contentType, body) {
    if (method === "GET") throw "use cloud.tenant-read for GET";
    return appApiRequest(app, method, path, contentType, body);
}
