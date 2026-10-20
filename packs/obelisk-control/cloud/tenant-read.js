// obelisk-agent:tools/cloud.tenant-read:
//   func(app: string, operation: string, params-json: string) -> result<string, string>
//
// `tenant` for read-only operations. Unlike `tenant` it is retried, so a
// transient network error does not fail a read such as a deployment blob.
import tenant, { MUTATING_OPERATIONS } from "./tenant.js";

export default async function tenantRead(app, operation, paramsJson) {
    if (MUTATING_OPERATIONS.includes(operation)) throw `${operation} is not a read-only operation; use cloud.tenant`;
    return tenant(app, operation, paramsJson);
}
