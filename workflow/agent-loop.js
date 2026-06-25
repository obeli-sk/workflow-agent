import * as session from 'obelisk-agent:agent/session';
import * as webapi from 'obelisk-agent:tools/webapi';
import * as askUser from 'obelisk-agent:tools/input';
import * as deploy from 'obelisk-agent:tools/deploy';

const RECV_TIMEOUT_MS = 30000;
const MAX_TURNS = 30;
const MAX_CORRECTIONS = 3;
const MAX_TOOL_RESULT_BYTES = 96 * 1024;
const INJECTION_FFQN = 'obelisk-agent:agent/session.injection';

export default function agentLoop(prompt, socketPath) {
    if (typeof prompt !== 'string' || !prompt.trim()) throw 'prompt is required';
    if (typeof socketPath !== 'string' || !socketPath) throw 'socket path is required';
    let nextInput = { prompt };
    let finalAnswer = null;
    let injection = null;
    const state = {
        checkedOut: false,
        baseDeploymentId: null,
        activeDeploymentId: null,
        preamble: '',
        blocks: [],
        editedFiles: {},
        dirty: [],
        joinSets: {},
        nextJoinSet: 1,
    };
    try {
        for (let turn = 0; turn < MAX_TURNS; turn += 1) {
            console.log(`--- turn ${turn} ---`);
            const prepared = prepareInjection(injection);
            injection = prepared.injection;
            const reply = sendAndDrain(socketPath, nextInput, prepared.operatorMessages);
            if (typeof reply.final === 'string') {
                finalAnswer = reply.final;
                console.log(`final after ${turn + 1} turns`);
                break;
            }
            if (typeof reply.error === 'string') throw reply.error;
            if (Array.isArray(reply.tool_calls) && reply.tool_calls.length > 0) {
                if (reply.tool_calls.some(isBlockingHumanTool)) {
                    closeInjection(injection);
                    injection = null;
                }
                console.log(`dispatching ${reply.tool_calls.length} tool call(s)`);
                const results = reply.tool_calls.map((call) => {
                    const result = dispatch(call, state);
                    console.log(`  ${call?.name}: ${'ok' in result.outcome ? 'ok' : `err=${result.outcome.err}`}`);
                    return result;
                });
                const applyIndex = reply.tool_calls.findIndex(isHotApplyPush);
                if (applyIndex !== -1) {
                    const applyResult = results[applyIndex];
                    finalAnswer = 'ok' in applyResult.outcome
                        ? `Deployment hot reload approved and scheduled: ${applyResult.outcome.ok}`
                        : `Deployment hot reload was not scheduled: ${applyResult.outcome.err}`;
                    console.log('deployment_activate(apply) is terminal; finishing workflow before switch');
                    break;
                }
                nextInput = { tool_results: results };
                continue;
            }
            throw `agent reply had no final answer and no tool calls: ${JSON.stringify(reply).slice(0, 500)}`;
        }
    } finally {
        closeInjection(injection);
        closeNativeJoinSets(state);
    }
    if (finalAnswer === null) throw `exceeded MAX_TURNS=${MAX_TURNS} without a final answer`;
    return finalAnswer;
}

function prepareInjection(injection) {
    let current = injection || openInjection();
    const text = current.joinSet.joinNextTry();
    if (text === undefined) return { injection: current, operatorMessages: [] };
    if (typeof text !== 'string' || !text.trim()) throw 'injection text must be a non-empty string';
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
function closeNativeJoinSets(state) {
    for (const [id, entry] of Object.entries(state.joinSets || {})) {
        try { entry.joinSet.close(); }
        catch (error) { console.log(`join set ${id} close failed: ${String(error)}`); }
    }
    state.joinSets = {};
}
function isBlockingHumanTool(call) {
    return call?.name === 'input.ask_user' || isHotApplyPush(call);
}
function isHotApplyPush(call) {
    if (call?.name !== 'obelisk.deployment_activate') return false;
    try {
        const args = call.arguments_json ? JSON.parse(call.arguments_json) : {};
        return args && args.mode === 'apply';
    } catch (_) { return false; }
}

function sendAndDrain(socketPath, input, operatorMessages) {
    let pending = input;
    let pendingOperatorMessages = operatorMessages;
    let corrections = 0;
    while (true) {
        session.send(socketPath, pending, pendingOperatorMessages);
        pendingOperatorMessages = [];
        try { return drainTurn(socketPath); }
        catch (error) {
            const limit = rateLimited(error);
            if (limit) {
                const seconds = limit.retry_after_seconds > 0 ? limit.retry_after_seconds : 1;
                console.log(`session limit reached (${limit.message}); sleeping ${seconds}s until reset`);
                obelisk.sleep({ seconds });
                console.log('rate-limit sleep elapsed; retrying turn');
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
function correctionPrompt(detail) {
    return [
        'Your previous reply looked like it requested tools but the JSON could not be parsed.',
        `Parse error: ${detail}`,
        'To call tools, emit a valid JSON object with tool_calls, each containing name and args.',
        'If you are not calling tools, reply with an error envelope or a final answer.',
    ].join(' ');
}
function drainTurn(socketPath) {
    const outcome = session.recv(socketPath, RECV_TIMEOUT_MS);
    if (outcome && typeof outcome === 'object' && outcome.reply) {
        const r = outcome.reply;
        return (r && typeof r === 'object' && 'reply' in r) ? r.reply : r;
    }
    throw `unexpected recv outcome: ${JSON.stringify(outcome)}`;
}
function errPayload(error) {
    const raw = (error && typeof error === 'object' && typeof error.message === 'string')
        ? error.message
        : (typeof error === 'string' ? error : null);
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) { return null; }
}
function rateLimited(error) {
    const p = errPayload(error);
    return p && p.permanent_rate_limited && typeof p.permanent_rate_limited === 'object'
        ? p.permanent_rate_limited
        : null;
}
function malformedReply(error) {
    const p = errPayload(error);
    return p && typeof p.permanent_malformed_reply === 'string' ? p.permanent_malformed_reply : null;
}

function dispatch(call, state) {
    const name = (call && typeof call.name === 'string') ? call.name : '?';
    let args;
    try { args = call && call.arguments_json ? JSON.parse(call.arguments_json) : {}; }
    catch (e) { return err(name, `invalid arguments_json: ${String(e)}`); }
    if (typeof args !== 'object' || args === null) args = {};
    try {
        switch (name) {
            case 'obelisk.list_functions':
                return ok(name, webapi.listFunctions(String(args.ffqn_prefix || ''), (args.length | 0) || 100));
            case 'obelisk.get_function_wit':
                return ok(name, webapi.getFunctionWit(requireString(args.ffqn, 'ffqn')));
            case 'obelisk.list_executions':
                return ok(name, webapi.listExecutions(
                    String(args.ffqn_prefix || ''), String(args.execution_id_prefix || ''), Boolean(args.show_derived),
                    Boolean(args.hide_finished), String(args.component_digest || ''), String(args.deployment_id || ''),
                    String(args.cursor || ''), paginationDirection(args.direction), Boolean(args.including_cursor), (args.length | 0) || 20));
            case 'obelisk.get_execution':
                return ok(name, webapi.getExecution(requireString(args.execution_id, 'execution_id')));
            case 'obelisk.get_logs':
                return ok(name, webapi.getLogs(
                    requireString(args.execution_id, 'execution_id'), args.show_derived === undefined ? true : Boolean(args.show_derived),
                    args.show_logs === undefined ? true : Boolean(args.show_logs), args.show_streams === undefined ? true : Boolean(args.show_streams),
                    arrayArgOr(args.levels, []), arrayArgOr(args.stream_types, []), String(args.cursor || ''),
                    paginationDirection(args.direction), Boolean(args.including_cursor), (args.length | 0) || 200));
            case 'obelisk.call':
                return nativeCallTool(name, args);
            case 'obelisk.submit':
                return nativeSubmitTool(name, args, state);
            case 'obelisk.join_set_create':
                return nativeJoinSetCreateTool(name, args, state);
            case 'obelisk.join_set_submit':
                return nativeJoinSetSubmitTool(name, args, state);
            case 'obelisk.join_set_delay':
                return nativeJoinSetDelayTool(name, args, state);
            case 'obelisk.join_set_join_next':
                return nativeJoinSetJoinNextTool(name, args, state, true);
            case 'obelisk.join_set_join_next_try':
                return nativeJoinSetJoinNextTool(name, args, state, false);
            case 'obelisk.join_set_close':
                return nativeJoinSetCloseTool(name, args, state);
            case 'obelisk.get_result':
                return ok(name, webapi.getResultJson(requireString(args.execution_id, 'execution_id')));
            case 'obelisk.list_deployments':
                return ok(name, webapi.listDeployments(String(args.cursor_from || ''), Boolean(args.including_cursor), (args.length | 0) || 20));
            case 'obelisk.get_deployment':
                return ok(name, webapi.getDeployment(requireString(args.deployment_id, 'deployment_id'), optionalString(args.component_type), optionalU32(args.offset), optionalU32(args.length), optionalU32(args.max_bytes)));
            case 'obelisk.get_component_source':
                return ok(name, webapi.getComponentSource(requireString(args.deployment_id, 'deployment_id'), requireString(args.component, 'component'), args.offset | 0, args.length | 0));
            case 'obelisk.current_deployment_id':
                return ok(name, webapi.currentDeploymentId());
            case 'obelisk.deployment_checkout':
                return deploymentCheckout(name, args, state);
            case 'obelisk.deployment_list_components':
                return deploymentListComponents(name, state);
            case 'obelisk.deployment_read_component':
                return deploymentReadComponent(name, args, state);
            case 'obelisk.deployment_put_component':
                return deploymentPutComponent(name, args, state);
            case 'obelisk.deployment_remove_component':
                return deploymentRemoveComponent(name, args, state);
            case 'obelisk.deployment_submit':
                return deploymentSubmit(name, args, state);
            case 'obelisk.deployment_activate':
                return deploymentActivate(name, args, state);
            case 'input.ask_user':
                return ok(name, JSON.stringify({ answer: askUser.askUser(requireString(args.question, 'question')) }));
            default:
                return err(name, `unknown tool: ${name}`);
        }
    } catch (e) { return err(name, String(e)); }
}

function nativeCallTool(name, args) {
    rejectUnknownArgs(args, ['ffqn', 'params_json', 'params'], 'obelisk.call');
    const ffqn = requireString(args.ffqn, 'ffqn');
    let params;
    try { params = parseParamsJson(args); }
    catch (e) { return err(name, nativeErrorWithWit(ffqn, e)); }
    try {
        const result = obelisk.call(ffqn, params);
        return ok(name, JSON.stringify({ ffqn, result: normalizeValue(result) }));
    } catch (e) { return err(name, nativeErrorWithWit(ffqn, e)); }
}
function nativeSubmitTool(name, args, state) {
    rejectUnknownArgs(args, ['ffqn', 'params_json', 'params'], 'obelisk.submit');
    const id = createNativeJoinSet(state);
    const submitted = submitIntoJoinSet(id, args, state);
    if ('err' in submitted) return err(name, submitted.err);
    return ok(name, JSON.stringify({ join_set_id: id, execution_id: submitted.executionId }));
}
function nativeJoinSetCreateTool(name, args, state) {
    rejectUnknownArgs(args, [], 'obelisk.join_set_create');
    const id = createNativeJoinSet(state);
    return ok(name, JSON.stringify({ join_set_id: id }));
}
function nativeJoinSetSubmitTool(name, args, state) {
    rejectUnknownArgs(args, ['join_set_id', 'ffqn', 'params_json', 'params'], 'obelisk.join_set_submit');
    const joinSetId = requireString(args.join_set_id, 'join_set_id');
    requireJoinSet(state, joinSetId);
    const submitted = submitIntoJoinSet(joinSetId, args, state);
    if ('err' in submitted) return err(name, submitted.err);
    return ok(name, JSON.stringify({ join_set_id: joinSetId, execution_id: submitted.executionId }));
}
function nativeJoinSetDelayTool(name, args, state) {
    rejectUnknownArgs(args, ['join_set_id', 'duration'], 'obelisk.join_set_delay');
    const joinSetId = requireString(args.join_set_id, 'join_set_id');
    const entry = requireJoinSet(state, joinSetId);
    const duration = requireObject(args.duration, 'duration');
    try {
        const delayId = entry.joinSet.submitDelay(duration);
        return ok(name, JSON.stringify({ join_set_id: joinSetId, delay_id: delayId || null }));
    } catch (e) { return err(name, String(e)); }
}
function nativeJoinSetJoinNextTool(name, args, state, wait) {
    rejectUnknownArgs(args, ['join_set_id'], wait ? 'obelisk.join_set_join_next' : 'obelisk.join_set_join_next_try');
    const joinSetId = requireString(args.join_set_id, 'join_set_id');
    const entry = requireJoinSet(state, joinSetId);
    try {
        const value = wait ? entry.joinSet.joinNext() : entry.joinSet.joinNextTry();
        if (value === undefined) return ok(name, JSON.stringify({ join_set_id: joinSetId, ready: false }));
        return ok(name, JSON.stringify({ join_set_id: joinSetId, ready: true, child_id: entry.joinSet.lastId || null, result: normalizeValue(value) }));
    } catch (e) { return err(name, String(e)); }
}
function nativeJoinSetCloseTool(name, args, state) {
    rejectUnknownArgs(args, ['join_set_id'], 'obelisk.join_set_close');
    const joinSetId = requireString(args.join_set_id, 'join_set_id');
    const entry = requireJoinSet(state, joinSetId);
    entry.joinSet.close();
    delete state.joinSets[joinSetId];
    return ok(name, JSON.stringify({ join_set_id: joinSetId, closed: true }));
}
function createNativeJoinSet(state) {
    const id = `J_${state.nextJoinSet++}`;
    state.joinSets[id] = { joinSet: obelisk.createJoinSet() };
    return id;
}
function requireJoinSet(state, id) {
    const entry = state.joinSets[id];
    if (!entry) throw `unknown join_set_id ${id}; create one with obelisk.join_set_create`;
    return entry;
}
function submitIntoJoinSet(joinSetId, args, state) {
    const ffqn = requireString(args.ffqn, 'ffqn');
    let params;
    try { params = parseParamsJson(args); }
    catch (e) { return { err: nativeErrorWithWit(ffqn, e) }; }
    try {
        const executionId = state.joinSets[joinSetId].joinSet.submit(ffqn, params);
        return { executionId };
    } catch (e) { return { err: nativeErrorWithWit(ffqn, e) }; }
}
function parseParamsJson(args) {
    if (Array.isArray(args.params)) return args.params;
    if (typeof args.params_json !== 'string') throw 'params_json is required';
    let params;
    try { params = JSON.parse(args.params_json || '[]'); }
    catch (e) { throw `params_json must be valid JSON: ${e.message}`; }
    if (!Array.isArray(params)) throw 'params_json must be a JSON array of positional parameters';
    return params;
}
function nativeErrorWithWit(ffqn, error) {
    const message = String(error);
    try { return `${message}\n\nWIT for ${ffqn}:\n${webapi.getFunctionWit(ffqn)}`; }
    catch (e) { return `${message}\n\nCould not fetch WIT for ${ffqn}: ${String(e)}`; }
}
function normalizeValue(value) {
    return value === undefined ? null : value;
}

function requireDraft(state) {
    if (!state || !state.checkedOut) throw 'no deployment checked out; call deployment_checkout first';
}
function componentKey(section, id) { return `${section}:${id}`; }
function splitComponents(toml) {
    const lines = toml.split('\n');
    const blocks = [];
    let current = null;
    let buffer = [];
    const isTopHeader = (line) => {
        const t = line.trim();
        return t.startsWith('[[') && t.endsWith(']]') && !t.slice(2, -2).includes('.');
    };
    const isCommentOrBlank = (line) => {
        const t = line.trim();
        return t === '' || t.startsWith('#');
    };
    for (const line of lines) {
        if (isTopHeader(line)) {
            if (current) blocks.push(current);
            current = [];
            for (const b of buffer) current.push(b);
            buffer = [];
            current.push(line);
        } else if (current === null) buffer.push(line);
        else if (isCommentOrBlank(line)) buffer.push(line);
        else {
            for (const b of buffer) current.push(b);
            buffer = [];
            current.push(line);
        }
    }
    let preamble = '';
    if (current) {
        for (const b of buffer) current.push(b);
        blocks.push(current);
    } else preamble = buffer.join('\n');
    return { preamble, blocks: blocks.map(blockFromLines) };
}
function blockFromLines(lines) {
    const text = lines.join('\n');
    let section = null;
    const meta = { ffqn: null, name: null, location: null, digest: null };
    let seenHeader = false;
    for (const line of lines) {
        const t = line.trim();
        if (t.startsWith('[')) {
            if (!seenHeader && t.startsWith('[[')) {
                section = t.slice(2, t.indexOf(']'));
                seenHeader = true;
                continue;
            }
            break;
        }
        if (!seenHeader) continue;
        for (const key of ['ffqn', 'name', 'location', 'content_digest']) {
            const value = keyStringValue(line, key);
            if (value !== null) meta[key === 'content_digest' ? 'digest' : key] = value;
        }
    }
    const id = meta.ffqn || meta.name || '?';
    return { section: section || '?', id, location: meta.location, digest: meta.digest, hasScript: Boolean(meta.location) && isOwnedPath(meta.location), text };
}
function isOwnedPath(location) { return typeof location === 'string' && !location.startsWith('oci://'); }
function keyStringValue(line, key) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(key)) return null;
    const rest = trimmed.slice(key.length).trim();
    if (!rest.startsWith('=')) return null;
    const value = rest.slice(1).trim();
    if (value.length < 2 || value.charCodeAt(0) !== 34 || value.charCodeAt(value.length - 1) !== 34) return null;
    return value.slice(1, -1);
}
function assembleToml(state) {
    const parts = state.blocks.map((b) => b.text);
    if (state.preamble) parts.unshift(state.preamble);
    return parts.join('\n');
}
function componentSummary(state) {
    return state.blocks.map((b) => ({ section: b.section, id: b.id, location: b.location || null, has_script: b.hasScript }));
}
function resetDraft(state, preamble, blocks, baseId, activeId) {
    state.preamble = preamble;
    state.blocks = blocks;
    state.baseDeploymentId = baseId;
    state.activeDeploymentId = activeId;
    state.editedFiles = {};
    state.dirty = [];
}
function deploymentCheckout(name, args, state) {
    rejectUnknownArgs(args, ['deployment_id', 'from_scratch'], 'deployment_checkout');
    if (args.from_scratch) {
        resetDraft(state, '', [], null, state.activeDeploymentId);
        state.checkedOut = true;
        return ok(name, JSON.stringify({ base_deployment_id: null, active_deployment_id: state.activeDeploymentId, components: [], note: 'Empty working copy. Add components with deployment_put_component, then deployment_submit.' }));
    }
    const json = webapi.deploymentCheckout(optionalString(args.deployment_id));
    const res = JSON.parse(json);
    if (typeof res.deployment_toml !== 'string') throw 'checkout returned no deployment_toml';
    const split = splitComponents(res.deployment_toml);
    resetDraft(state, split.preamble, split.blocks, res.deployment_id, res.active_deployment_id);
    state.checkedOut = true;
    return ok(name, JSON.stringify({ base_deployment_id: state.baseDeploymentId, active_deployment_id: state.activeDeploymentId, components: componentSummary(state), note: 'Read a component with deployment_read_component. Change exactly one component, then deployment_submit.' }));
}
function deploymentListComponents(name, state) {
    requireDraft(state);
    return ok(name, JSON.stringify({ base_deployment_id: state.baseDeploymentId, components: componentSummary(state), pending_changes: state.dirty }));
}
function findBlock(state, section, id) { return state.blocks.findIndex((b) => b.section === section && b.id === id); }
function deploymentReadComponent(name, args, state) {
    requireDraft(state);
    rejectUnknownArgs(args, ['section', 'id'], 'deployment_read_component');
    const section = requireString(args.section, 'section');
    const id = requireString(args.id, 'id');
    const index = findBlock(state, section, id);
    if (index === -1) throw `no ${section} component with id ${id}; list with deployment_list_components`;
    const block = state.blocks[index];
    const result = { section, id, location: block.location || null, toml: block.text };
    if (block.hasScript) {
        result.script = readScript(state, block);
        result.content_digest = block.digest || null;
    }
    return ok(name, JSON.stringify(result));
}
function readScript(state, block) {
    if (block.location in state.editedFiles) return state.editedFiles[block.location];
    if (!block.digest) return '';
    return webapi.deploymentReadBlob(block.digest);
}
function deploymentPutComponent(name, args, state) {
    requireDraft(state);
    rejectUnknownArgs(args, ['section', 'id', 'toml', 'script'], 'deployment_put_component');
    const section = requireString(args.section, 'section');
    const id = requireString(args.id, 'id');
    const tomlText = requireString(args.toml, 'toml');
    const parsed = splitComponents(tomlText);
    if (parsed.blocks.length !== 1 || parsed.preamble.trim()) throw 'toml must contain exactly one [[section]] component block';
    const block = parsed.blocks[0];
    if (block.section !== section) throw `toml section [[${block.section}]] does not match section ${section}`;
    if (block.id !== id) throw `toml component id ${block.id} does not match id ${id}`;
    const hasScript = typeof args.script === 'string';
    if (hasScript) {
        if (!block.location) throw 'toml must set location to attach a script';
        if (!isOwnedPath(block.location)) throw `location ${block.location} is not a deployment-owned path`;
    }
    const key = componentKey(section, id);
    guardSingleChange(state, key);
    const index = findBlock(state, section, id);
    const action = index === -1 ? 'added' : 'replaced';
    if (index === -1) state.blocks.push(block);
    else state.blocks[index] = block;
    if (hasScript) state.editedFiles[block.location] = args.script;
    markDirty(state, key);
    return ok(name, JSON.stringify({ action, section, id, location: block.location || null, script_attached: hasScript, pending_changes: state.dirty }));
}
function deploymentRemoveComponent(name, args, state) {
    requireDraft(state);
    rejectUnknownArgs(args, ['section', 'id'], 'deployment_remove_component');
    const section = requireString(args.section, 'section');
    const id = requireString(args.id, 'id');
    const index = findBlock(state, section, id);
    if (index === -1) return ok(name, JSON.stringify({ action: 'already_absent', section, id }));
    const key = componentKey(section, id);
    guardSingleChange(state, key);
    const [removed] = state.blocks.splice(index, 1);
    if (removed.location) delete state.editedFiles[removed.location];
    markDirty(state, key);
    return ok(name, JSON.stringify({ action: 'removed', section, id, pending_changes: state.dirty }));
}
function guardSingleChange(state, key) {
    if (state.dirty.length > 0 && !state.dirty.includes(key)) throw `only one component may change per deployment; submit the pending change to ${state.dirty[0]} first, then edit ${key}`;
}
function markDirty(state, key) { if (!state.dirty.includes(key)) state.dirty.push(key); }
function deploymentSubmit(name, args, state) {
    requireDraft(state);
    rejectUnknownArgs(args, ['description', 'allow_missing_runtime_config', 'deployment_id'], 'deployment_submit');
    const description = requireString(args.description, 'description');
    const allowMissing = Boolean(args.allow_missing_runtime_config);
    const requestedId = optionalString(args.deployment_id) || '';
    const toml = assembleToml(state);
    const locations = new Set(state.blocks.map((b) => b.location).filter(Boolean));
    const editedFiles = Object.entries(state.editedFiles).filter(([path]) => locations.has(path)).map(([path, content]) => ({ path, content }));
    const resJson = webapi.deploymentSubmit(toml, JSON.stringify(editedFiles), description, allowMissing, requestedId);
    const res = JSON.parse(resJson);
    const deploymentId = res.deployment_id;
    if (typeof res.deployment_toml === 'string') {
        const split = splitComponents(res.deployment_toml);
        resetDraft(state, split.preamble, split.blocks, deploymentId, state.activeDeploymentId);
    } else resetDraft(state, state.preamble, state.blocks, deploymentId, state.activeDeploymentId);
    return ok(name, JSON.stringify({ deployment_id: deploymentId, status: 'submitted (inactive)' }));
}
function deploymentActivate(name, args, state) {
    rejectUnknownArgs(args, ['deployment_id', 'mode', 'allow_missing_runtime_config', 'summary'], 'deployment_activate');
    const mode = requireString(args.mode, 'mode');
    if (!['enqueue', 'apply'].includes(mode)) throw 'mode must be enqueue or apply';
    const deploymentId = optionalString(args.deployment_id) || state.baseDeploymentId;
    if (!deploymentId) throw 'deployment_id is required (or submit a deployment first)';
    const allowMissing = Boolean(args.allow_missing_runtime_config);
    if (mode === 'enqueue') {
        const sw = webapi.deploymentSwitch(deploymentId, allowMissing);
        return ok(name, JSON.stringify({ deployment_id: deploymentId, mode, status: 'enqueued for next restart', switch: sw }));
    }
    const summary = optionalString(args.summary) || `hot redeploy ${deploymentId}`;
    deploy.confirmApply(deploymentId, summary);
    const applied = webapi.applyDeployment(deploymentId);
    return ok(name, JSON.stringify({ deployment_id: deploymentId, mode, status: 'hot reload scheduled', apply: applied }));
}

function rejectUnknownArgs(args, allowed, tool) {
    if (!args || typeof args !== 'object') return;
    const extra = Object.keys(args).filter((k) => !allowed.includes(k));
    if (extra.length) throw `${tool}: unknown argument(s) ${extra.join(', ')}; allowed: ${allowed.join(', ')}`;
}
function arrayArgOr(value, fallback) { return Array.isArray(value) ? value : (Array.isArray(fallback) ? fallback : []); }
function paginationDirection(value) {
    if (value === undefined || value === null || value === '') return '';
    if (value !== 'older' && value !== 'newer') throw 'direction must be older or newer';
    return value;
}
function ok(name, jsonString) {
    const s = typeof jsonString === 'string' ? jsonString : JSON.stringify(jsonString);
    const encoded = JSON.stringify(s).length;
    if (encoded > MAX_TOOL_RESULT_BYTES) return err(name, `result too large (~${encoded} encoded bytes); narrow the request with pagination or a more specific selector`);
    return { name, outcome: { ok: s } };
}
function err(name, message) { return { name, outcome: { err: message } }; }
function requireString(value, field) {
    if (typeof value !== 'string' || !value) throw `${field} is required`;
    return value;
}
function requireObject(value, field) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw `${field} must be an object`;
    return value;
}
function optionalString(value) { return typeof value === 'string' && value ? value : null; }
function optionalU32(value) { return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null; }
