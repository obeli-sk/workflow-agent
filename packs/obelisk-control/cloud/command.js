// obelisk-agent:tools/cloud.command:
//   func(app: string, method: string, path: list<string>, body: option<string>, command-id: string)
//     -> result<record { status: u16, body: string }, string>
//
// One lifecycle request (`app apply|enable|disable|delete`) on `/v1/apps/<app>/<path>`,
// with the body the shell built from its reads. Retried with the shell's `commandId` as
// the Idempotency-Key: the provisioner joins a repeated command or answers it with the
// recorded result. Every response below 500 is returned for the shell to report; a failed
// request or a server error is an err and gets retried.
import { provisionerResponse } from "./client.js";
import { validateCloudAppName } from "./policy.js";

export default async function command(app, method, path, body, commandId) {
    validateCloudAppName(app);
    if (method !== "POST" && method !== "DELETE") throw `unsupported command method ${method}`;
    return provisionerResponse(method, ["v1", "apps", app, ...path], body, commandId);
}
