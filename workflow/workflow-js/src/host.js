// `createHost` bridges the generic `callJson(ffqn, paramsJson) -> string|null`
// seam (obelisk-program.js, for functions chosen at runtime)
// onto `dynamic.call`, re-encoding the decoded value as JSON text.
//
// `createCloud` backs obelisk-pack.js's `obelisk cloud` with the cloud
// activities, turning child errors into plain messages.

import { isDeploymentUpload } from "../../../shared/deployment-upload.js";

export function createHost(dynamic, obelisk) {
    return {
        callJson(ffqn, paramsJson) {
            let params;
            try {
                params = JSON.parse(paramsJson ?? "[]");
            } catch (error) {
                throw `params_json must be valid JSON: ${error.message}`;
            }
            let value;
            try {
                value = dynamic.call(ffqn, params);
            } catch (error) {
                throw childErrorMessage(error, obelisk);
            }
            return value === undefined ? null : JSON.stringify(value);
        },
    };
}

// `cloud` is the `obelisk-agent:tools/cloud`
// namespace import; obelisk-pack.js's `obelisk cloud` calls this.
// `get`/`send` return every HTTP response as `{ status, body }`.
export function createCloud(cloud, obelisk) {
    const plain = (fn) => {
        try {
            return fn();
        } catch (error) {
            throw childErrorMessage(error, obelisk);
        }
    };
    return {
        run(args, stdin, appToml, fillEnv) {
            const output = plain(() => cloud.run(args, stdin, appToml, fillEnv));
            return { stdout: output.stdout, stderr: output.stderr, exitCode: output.exit_code };
        },
        create: (body, commandId) => plain(() => cloud.create(body, commandId)),
        openDraft: (app, key, parentRevision, reuse) => plain(() => cloud.draftOpen(app, key, parentRevision, reuse)),
        draftRequest: (app, key, draftId, method, section, contentType, body) => plain(() => cloud.draftRequest(app, key, draftId, method, section, contentType, body)),
        read: (path) => plain(() => cloud.read(path)),
        command: (app, method, path, body, commandId, draftId = null) => plain(() => cloud.command(app, method, path, body, commandId, draftId)),
        get: (app, path) => plain(() => cloud.tenantRead(app, path)),
        send: (app, method, path, contentType, body) => plain(() => method === "PUT" && isDeploymentUpload(path)
            ? cloud.upload(app, path, contentType, body)
            : cloud.tenant(app, method, path, contentType, body)),
    };
}

function isChildError(error, obelisk) {
    return typeof obelisk?.ChildError === "function" && error instanceof obelisk.ChildError;
}

export function childErrorMessage(error, obelisk) {
    if (isChildError(error, obelisk)) {
        if (error.value !== undefined) {
            return decodeChildErrorValue(error.value);
        }
        return error.message;
    }
    return String(error);
}

export function decodeChildErrorValue(value) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
        if (typeof value.permanent_error === "string") return value.permanent_error;
        if (typeof value.transient_error === "string") return value.transient_error;
    }
    return JSON.stringify(value);
}
