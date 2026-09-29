// PORT: workflow/workflow-rs/src/host.rs.
//
// `createHost` bridges the generic `callJson(ffqn, paramsJson) -> string|null`
// seam (obelisk-program.js/obelisk-mcp.js, for functions chosen at runtime)
// onto `dynamic.call`, re-encoding the decoded value as JSON text so the
// consumers' decoding ports unchanged from the Rust source.
//
// `createControlPlane` backs obelisk-pack.js's control plane with the
// statically imported tools, turning child errors into plain messages.

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

// PORT: host.rs's `ControlPlane for RealHost`. `webapi` is the
// `obelisk-agent:tools/webapi` namespace import, `nativeCall` the
// `obelisk-control:tools/native.call` import, and `askUser(paramsJson)`
// answers `obelisk call obelisk-agent:stub/stub.ask-user` on this instance.
export function createControlPlane(webapi, nativeCall, obelisk, askUser) {
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
                const missingFiles = isChildError(error, obelisk) ? error.value?.permanent_missing_files : undefined;
                if (Array.isArray(missingFiles)) throw { missingFiles };
                throw childErrorMessage(error, obelisk);
            }
        },
        deploymentSwitch: plain(webapi.deploymentSwitch),
        applyDeployment: plain(webapi.applyDeployment),
        nativeCall: (ffqn, paramsJson) => (ffqn === ASK_USER_FFQN ? askUser(paramsJson) : plain(nativeCall)(ffqn, paramsJson)),
    };
}

const ASK_USER_FFQN = "obelisk-agent:stub/stub.ask-user";

function isChildError(error, obelisk) {
    return typeof obelisk?.ChildError === "function" && error instanceof obelisk.ChildError;
}

// PORT: support.rs's `child_error_message` / the JS callers' inline
// equivalent (e.g. packs/obelisk-control/native-call.js's `callErrorMessage`).
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
