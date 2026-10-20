// obelisk-agent:tools/cloud.tenant:
//   func(app: string, operation: string, params-json: string) -> result<string, string>
//
// Runs one webapi tool (`operation` is its WIT name, `params-json` its
// positional arguments) against the ObeliskNet app's own API, authenticated by
// the cloud token (the single-app cloud uses TARGET_OBELISK_*). Returns `{"ok": value}`, or `{"missing_files": [...]}` when
// deployment-submit needs attachments.
import { apiOrigin, appRequest, cloudToken } from "./client.js";
import { setTarget } from "../tools/target.js";
import applyDeployment from "../tools/apply-deployment.js";
import callTarget from "../tools/call-target.js";
import currentDeploymentId from "../tools/current-deployment.js";
import deploymentCheckout from "../tools/deployment-checkout.js";
import deploymentReadBlob from "../tools/deployment-read-blob.js";
import deploymentSubmit from "../tools/deployment-submit.js";
import deploymentSwitch from "../tools/deployment-switch.js";
import getAppConfig from "../tools/get-app-config.js";
import getComponentSource from "../tools/get-component-source.js";
import getDeployment from "../tools/get-deployment.js";
import getEvents from "../tools/get-events.js";
import getExecution from "../tools/get-execution.js";
import getExecutionRecord from "../tools/get-execution-record.js";
import getFunctionWit from "../tools/get-function-wit.js";
import getLogs from "../tools/get-logs.js";
import getResponses from "../tools/get-responses.js";
import getResultJson from "../tools/get-result.js";
import listDeployments from "../tools/list-deployments.js";
import listExecutions from "../tools/list-executions.js";
import listFunctions from "../tools/list-functions.js";
import { validateAppName } from "./policy.js";
import { requireSingleApp, singleApp } from "./single-app.js";

const OPERATIONS = {
    "apply-deployment": applyDeployment,
    "call-target": callTarget,
    "current-deployment-id": currentDeploymentId,
    "deployment-checkout": deploymentCheckout,
    "deployment-read-blob": deploymentReadBlob,
    "deployment-submit": deploymentSubmit,
    "deployment-switch": deploymentSwitch,
    "get-app-config": getAppConfig,
    "get-component-source": getComponentSource,
    "get-deployment": getDeployment,
    "get-events": getEvents,
    "get-execution": getExecution,
    "get-execution-record": getExecutionRecord,
    "get-function-wit": getFunctionWit,
    "get-logs": getLogs,
    "get-responses": getResponses,
    "get-result-json": getResultJson,
    "list-deployments": listDeployments,
    "list-executions": listExecutions,
    "list-functions": listFunctions,
};

export default async function tenant(app, operation, paramsJson) {
    const tool = Object.prototype.hasOwnProperty.call(OPERATIONS, operation) ? OPERATIONS[operation] : null;
    if (!tool) throw `unknown app API operation ${operation}`;
    let params;
    try {
        params = JSON.parse(paramsJson || "[]");
    } catch (error) {
        throw `params-json must be valid JSON: ${error.message}`;
    }
    if (!Array.isArray(params)) throw "params-json must be a JSON array";
    validateAppName(app);
    // Drop an override left by an earlier call, so the single app reads the target.
    setTarget(null);
    if (singleApp()) {
        await requireSingleApp(app);
    } else {
        const row = await appRequest(app, "GET", []);
        setTarget({ base: apiOrigin(row?.api_url), token: cloudToken() });
    }
    try {
        const value = await tool(...params);
        return JSON.stringify({ ok: value === undefined ? null : value });
    } catch (error) {
        if (Array.isArray(error?.permanent_missing_files)) {
            return JSON.stringify({ missing_files: error.permanent_missing_files });
        }
        throw toolErrorMessage(error);
    }
}

function toolErrorMessage(error) {
    if (typeof error === "string") return error;
    if (typeof error?.permanent_error === "string") return error.permanent_error;
    if (typeof error?.transient_error === "string") return error.transient_error;
    return error instanceof Error ? error.message : JSON.stringify(error);
}
