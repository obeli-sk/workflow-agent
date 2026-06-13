import * as session from "obelisk-agent:agent/session";
import * as webapi from "obelisk-agent:tools/webapi";
import * as askUser from "obelisk-agent:tools/input";
import * as deploy from "obelisk-agent:tools/deploy";

const RECV_TIMEOUT_MS = 30000;
const MAX_TURNS = 30;          // hard cap on agent loop turns
const MAX_CORRECTIONS = 3;     // re-prompts allowed per turn for a malformed reply
const MAX_TOOL_RESULT_BYTES = 96 * 1024;  // encoded-size cap per tool_result (argv-safe)

export default function agentLoop(prompt, socketPath) {
    if (typeof prompt !== "string" || !prompt.trim()) {
        throw "prompt is required";
    }
    if (typeof socketPath !== "string" || !socketPath) {
        throw "socket path is required";
    }

    // agent-input variant: { prompt } for the first turn, then { tool_results }.
    let nextInput = { prompt };
    let finalAnswer = null;
    const deploymentDraft = {
        config: null,
        baseDeploymentId: null,
        activeDeploymentId: null,
        revision: 0,
        shownRevision: -1,
    };

    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
        console.log(`--- turn ${turn} ---`);
        const reply = sendAndDrain(socketPath, nextInput);

        if (typeof reply.final === "string") {
            finalAnswer = reply.final;
            console.log(`final after ${turn + 1} turns`);
            break;
        }
        if (typeof reply.error === "string") {
            console.log(`agent requested error after ${turn + 1} turns`);
            throw reply.error;
        }
        if (Array.isArray(reply.tool_calls) && reply.tool_calls.length > 0) {
            console.log(`dispatching ${reply.tool_calls.length} tool call(s)`);
            const results = reply.tool_calls.map((call) => {
                const result = dispatch(call, deploymentDraft);
                console.log(`  ${call?.name}: ${"ok" in result.outcome ? "ok" : `err=${result.outcome.err}`}`);
                return result;
            });
            const applyIndex = reply.tool_calls.findIndex((call) => call?.name === "obelisk.apply_deployment");
            if (applyIndex !== -1) {
                const applyResult = results[applyIndex];
                if ("ok" in applyResult.outcome) {
                    finalAnswer = `Deployment hot reload approved and scheduled: ${applyResult.outcome.ok}`;
                } else {
                    finalAnswer = `Deployment hot reload was not scheduled: ${applyResult.outcome.err}`;
                }
                console.log("apply_deployment is terminal; finishing workflow before switch");
                break;
            }
            nextInput = { tool_results: results };
            continue;
        }
        throw `agent reply had no final answer and no tool calls: ${JSON.stringify(reply).slice(0, 500)}`;
    }

    if (finalAnswer === null) {
        throw `exceeded MAX_TURNS=${MAX_TURNS} without a final answer`;
    }
    return finalAnswer;
}

// Send one agent-input and drain the turn into a typed agent-reply
// ({ final } | { error } | { tool_calls }). Two recoverable agent-errors are
// handled here:
//   - permanent-rate-limited: durably sleep until the limit resets, then re-send
//     the same input. The supervisor can cancel this whole workflow at any time.
//   - permanent-malformed-reply: the agent's reply didn't parse as the envelope.
//     Re-prompt it (up to MAX_CORRECTIONS) to re-emit a bare JSON envelope.
// Both arms are `permanent-` so Obelisk never auto-retries the recv activity;
// recovery is the workflow's job because it requires another send.
function sendAndDrain(socketPath, input) {
    let pending = input;
    let corrections = 0;
    while (true) {
        session.send(socketPath, pending);
        try {
            return drainTurn(socketPath);
        } catch (error) {
            const limit = rateLimited(error);
            if (limit) {
                const seconds = limit.retry_after_seconds > 0 ? limit.retry_after_seconds : 1;
                console.log(`session limit reached (${limit.message}); sleeping ${seconds}s until reset`);
                obelisk.sleep({ seconds });
                console.log("rate-limit sleep elapsed; retrying turn");
                // Loop: re-send the same input now that the limit should be lifted.
                continue;
            }
            const malformed = malformedReply(error);
            if (malformed && corrections < MAX_CORRECTIONS) {
                corrections += 1;
                console.log(`malformed reply (correction ${corrections}/${MAX_CORRECTIONS}): ${malformed}`);
                pending = { prompt: correctionPrompt(malformed) };
                continue;
            }
            throw error;
        }
    }
}

// Corrective user message after a reply whose tool-call JSON didn't parse.
function correctionPrompt(detail) {
    return [
        "Your previous reply looked like it requested tools but the JSON could",
        "not be parsed.",
        `Parse error: ${detail}`,
        'To call tools, include a valid JSON object {"tool_calls": [{"name":',
        '"<tool>", "args": { ... }}]} (a ```json block is fine). If you are not',
        'calling tools, reply with {"error":"<reason>"} to fail the execution,',
        "or just reply with your final answer as plain text.",
    ].join(" ");
}

// recv stays alive for the whole turn and returns { reply: agent-reply } once
// it completes. Failures are thrown as the agent-error variant payload.
function drainTurn(socketPath) {
    const outcome = session.recv(socketPath, RECV_TIMEOUT_MS);
    // turn-outcome::reply is now a record { reply: agent-reply, narration }; the
    // workflow only needs the agent-reply (narration is for the UI). Tolerate the
    // old bare-agent-reply shape from results persisted before this change.
    if (outcome && typeof outcome === "object" && outcome.reply) {
        const r = outcome.reply;
        return (r && typeof r === "object" && "reply" in r) ? r.reply : r;
    }
    throw `unexpected recv outcome: ${JSON.stringify(outcome)}`;
}

// When an activity returns its err arm, the workflow runtime throws a JS Error
// whose `message` is the JSON-encoded err value (workflow-js-runtime:
// `Error(err_json)`). Parse it back into the agent-error variant object so the
// arms below can inspect it; non-JSON errors (traps, etc.) yield null.
function errPayload(error) {
    const raw = (error && typeof error === "object" && typeof error.message === "string")
        ? error.message
        : (typeof error === "string" ? error : null);
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) {
        return null;
    }
}

// recv's permanent-rate-limited arm: { permanent_rate_limited: { retry_after_seconds, message } }.
function rateLimited(error) {
    const p = errPayload(error);
    if (p && p.permanent_rate_limited && typeof p.permanent_rate_limited === "object") {
        return p.permanent_rate_limited;
    }
    return null;
}

// recv's permanent-malformed-reply arm: { permanent_malformed_reply: "<parse error>" }.
function malformedReply(error) {
    const p = errPayload(error);
    if (p && typeof p.permanent_malformed_reply === "string") {
        return p.permanent_malformed_reply;
    }
    return null;
}

// Dispatch one tool-call ({ name, arguments_json }) to its Obelisk activity and
// return a typed tool-result ({ name, outcome: result<string, string> }). The
// ok arm carries the activity's JSON string verbatim; server.js parses it back
// into structured data for the agent.
function dispatch(call, draft) {
    const name = (call && typeof call.name === "string") ? call.name : "?";
    let args;
    try {
        args = call && call.arguments_json ? JSON.parse(call.arguments_json) : {};
    } catch (e) {
        return err(name, `invalid arguments_json: ${String(e)}`);
    }
    if (typeof args !== "object" || args === null) args = {};

    try {
        switch (name) {
            case "obelisk.list_functions":
                return ok(name, webapi.listFunctions(
                    String(args.ffqn_prefix || ""),
                    (args.length | 0) || 100,
                ));
            case "obelisk.get_function_wit":
                return ok(name, webapi.getFunctionWit(requireString(args.ffqn, "ffqn")));
            case "obelisk.list_executions": {
                const len = (args.length | 0) || 20;
                return ok(name, webapi.listExecutions(
                    String(args.ffqn_prefix || ""),
                    String(args.execution_id_prefix || ""),
                    Boolean(args.show_derived),
                    Boolean(args.hide_finished),
                    String(args.component_digest || ""),
                    String(args.deployment_id || ""),
                    String(args.cursor || ""),
                    paginationDirection(args.direction),
                    Boolean(args.including_cursor),
                    len,
                ));
            }
            case "obelisk.get_execution":
                return ok(name, webapi.getExecution(requireString(args.execution_id, "execution_id")));
            case "obelisk.get_logs":
                return ok(name, webapi.getLogs(
                    requireString(args.execution_id, "execution_id"),
                    args.show_derived === undefined ? true : Boolean(args.show_derived),
                    args.show_logs === undefined ? true : Boolean(args.show_logs),
                    args.show_streams === undefined ? true : Boolean(args.show_streams),
                    arrayArgOr(args.levels, []),
                    arrayArgOr(args.stream_types, []),
                    String(args.cursor || ""),
                    paginationDirection(args.direction),
                    Boolean(args.including_cursor),
                    (args.length | 0) || 200,
                ));
            case "obelisk.submit":
                return ok(name, webapi.submitJson(
                    requireString(args.ffqn, "ffqn"),
                    JSON.stringify(Array.isArray(args.params) ? args.params : []),
                ));
            case "obelisk.get_result":
                return ok(name, webapi.getResultJson(requireString(args.execution_id, "execution_id")));
            case "obelisk.list_deployments":
                return ok(name, webapi.listDeployments(
                    String(args.cursor_from || ""),
                    Boolean(args.including_cursor),
                    (args.length | 0) || 20,
                ));
            case "obelisk.get_deployment":
                // Sources are stripped server-side, so the child execution result
                // is the compact record the model receives (not the full config).
                return ok(name, webapi.getDeployment(
                    requireString(args.deployment_id, "deployment_id"),
                    optionalString(args.component_type),
                    optionalU32(args.offset),
                    optionalU32(args.length),
                    optionalU32(args.max_bytes),
                ));
            case "obelisk.get_component_source":
                // Sliced server-side so the child result is just the requested page.
                return ok(name, webapi.getComponentSource(
                    requireString(args.deployment_id, "deployment_id"),
                    requireString(args.component, "component"),
                    args.offset | 0,
                    args.length | 0,
                ));
            case "obelisk.current_deployment_id":
                return ok(name, webapi.currentDeploymentId());
            case "obelisk.create_deployment":
                return ok(name, webapi.createDeployment(
                    requireString(args.config_json, "config_json"),
                    Boolean(args.verify),
                ));
            case "obelisk.deployment_edit_begin":
                return beginDeploymentEdit(name, args, draft);
            case "obelisk.deployment_edit_upsert_js_activity":
                return upsertJsActivity(name, args, draft);
            case "obelisk.deployment_edit_upsert_js_workflow":
                return upsertJsWorkflow(name, args, draft);
            case "obelisk.deployment_edit_upsert_js_webhook":
                return upsertJsWebhook(name, args, draft);
            case "obelisk.deployment_edit_delete":
                return deleteDeploymentComponent(name, args, draft);
            case "obelisk.deployment_edit_show":
                return showDeploymentEdit(name, draft);
            case "obelisk.deployment_edit_abort":
                return abortDeploymentEdit(name, draft);
            case "obelisk.deployment_edit_submit":
                return submitDeploymentEdit(name, args, draft);
            case "obelisk.apply_deployment": {
                const id = requireString(args.deployment_id, "deployment_id");
                const summary = typeof args.summary === "string" ? args.summary : "";
                // Durable human gate: park until an operator approves/cancels in
                // the UI. Cancel throws the err arm, which the catch below turns
                // into an err tool_result so the agent learns the decision.
                deploy.confirmApply(id, summary);
                return ok(name, webapi.applyDeployment(id));
            }
            case "input.ask_user":
                return ok(name, JSON.stringify({ answer: askUser.askUser(requireString(args.question, "question")) }));
            default:
                return err(name, `unknown tool: ${name}`);
        }
    } catch (e) {
        return err(name, String(e));
    }
}

function beginDeploymentEdit(name, args, draft) {
    if (draft.config !== null) throw "a deployment edit transaction is already active";
    const payload = {};
    if (typeof args.deployment_id === "string" && args.deployment_id) {
        payload.deployment_id = args.deployment_id;
    }
    const recordJson = webapi.deploymentEdit("begin", JSON.stringify(payload));
    const begin = JSON.parse(recordJson);
    const record = begin?.deployment;
    if (!record || typeof record.deployment_id !== "string" || typeof record.config_json !== "string") {
        throw "deployment-edit begin returned an invalid deployment record";
    }
    if (typeof begin.active_deployment_id !== "string" || !begin.active_deployment_id) {
        throw "deployment-edit begin returned no active deployment id";
    }
    draft.config = JSON.parse(record.config_json);
    draft.baseDeploymentId = record.deployment_id;
    draft.activeDeploymentId = begin.active_deployment_id;
    draft.revision = 0;
    draft.shownRevision = -1;
    return ok(name, JSON.stringify({
        base_deployment_id: draft.baseDeploymentId,
        active_deployment_id: draft.activeDeploymentId,
        components: componentCounts(draft.config),
    }));
}

function upsertJsActivity(name, args, draft) {
    requireDraft(draft);
    const ffqn = requireString(args.ffqn, "ffqn");
    const componentName = requireString(args.name, "name");
    const source = requireString(args.source, "source");
    const list = requireArray(draft.config.activities_js, "activities_js");
    const index = list.findIndex((item) => item?.ffqn === ffqn);
    const collision = list.findIndex((item, i) => i !== index && item?.name === componentName);
    if (collision !== -1) throw `activity name already belongs to ${list[collision].ffqn}`;
    const previous = index === -1 ? null : list[index];
    const template = previous || list[0];
    if (!template) throw "deployment has no JS activity defaults";
    const next = {
        ...template,
        name: componentName,
        location: inlineSource(componentName, source),
        content_digest: null,
        component_digest: null,
        ffqn,
        params: arrayArgOr(args.params, previous?.params),
        env_vars: arrayArgOr(args.env_vars, previous?.env_vars),
        allowed_hosts: allowedHostsArgOr(args.allowed_hosts, previous?.allowed_hosts),
        return_type: stringArg(args.return_type, previous?.return_type || "result"),
    };
    const action = applyUpsert(list, index, next);
    recordUpsert(draft, action, "js_activity", ffqn);
    return ok(name, JSON.stringify({ action, ffqn }));
}

function upsertJsWorkflow(name, args, draft) {
    requireDraft(draft);
    const ffqn = requireString(args.ffqn, "ffqn");
    const componentName = requireString(args.name, "name");
    const source = requireString(args.source, "source");
    const list = requireArray(draft.config.workflows_js, "workflows_js");
    const index = list.findIndex((item) => item?.ffqn === ffqn);
    const collision = list.findIndex((item, i) => i !== index && item?.name === componentName);
    if (collision !== -1) throw `workflow name already belongs to ${list[collision].ffqn}`;
    const previous = index === -1 ? null : list[index];
    const template = previous || list[0];
    if (!template) throw "deployment has no JS workflow defaults";
    const next = {
        ...template,
        name: componentName,
        location: inlineSource(componentName, source),
        content_digest: null,
        component_digest: null,
        ffqn,
        params: arrayArgOr(args.params, previous?.params),
        return_type: stringArg(args.return_type, previous?.return_type || "result"),
    };
    const action = applyUpsert(list, index, next);
    recordUpsert(draft, action, "js_workflow", ffqn);
    return ok(name, JSON.stringify({ action, ffqn }));
}

function upsertJsWebhook(name, args, draft) {
    requireDraft(draft);
    const componentName = requireString(args.name, "name");
    const source = requireString(args.source, "source");
    const list = requireArray(draft.config.webhooks_js, "webhooks_js");
    const index = list.findIndex((item) => item?.name === componentName);
    const previous = index === -1 ? null : list[index];
    const template = previous || list[0];
    if (!template) throw "deployment has no JS webhook defaults";
    const routes = arrayArgOr(args.routes, previous?.routes);
    if (routes.length === 0) throw "routes must contain at least one route";
    const next = {
        ...template,
        name: componentName,
        location: inlineSource(componentName, source),
        content_digest: null,
        routes,
        env_vars: arrayArgOr(args.env_vars, previous?.env_vars),
        allowed_host: allowedHostsArgOr(args.allowed_hosts, previous?.allowed_host),
    };
    const action = applyUpsert(list, index, next);
    recordUpsert(draft, action, "js_webhook", componentName);
    return ok(name, JSON.stringify({ action, name: componentName }));
}

function deleteDeploymentComponent(name, args, draft) {
    requireDraft(draft);
    const kind = requireString(args.kind, "kind");
    const id = requireString(args.id, "id");
    const spec = {
        js_activity: { key: "activities_js", matches: (item) => item?.ffqn === id },
        js_workflow: { key: "workflows_js", matches: (item) => item?.ffqn === id },
        js_webhook: { key: "webhooks_js", matches: (item) => item?.name === id },
    }[kind];
    if (!spec) throw "kind must be js_activity, js_workflow, or js_webhook";
    const list = requireArray(draft.config[spec.key], spec.key);
    const index = list.findIndex(spec.matches);
    if (index === -1) {
        webapi.deploymentEdit("record", JSON.stringify({ action: "already_absent", kind, id }));
        return ok(name, JSON.stringify({ action: "already_absent", kind, id }));
    }
    list.splice(index, 1);
    recordDraftEdit(draft, { action: "deleted", kind, id });
    return ok(name, JSON.stringify({ action: "deleted", kind, id }));
}

function showDeploymentEdit(name, draft) {
    requireDraft(draft);
    const configJson = JSON.stringify(draft.config);
    // The child activity result contains the complete canonical deployment for
    // operator inspection. Do not echo 94+ KB back through session.send: JSON
    // argument escaping can exceed the OS argv limit.
    webapi.deploymentEdit("show", JSON.stringify({ config_json: configJson }));
    draft.shownRevision = draft.revision;
    return ok(name, JSON.stringify({
        reviewed_revision: draft.revision,
        config_bytes: configJson.length,
        components: componentCounts(draft.config),
        complete_config: "available in the deployment_edit_show child execution result",
    }));
}

function abortDeploymentEdit(name, draft) {
    requireDraft(draft);
    webapi.deploymentEdit("record", JSON.stringify({
        action: "aborted",
        base_deployment_id: draft.baseDeploymentId,
        active_deployment_id: draft.activeDeploymentId,
        revision: draft.revision,
    }));
    clearDraft(draft);
    return ok(name, JSON.stringify({ aborted: true }));
}

function submitDeploymentEdit(name, args, draft) {
    requireDraft(draft);
    if (draft.shownRevision !== draft.revision) {
        throw "current draft must be shown after its last edit before submit";
    }
    const deploymentId = webapi.deploymentEdit("submit", JSON.stringify({
        active_deployment_id: draft.activeDeploymentId,
        config_json: JSON.stringify(draft.config),
        verify: Boolean(args.verify),
    }));
    const result = {
        deployment_id: JSON.parse(deploymentId),
        base_deployment_id: draft.baseDeploymentId,
        revision: draft.revision,
    };
    clearDraft(draft);
    return ok(name, JSON.stringify(result));
}

function recordDraftEdit(draft, event) {
    webapi.deploymentEdit("record", JSON.stringify(event));
    draft.revision += 1;
    draft.shownRevision = -1;
}

function applyUpsert(list, index, next) {
    if (index === -1) {
        list.push(next);
        return "added";
    }
    if (JSON.stringify(list[index]) === JSON.stringify(next)) return "unchanged";
    list[index] = next;
    return "replaced";
}

function recordUpsert(draft, action, kind, id) {
    const event = { action, kind, id };
    if (action === "unchanged") {
        webapi.deploymentEdit("record", JSON.stringify(event));
    } else {
        recordDraftEdit(draft, event);
    }
}

function requireDraft(draft) {
    if (!draft || draft.config === null) throw "no deployment edit transaction; call deployment_edit_begin first";
}

function clearDraft(draft) {
    draft.config = null;
    draft.baseDeploymentId = null;
    draft.activeDeploymentId = null;
    draft.revision = 0;
    draft.shownRevision = -1;
}

function inlineSource(name, source) {
    return { content: { content: source, file_name: `${name}.js` } };
}

function arrayArgOr(value, fallback) {
    return Array.isArray(value) ? value : (Array.isArray(fallback) ? fallback : []);
}

function allowedHostsArgOr(value, fallback) {
    if (!Array.isArray(value)) return Array.isArray(fallback) ? fallback : [];
    return value.map((host) => ({
        pattern: requireString(host?.pattern, "allowed_hosts[].pattern"),
        methods: Array.isArray(host?.methods) ? host.methods : [],
        secrets: null,
    }));
}

function stringArg(value, fallback) {
    return typeof value === "string" && value ? value : fallback;
}

function paginationDirection(value) {
    if (value === undefined || value === null || value === "") return "";
    if (value !== "older" && value !== "newer") {
        throw "direction must be older or newer";
    }
    return value;
}

function requireArray(value, field) {
    if (!Array.isArray(value)) throw `deployment config has no ${field} array`;
    return value;
}

function componentCounts(config) {
    return {
        js_activities: Array.isArray(config.activities_js) ? config.activities_js.length : 0,
        js_workflows: Array.isArray(config.workflows_js) ? config.workflows_js.length : 0,
        js_webhooks: Array.isArray(config.webhooks_js) ? config.webhooks_js.length : 0,
    };
}

function ok(name, jsonString) {
    const s = typeof jsonString === "string" ? jsonString : JSON.stringify(jsonString);
    // The result rides back inside session.send's single argv param, which is
    // JSON-encoded (escaping can roughly double it). Bound the encoded size so a
    // tool_result cannot exceed the OS argv limit (MAX_ARG_STRLEN, 128 KiB) and
    // crash send with E2BIG. Oversized results become an err the model can act on.
    const encoded = JSON.stringify(s).length;
    if (encoded > MAX_TOOL_RESULT_BYTES) {
        return err(name, `result too large (~${encoded} encoded bytes); narrow the request with pagination or a more specific selector`);
    }
    return { name, outcome: { ok: s } };
}
function err(name, message) { return { name, outcome: { err: message } }; }

function requireString(value, field) {
    if (typeof value !== "string" || !value) throw `${field} is required`;
    return value;
}

function optionalString(value) {
    return typeof value === "string" && value ? value : null;
}

function optionalU32(value) {
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}
