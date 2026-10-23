// `createHost` bridges the generic `callJson(ffqn, paramsJson) -> string|null`
// seam (obelisk-program.js/obelisk-mcp.js, for functions chosen at runtime)
// onto `dynamic.call`, re-encoding the decoded value as JSON text.
//
// `createControlPlane` backs obelisk-pack.js's control plane with the
// statically imported tools, turning child errors into plain messages.
// `createCloud` backs `obelisk cloud`, reusing it against an app's API.

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

// `webapi` is the
// `obelisk-agent:tools/webapi` namespace import and `askUser(paramsJson)`
// answers `obelisk call obelisk-agent:stub/stub.ask-user` on this instance.
export function createControlPlane(webapi, obelisk, askUser) {
    const plain = (fn) => (...args) => {
        try {
            return fn(...args);
        } catch (error) {
            throw childErrorMessage(error, obelisk);
        }
    };
    return {
        listFunctions: plain(webapi.listFunctions),
        getFunctionWit: plain(webapi.getFunctionWit),
        listExecutions: plain((ffqnPrefix, idPrefix, showDerived, hideFinished, length) =>
            webapi.listExecutions(ffqnPrefix, idPrefix, showDerived, hideFinished, "", "", "", "", false, length)),
        getExecution: plain(webapi.getExecution),
        getLogs: plain((id, length) => webapi.getLogs(id, true, true, true, [], [], "", "", false, length)),
        getResultJson: plain(webapi.getResultJson),
        listDeployments: plain((length) => webapi.listDeployments("", false, length)),
        getDeployment: plain((id) => webapi.getDeployment(id, null, null, null, null)),
        currentDeploymentId: plain(webapi.currentDeploymentId),
        getAppConfig: plain(webapi.getAppConfig),
        deploymentCheckout: plain(webapi.deploymentCheckout),
        deploymentReadBlob: plain(webapi.deploymentReadBlob),
        deploymentSubmit(manifest, attachments, description, allowMissing, deploymentId) {
            try {
                return webapi.deploymentSubmit(manifest, attachments, description, allowMissing, deploymentId);
            } catch (error) {
                if (Array.isArray(error?.missingFiles)) throw error;
                const missingFiles = isChildError(error, obelisk) ? error.value?.permanent_missing_files : undefined;
                if (Array.isArray(missingFiles)) throw { missingFiles };
                throw childErrorMessage(error, obelisk);
            }
        },
        deploymentSwitch: plain(webapi.deploymentSwitch),
        applyDeployment: plain(webapi.applyDeployment),
        callTarget: (ffqn, paramsJson) => (ffqn === ASK_USER_FFQN
            ? askUser(paramsJson)
            : callTarget(webapi, ffqn, paramsJson, (error) => childErrorMessage(error, obelisk))),
    };
}

// `cloud` is the `obelisk-agent:tools/cloud`
// namespace import; obelisk-pack.js's `obelisk cloud` calls this.
export function createCloud(cloud, obelisk, askUser) {
    const plain = (fn) => {
        try {
            return fn();
        } catch (error) {
            throw childErrorMessage(error, obelisk);
        }
    };
    return {
        run(args, stdin, appToml) {
            const output = plain(() => cloud.run(args, stdin, appToml));
            return { stdout: output.stdout, stderr: output.stderr, exitCode: output.exit_code };
        },
        prepareDeploy(app, appToml) {
            const target = plain(() => cloud.prepareDeploy(app, appToml));
            return { apiUrl: target.api_url, webhookUrl: target.webhook_url ?? null, log: target.log };
        },
        controlPlane: (app) => createControlPlane(tenantWebapi(cloud, app), obelisk, askUser),
    };
}

// Operations that change the app or start executions; `cloud.tenant` runs them
// once, while every read goes through the retried `cloud.tenant-read`.
const MUTATING_OPERATIONS = ["apply-deployment", "call-target", "deployment-submit", "deployment-switch"];

// The webapi functions the control plane uses, run by `cloud.tenant` against `app`'s API.
function tenantWebapi(cloud, app) {
    const call = (operation) => (...params) => {
        const run = MUTATING_OPERATIONS.includes(operation) ? cloud.tenant : cloud.tenantRead;
        const value = JSON.parse(run(app, operation, JSON.stringify(params)));
        if (Array.isArray(value?.missing_files)) throw { missingFiles: value.missing_files };
        return value.ok;
    };
    return {
        listFunctions: call("list-functions"),
        getFunctionWit: call("get-function-wit"),
        callTarget: call("call-target"),
        listExecutions: call("list-executions"),
        getExecution: call("get-execution"),
        getLogs: call("get-logs"),
        getResultJson: call("get-result-json"),
        listDeployments: call("list-deployments"),
        getDeployment: call("get-deployment"),
        currentDeploymentId: call("current-deployment-id"),
        getAppConfig: call("get-app-config"),
        deploymentCheckout: call("deployment-checkout"),
        deploymentReadBlob: call("deployment-read-blob"),
        deploymentSubmit: call("deployment-submit"),
        deploymentSwitch: call("deployment-switch"),
        applyDeployment: call("apply-deployment"),
    };
}

const ASK_USER_FFQN = "obelisk-agent:stub/stub.ask-user";

// Unwraps the webapi.call-target response like
// `obelisk.call`: returns the ok value's JSON text, throws a message otherwise.
function callTarget(webapi, ffqn, paramsJson, errorMessage) {
    if (typeof ffqn !== "string" || !ffqn) throw "ffqn is required";
    let params;
    try { params = JSON.parse(paramsJson || "[]"); }
    catch (e) { throw witHint(webapi, ffqn, `params_json must be valid JSON: ${e.message}`); }
    if (!Array.isArray(params)) throw witHint(webapi, ffqn, "params_json must be a JSON array of positional parameters");

    let callText;
    try { callText = webapi.callTarget(ffqn, JSON.stringify(params)); }
    catch (e) { throw errorMessage(e); }

    let callResult;
    try { callResult = JSON.parse(callText); }
    catch (e) { throw `invalid call-target response: ${e.message}: ${callText}`; }
    if (typeof callResult?.submission_rejected === "string") {
        throw witHint(webapi, ffqn, callResult.submission_rejected);
    }
    const executionId = callResult?.execution_id;
    if (typeof executionId !== "string" || !executionId) {
        throw `call-target response has no execution id: ${callText}`;
    }
    if (typeof callResult.result_error === "string") {
        throw `execution ${executionId} was accepted, but fetching its result failed: ${callResult.result_error}`;
    }

    let envelope;
    try { envelope = JSON.parse(callResult.result); }
    catch (e) { throw `execution ${executionId} returned an invalid result: ${e.message}: ${callResult.result}`; }
    if (envelope && Object.prototype.hasOwnProperty.call(envelope, "ok")) {
        return JSON.stringify(envelope.ok === undefined ? null : envelope.ok);
    }
    if (envelope && Object.prototype.hasOwnProperty.call(envelope, "err")) {
        const error = typeof envelope.err === "string" ? envelope.err : JSON.stringify(envelope.err);
        throw `execution ${executionId} finished with Err: ${error}`;
    }
    if (envelope && envelope.execution_failed) {
        const f = envelope.execution_failed;
        throw `execution ${executionId} failed: ${f.reason || f.kind || "execution failed"}`;
    }
    throw `execution ${executionId} returned an unexpected result: ${callResult.result}`;
}

// A rejected submission means the call never started, so recap the signature.
function witHint(webapi, ffqn, message) {
    try { return `${message}\n\nWIT for ${ffqn}:\n${webapi.getFunctionWit(ffqn)}`; }
    catch (e) { return `${message}\n\nCould not fetch WIT for ${ffqn}: ${String(e)}`; }
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
