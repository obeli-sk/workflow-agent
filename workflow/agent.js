import * as claude from "obelisk-agent:agent/claude";
import * as codex from "obelisk-agent:agent/codex";
import * as session from "obelisk-agent:agent/session";
import * as webapi from "obelisk-agent:tools/webapi";
import * as askUser from "obelisk-agent:tools/input";

const RECV_TIMEOUT_MS = 30000;
const MAX_RECV_PER_TURN = 60; // 60 * 30s = 30 min ceiling per agent turn
const MAX_TURNS = 30;          // hard cap on agent loop turns

// Provider-specific start activities; session.{send,recv,cleanup} are shared.
const STARTERS = { claude: claude.start, codex: codex.start };

export default function run(prompt, backend) {
    if (typeof prompt !== "string" || !prompt.trim()) {
        throw "prompt is required";
    }
    const which = (typeof backend === "string" && backend) ? backend : "claude";
    const start = STARTERS[which];
    if (!start) throw `unknown backend: ${which} (expected claude or codex)`;

    const sessionId = sanitize(obelisk.executionIdCurrent());
    const containerName = `obelisk-agent-${sessionId}`;
    const socketPath = `/tmp/obelisk-agent/${sessionId}.sock`;

    let workflowError = null;
    try {
        const startInfo = start(containerName, socketPath);
        console.log(`Started ${which} agent ${startInfo.container} from ${startInfo.image}`);

        // agent-input variant: { prompt } for the first turn, then { tool_results }.
        let nextInput = { prompt };
        let finalAnswer = null;

        for (let turn = 0; turn < MAX_TURNS; turn += 1) {
            console.log(`--- turn ${turn} ---`);
            const reply = sendAndDrain(socketPath, nextInput);

            if (typeof reply.final === "string") {
                finalAnswer = reply.final;
                console.log(`final after ${turn + 1} turns`);
                break;
            }
            if (Array.isArray(reply.tool_calls) && reply.tool_calls.length > 0) {
                console.log(`dispatching ${reply.tool_calls.length} tool call(s)`);
                const results = reply.tool_calls.map((call) => {
                    const result = dispatch(call);
                    console.log(`  ${call?.name}: ${"ok" in result.outcome ? "ok" : `err=${result.outcome.err}`}`);
                    return result;
                });
                nextInput = { tool_results: results };
                continue;
            }
            throw `agent reply had no final answer and no tool calls: ${JSON.stringify(reply).slice(0, 500)}`;
        }

        if (finalAnswer === null) {
            throw `exceeded MAX_TURNS=${MAX_TURNS} without a final answer`;
        }
        return finalAnswer;
    } catch (error) {
        workflowError = error;
        throw error;
    } finally {
        try {
            session.cleanup(containerName, socketPath);
            console.log(`Cleaned up ${containerName}`);
        } catch (error) {
            console.log(`Cleanup failed for ${containerName}: ${String(error)}`);
            if (workflowError === null) throw error;
        }
    }
}

// Send one agent-input and drain the turn into a typed agent-reply
// ({ final } | { tool_calls }). If recv reports a session/usage limit
// (permanent-rate-limited), durably sleep until the limit resets, then re-send
// the same input and try again. A cancelled sleep throws; we catch it and
// resume immediately rather than failing the run.
function sendAndDrain(socketPath, input) {
    while (true) {
        session.send(socketPath, input);
        try {
            return drainTurn(socketPath);
        } catch (error) {
            const limit = rateLimited(error);
            if (!limit) throw error;
            const seconds = limit.retry_after_seconds > 0 ? limit.retry_after_seconds : 1;
            console.log(`session limit reached (${limit.message}); sleeping ${seconds}s until reset`);
            try {
                obelisk.sleep({ seconds }, "rate-limit");
                console.log("rate-limit sleep elapsed; retrying turn");
            } catch (cancelled) {
                console.log(`rate-limit sleep cancelled (${String(cancelled)}); resuming now`);
            }
            // Loop: re-send the same input now that the limit should be lifted.
        }
    }
}

// recv returns a turn-outcome: the string "working" while the turn streams, or
// { reply: agent-reply } once it completes. Failures (rate limit, agent exit,
// malformed reply) are thrown as the agent-error variant payload.
function drainTurn(socketPath) {
    for (let attempt = 0; attempt < MAX_RECV_PER_TURN; attempt += 1) {
        const outcome = session.recv(socketPath, RECV_TIMEOUT_MS);
        if (outcome === "working") continue;
        if (outcome && typeof outcome === "object" && outcome.reply) {
            return outcome.reply;
        }
        throw `unexpected recv outcome: ${JSON.stringify(outcome)}`;
    }
    throw `agent did not finish within ${MAX_RECV_PER_TURN} recv attempts`;
}

// The recv activity throws the permanent-rate-limited variant payload as
// { permanent_rate_limited: { retry_after_seconds, message } }.
function rateLimited(error) {
    if (error && typeof error === "object" &&
        error.permanent_rate_limited && typeof error.permanent_rate_limited === "object") {
        return error.permanent_rate_limited;
    }
    return null;
}

// Dispatch one tool-call ({ name, arguments_json }) to its Obelisk activity and
// return a typed tool-result ({ name, outcome: result<string, string> }). The
// ok arm carries the activity's JSON string verbatim; server.js parses it back
// into structured data for the agent.
function dispatch(call) {
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
            case "obelisk.list_executions": {
                const len = (args.length | 0) || 20;
                return ok(name, webapi.listExecutions(String(args.ffqn_prefix || ""), len));
            }
            case "obelisk.get_execution":
                return ok(name, webapi.getExecution(requireString(args.execution_id, "execution_id")));
            case "obelisk.get_logs":
                return ok(name, webapi.getLogs(requireString(args.execution_id, "execution_id")));
            case "obelisk.submit":
                return ok(name, webapi.submitJson(
                    requireString(args.ffqn, "ffqn"),
                    JSON.stringify(Array.isArray(args.params) ? args.params : []),
                ));
            case "obelisk.get_result":
                return ok(name, webapi.getResultJson(requireString(args.execution_id, "execution_id")));
            case "obelisk.list_deployments":
                return ok(name, webapi.listDeployments());
            case "obelisk.get_deployment":
                return ok(name, webapi.getDeployment(requireString(args.deployment_id, "deployment_id")));
            case "obelisk.current_deployment_id":
                return ok(name, webapi.currentDeploymentId());
            case "obelisk.create_deployment":
                return ok(name, webapi.createDeployment(
                    requireString(args.config_json, "config_json"),
                    Boolean(args.verify),
                ));
            case "obelisk.apply_deployment":
                return ok(name, webapi.applyDeployment(requireString(args.deployment_id, "deployment_id")));
            case "input.ask_user":
                return ok(name, JSON.stringify({ answer: askUser.askUser(requireString(args.question, "question")) }));
            default:
                return err(name, `unknown tool: ${name}`);
        }
    } catch (e) {
        return err(name, String(e));
    }
}

function ok(name, jsonString) {
    return { name, outcome: { ok: typeof jsonString === "string" ? jsonString : JSON.stringify(jsonString) } };
}
function err(name, message) { return { name, outcome: { err: message } }; }

function requireString(value, field) {
    if (typeof value !== "string" || !value) throw `${field} is required`;
    return value;
}

function sanitize(value) {
    return String(value).replace(/[^A-Za-z0-9_.-]/g, "-");
}
