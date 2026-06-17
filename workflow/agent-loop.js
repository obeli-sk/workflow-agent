import * as session from "obelisk-agent:agent/session";
import * as webapi from "obelisk-agent:tools/webapi";
import * as askUser from "obelisk-agent:tools/input";
import * as deploy from "obelisk-agent:tools/deploy";

const RECV_TIMEOUT_MS = 30000;
const MAX_TURNS = 30;          // hard cap on agent loop turns
const MAX_CORRECTIONS = 3;     // re-prompts allowed per turn for a malformed reply
const MAX_TOOL_RESULT_BYTES = 96 * 1024;  // encoded-size cap per tool_result (argv-safe)
const INJECTION_FFQN = "obelisk-agent:agent/session.injection";

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
    let injection = null;
    // Checked-out deployment working copy. `config` is the full canonical config
    // (structural source of truth); source bodies are exposed as editable files
    // derived from it on demand. See the deployment_* tools below.
    const deploymentDraft = {
        config: null,
        baseDeploymentId: null,
        activeDeploymentId: null,
    };

    try {
        for (let turn = 0; turn < MAX_TURNS; turn += 1) {
            console.log(`--- turn ${turn} ---`);
            const prepared = prepareInjection(injection);
            injection = prepared.injection;
            const reply = sendAndDrain(socketPath, nextInput, prepared.operatorMessages);

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
                // Explicit human gates own the input UI while blocked. Cancel the
                // generic injection offer before entering either stub activity.
                if (reply.tool_calls.some(isBlockingHumanTool)) {
                    closeInjection(injection);
                    injection = null;
                }
                console.log(`dispatching ${reply.tool_calls.length} tool call(s)`);
                const results = reply.tool_calls.map((call) => {
                    const result = dispatch(call, deploymentDraft);
                    console.log(`  ${call?.name}: ${"ok" in result.outcome ? "ok" : `err=${result.outcome.err}`}`);
                    return result;
                });
                // A hot redeploy (deployment_push mode "apply") is terminal: the
                // switch runs out of process after this workflow finishes, so we
                // must not continue the loop past it.
                const applyIndex = reply.tool_calls.findIndex(isHotApplyPush);
                if (applyIndex !== -1) {
                    const applyResult = results[applyIndex];
                    if ("ok" in applyResult.outcome) {
                        finalAnswer = `Deployment hot reload approved and scheduled: ${applyResult.outcome.ok}`;
                    } else {
                        finalAnswer = `Deployment hot reload was not scheduled: ${applyResult.outcome.err}`;
                    }
                    console.log("deployment_push(apply) is terminal; finishing workflow before switch");
                    break;
                }
                nextInput = { tool_results: results };
                continue;
            }
            throw `agent reply had no final answer and no tool calls: ${JSON.stringify(reply).slice(0, 500)}`;
        }
    } finally {
        closeInjection(injection);
    }

    if (finalAnswer === null) {
        throw `exceeded MAX_TURNS=${MAX_TURNS} without a final answer`;
    }
    return finalAnswer;
}

// Keep exactly one durable operator-input stub outstanding while the agent can
// accept generic steering. A completed response is consumed at a send boundary,
// included in that normal session.send call, and replaced with a fresh stub.
function prepareInjection(injection) {
    let current = injection || openInjection();
    const text = current.joinSet.joinNextTry();
    if (text === undefined) return { injection: current, operatorMessages: [] };
    if (typeof text !== "string" || !text.trim()) {
        throw "injection text must be a non-empty string";
    }
    console.log(`consumed operator injection from ${current.executionId}`);
    current.joinSet.close();
    current = openInjection();
    return { injection: current, operatorMessages: [text.trim()] };
}

function openInjection() {
    const joinSet = obelisk.createJoinSet();
    const executionId = joinSet.submit(INJECTION_FFQN, []);
    console.log(`opened operator injection ${executionId}`);
    return { joinSet, executionId };
}

function closeInjection(injection) {
    if (injection === null) return;
    try { injection.joinSet.close(); }
    catch (error) { console.log(`injection close failed: ${String(error)}`); }
}

function isBlockingHumanTool(call) {
    return call?.name === "input.ask_user" || isHotApplyPush(call);
}

// A deployment_push requesting a hot redeploy: it parks on the confirm-apply
// human gate and is terminal, so it owns the input UI while blocked.
function isHotApplyPush(call) {
    if (call?.name !== "obelisk.deployment_push") return false;
    try {
        const args = call.arguments_json ? JSON.parse(call.arguments_json) : {};
        return args && args.mode === "apply";
    } catch (_) {
        return false;
    }
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
function sendAndDrain(socketPath, input, operatorMessages) {
    let pending = input;
    let pendingOperatorMessages = operatorMessages;
    let corrections = 0;
    while (true) {
        session.send(socketPath, pending, pendingOperatorMessages);
        pendingOperatorMessages = [];
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
                // Sources are stripped and config_json is decoded server-side, so
                // the child result is the compact record the model receives.
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
            case "obelisk.deployment_checkout":
                return deploymentCheckout(name, args, draft);
            case "obelisk.deployment_list_files":
                return deploymentListFiles(name, draft);
            case "obelisk.deployment_read_file":
                return deploymentReadFile(name, args, draft);
            case "obelisk.deployment_write_file":
                return deploymentWriteFile(name, args, draft);
            case "obelisk.deployment_add_component":
                return deploymentAddComponent(name, args, draft);
            case "obelisk.deployment_remove_component":
                return deploymentRemoveComponent(name, args, draft);
            case "obelisk.deployment_push":
                return deploymentPush(name, args, draft);
            case "input.ask_user":
                return ok(name, JSON.stringify({ answer: askUser.askUser(requireString(args.question, "question")) }));
            default:
                return err(name, `unknown tool: ${name}`);
        }
    } catch (e) {
        return err(name, String(e));
    }
}

// --- Deployment working copy (checkout -> edit files -> push) ----------------
//
// The workflow keeps the checked-out canonical config in memory as the
// structural source of truth. Source bodies are externalized into a virtual
// file map exactly as `obelisk deployment get` does: each owned script location
// `{ content: { content, file_name } }` becomes a file at `file_name`, deduped
// by path so components sharing identical content share one file. WASM backtrace
// `frame_files_to_sources` sources are exposed read-only. The agent edits those
// files (and structure via typed ops), then pushes.

// Script-source component arrays and the field identifying each component.
const SCRIPT_ARRAYS = [
    { key: "activities_js", kind: "js_activity", idField: "ffqn" },
    { key: "activities_exec", kind: "exec_activity", idField: "ffqn" },
    { key: "workflows_js", kind: "js_workflow", idField: "ffqn" },
    { key: "webhooks_js", kind: "js_webhook", idField: "name" },
];
// WASM component arrays carrying backtrace source maps (read-only files).
const BACKTRACE_ARRAYS = [
    { key: "workflows_wasm", kind: "wasm_workflow" },
    { key: "webhooks_wasm", kind: "wasm_webhook" },
];

function requireDraft(draft) {
    if (!draft || draft.config === null) {
        throw "no deployment checked out; call deployment_checkout first";
    }
}

function componentLabel(item, idField) {
    return (item && (item[idField] || item.ffqn || item.name)) || "?";
}

// Walk the canonical config and build the virtual filesystem: path -> content,
// path -> referencing components, and the set of read-only (backtrace) paths.
function collectFiles(config) {
    const files = {};
    const refs = {};
    const readonly = new Set();
    const collisions = [];
    const add = (path, content, ref, isReadonly) => {
        if (path in files) {
            if (files[path] !== content && !collisions.includes(path)) collisions.push(path);
        } else {
            files[path] = content;
        }
        (refs[path] = refs[path] || []).push(ref);
        if (isReadonly) readonly.add(path);
    };
    for (const { key, kind, idField } of SCRIPT_ARRAYS) {
        for (const item of config[key] || []) {
            const content = item && item.location && item.location.content;
            if (content && typeof content.content === "string" && typeof content.file_name === "string") {
                add(content.file_name, content.content, `${kind}:${componentLabel(item, idField)}`, false);
            }
        }
    }
    for (const { key, kind } of BACKTRACE_ARRAYS) {
        for (const item of config[key] || []) {
            const sources = item && item.backtrace && item.backtrace.frame_files_to_sources;
            if (!sources || typeof sources !== "object") continue;
            for (const source of Object.values(sources)) {
                if (source && typeof source.content === "string" && typeof source.file_name === "string") {
                    add(source.file_name, source.content, `${kind}:${componentLabel(item, "name")}`, true);
                }
            }
        }
    }
    return { files, refs, readonly, collisions };
}

function fileListing(fs) {
    const entries = Object.keys(fs.files).sort().map((path) => ({
        path,
        bytes: fs.files[path].length,
        read_only: fs.readonly.has(path),
        components: fs.refs[path] || [],
    }));
    // The structural manifest is a synthetic, read-only file.
    entries.unshift({ path: "deployment.toml", read_only: true, components: ["(structure)"] });
    return entries;
}

function deploymentCheckout(name, args, draft) {
    const json = webapi.deploymentCheckout(optionalString(args.deployment_id));
    const res = JSON.parse(json);
    if (typeof res.config_json !== "string") throw "checkout returned no config_json";
    draft.config = JSON.parse(res.config_json);
    draft.baseDeploymentId = res.deployment_id;
    draft.activeDeploymentId = res.active_deployment_id;
    const fs = collectFiles(draft.config);
    return ok(name, JSON.stringify({
        base_deployment_id: draft.baseDeploymentId,
        active_deployment_id: draft.activeDeploymentId,
        components: componentCounts(draft.config),
        files: fileListing(fs),
        collisions: fs.collisions,
        note: "Read/edit source files with deployment_read_file / deployment_write_file. "
            + "Change structure with deployment_add_component / deployment_remove_component. "
            + "deployment.toml is a read-only structural view. Finish with deployment_push.",
    }));
}

function deploymentListFiles(name, draft) {
    requireDraft(draft);
    return ok(name, JSON.stringify({ files: fileListing(collectFiles(draft.config)) }));
}

function deploymentReadFile(name, args, draft) {
    requireDraft(draft);
    const path = requireString(args.path, "path");
    if (path === "deployment.toml") {
        return ok(name, JSON.stringify({ path, content: renderDeploymentToml(draft.config) }));
    }
    const fs = collectFiles(draft.config);
    if (!(path in fs.files)) throw `unknown file: ${path}`;
    return ok(name, JSON.stringify({
        path,
        read_only: fs.readonly.has(path),
        components: fs.refs[path] || [],
        content: fs.files[path],
    }));
}

function deploymentWriteFile(name, args, draft) {
    requireDraft(draft);
    const path = requireString(args.path, "path");
    if (typeof args.content !== "string") throw "content is required";
    if (path === "deployment.toml") {
        throw "deployment.toml is read-only; change structure with deployment_add_component / deployment_remove_component";
    }
    const fs = collectFiles(draft.config);
    if (fs.readonly.has(path)) throw `${path} is a read-only backtrace source`;
    if (!(path in fs.files)) throw `unknown file: ${path}; add the component first with deployment_add_component`;
    const updated = setFileContent(draft.config, path, args.content);
    return ok(name, JSON.stringify({ path, bytes: args.content.length, updated_components: updated }));
}

// Update every owned script location that points at `path`, returning the
// affected component labels. Digests are cleared so submit recomputes them.
function setFileContent(config, path, content) {
    const updated = [];
    for (const { key, idField } of SCRIPT_ARRAYS) {
        for (const item of config[key] || []) {
            const loc = item && item.location && item.location.content;
            if (loc && loc.file_name === path) {
                loc.content = content;
                if ("content_digest" in item) item.content_digest = null;
                if ("component_digest" in item) item.component_digest = null;
                updated.push(componentLabel(item, idField));
            }
        }
    }
    return updated;
}

function deploymentAddComponent(name, args, draft) {
    requireDraft(draft);
    const kind = requireString(args.kind, "kind");
    const source = requireString(args.source, "source");
    const componentName = requireString(args.name, "name");
    const spec = {
        js_activity: { key: "activities_js", idField: "ffqn" },
        js_workflow: { key: "workflows_js", idField: "ffqn" },
        js_webhook: { key: "webhooks_js", idField: "name" },
    }[kind];
    if (!spec) throw "kind must be js_activity, js_workflow, or js_webhook";
    const list = requireArray(draft.config[spec.key], spec.key);

    const ffqn = kind === "js_webhook" ? null : requireString(args.ffqn, "ffqn");
    const index = kind === "js_webhook"
        ? list.findIndex((item) => item?.name === componentName)
        : list.findIndex((item) => item?.ffqn === ffqn);
    if (kind !== "js_webhook") {
        const collision = list.findIndex((item, i) => i !== index && item?.name === componentName);
        if (collision !== -1) throw `name already belongs to ${list[collision].ffqn}`;
    }
    const previous = index === -1 ? null : list[index];
    const template = previous || list[0];
    if (!template) throw `deployment has no ${spec.key} defaults to base a new component on`;

    let next;
    if (kind === "js_activity") {
        next = {
            ...template, name: componentName, location: inlineSource(componentName, source),
            content_digest: null, component_digest: null, ffqn,
            params: arrayArgOr(args.params, previous?.params),
            env_vars: arrayArgOr(args.env_vars, previous?.env_vars),
            allowed_hosts: allowedHostsArgOr(args.allowed_hosts, previous?.allowed_hosts),
            return_type: stringArg(args.return_type, previous?.return_type || "result"),
        };
    } else if (kind === "js_workflow") {
        next = {
            ...template, name: componentName, location: inlineSource(componentName, source),
            content_digest: null, component_digest: null, ffqn,
            params: arrayArgOr(args.params, previous?.params),
            return_type: stringArg(args.return_type, previous?.return_type || "result"),
        };
    } else {
        const routes = arrayArgOr(args.routes, previous?.routes);
        if (routes.length === 0) throw "routes must contain at least one route";
        next = {
            ...template, name: componentName, location: inlineSource(componentName, source),
            content_digest: null, routes,
            env_vars: arrayArgOr(args.env_vars, previous?.env_vars),
            allowed_host: allowedHostsArgOr(args.allowed_hosts, previous?.allowed_host),
        };
    }
    const action = applyUpsert(list, index, next);
    return ok(name, JSON.stringify({ action, kind, id: ffqn || componentName, file: `${componentName}.js` }));
}

function deploymentRemoveComponent(name, args, draft) {
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
    if (index === -1) return ok(name, JSON.stringify({ action: "already_absent", kind, id }));
    list.splice(index, 1);
    return ok(name, JSON.stringify({ action: "removed", kind, id }));
}

function deploymentPush(name, args, draft) {
    requireDraft(draft);
    const mode = requireString(args.mode, "mode");
    if (!["submit", "enqueue", "apply"].includes(mode)) {
        throw "mode must be submit, enqueue, or apply";
    }
    const description = requireString(args.description, "description");
    const verify = Boolean(args.verify);
    const requestedId = optionalString(args.deployment_id) || "";

    const configJson = JSON.stringify(prepareForSubmit(draft.config));
    const id = webapi.deploymentSubmit(configJson, description, verify, requestedId);

    if (mode === "submit") {
        return ok(name, JSON.stringify({ deployment_id: id, mode, status: "submitted (inactive)" }));
    }
    if (mode === "enqueue") {
        const sw = webapi.deploymentSwitch(id, verify);
        return ok(name, JSON.stringify({ deployment_id: id, mode, status: "enqueued for next restart", switch: sw }));
    }
    // apply: durable human gate, then schedule the hot switch out of process (a
    // synchronous switch from inside this activity would deadlock the executor).
    deploy.confirmApply(id, description);
    const applied = webapi.applyDeployment(id);
    return ok(name, JSON.stringify({ deployment_id: id, mode, status: "hot reload scheduled", apply: applied }));
}

// Clone the canonical config for submission, clearing the recomputable digests
// of owned script components so the server recomputes them from the (possibly
// edited) inline content. WASM/OCI/stub/cron components are left untouched.
function prepareForSubmit(config) {
    const clone = JSON.parse(JSON.stringify(config));
    for (const { key } of SCRIPT_ARRAYS) {
        for (const item of clone[key] || []) {
            if ("content_digest" in item) item.content_digest = null;
            if ("component_digest" in item) item.component_digest = null;
        }
    }
    return clone;
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

function inlineSource(name, source) {
    return { content: { content: source, file_name: `${name}.js` } };
}

// --- Read-only `deployment.toml` rendering -----------------------------------
// A structural view of the canonical config with source bodies elided and each
// owned location shown as its relative path. It mirrors `deployment get`'s TOML
// closely enough to orient the agent; editing happens through the typed ops.
function renderDeploymentToml(config) {
    try {
        return serializeToml(toTomlShape(config));
    } catch (e) {
        return `# could not render TOML (${String(e)}); structural JSON view:\n`
            + JSON.stringify(config, tomlReplacer, 2);
    }
}

const TOML_ORDER = [
    "activities_wasm", "activities_stub", "activities_external",
    "activities_js", "activities_exec",
    "workflows_wasm", "workflows_js", "webhooks_wasm", "webhooks_js", "crons",
];

function toTomlShape(config) {
    const out = {};
    for (const key of TOML_ORDER) {
        const arr = config[key];
        if (!Array.isArray(arr) || arr.length === 0) continue;
        const isScript = SCRIPT_ARRAYS.some((s) => s.key === key);
        const isBacktrace = BACKTRACE_ARRAYS.some((s) => s.key === key);
        out[key] = arr.map((item) => tomlComponent(item, isScript, isBacktrace));
    }
    return out;
}

function tomlComponent(item, isScript, isBacktrace) {
    const clone = JSON.parse(JSON.stringify(item));
    if (isScript) {
        clone.location = locationString(clone.location);
        delete clone.content;
    }
    if (isBacktrace && clone.backtrace && clone.backtrace.frame_files_to_sources) {
        const map = {};
        for (const [k, v] of Object.entries(clone.backtrace.frame_files_to_sources)) {
            map[k] = v && typeof v === "object" ? v.file_name : v;
        }
        clone.backtrace = { frame_files_to_sources: map };
    }
    return pruneEmpty(clone);
}

function locationString(loc) {
    if (!loc || typeof loc !== "object") return loc;
    if (loc.content) return loc.content.file_name;
    if (loc.external_path) return loc.external_path.path;
    if (loc.oci) return loc.oci.image;
    return JSON.stringify(loc);
}

// Drop null/undefined and empty containers so the rendered TOML stays readable.
function pruneEmpty(value) {
    if (Array.isArray(value)) {
        const arr = value.map(pruneEmpty).filter((v) => v !== undefined);
        return arr;
    }
    if (value && typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            const pruned = pruneEmpty(v);
            if (pruned === undefined || pruned === null) continue;
            if (Array.isArray(pruned) && pruned.length === 0) continue;
            if (pruned && typeof pruned === "object" && !Array.isArray(pruned) && Object.keys(pruned).length === 0) continue;
            out[k] = pruned;
        }
        return out;
    }
    return value === null ? undefined : value;
}

function serializeToml(shape) {
    const lines = [];
    for (const key of Object.keys(shape)) {
        for (const el of shape[key]) {
            lines.push(`[[${key}]]`);
            for (const [k, v] of Object.entries(el)) {
                if (v === null || v === undefined) continue;
                lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
            }
            lines.push("");
        }
    }
    return `${lines.join("\n").trim()}\n`;
}

function tomlValue(v) {
    if (typeof v === "string") return JSON.stringify(v);
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
    if (v && typeof v === "object") {
        const parts = Object.entries(v)
            .filter(([, x]) => x !== null && x !== undefined)
            .map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`);
        return parts.length ? `{ ${parts.join(", ")} }` : "{}";
    }
    return '""';
}

function tomlKey(k) {
    return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

function tomlReplacer(key, value) {
    // In the JSON fallback, elide large inline source bodies.
    if (key === "content" && typeof value === "string" && value.length > 200) {
        return `<${value.length} bytes elided>`;
    }
    return value;
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
    const count = (key) => (Array.isArray(config[key]) ? config[key].length : 0);
    return {
        activities_js: count("activities_js"),
        activities_exec: count("activities_exec"),
        activities_wasm: count("activities_wasm"),
        activities_stub: count("activities_stub"),
        activities_external: count("activities_external"),
        workflows_js: count("workflows_js"),
        workflows_wasm: count("workflows_wasm"),
        webhooks_js: count("webhooks_js"),
        webhooks_wasm: count("webhooks_wasm"),
        crons: count("crons"),
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
