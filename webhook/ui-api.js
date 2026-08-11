// Web UI for the obelisk-agent.
//
// Server side: small JSON API plus one HTML shell page that boots the SPA.
// Routes:
//   GET  /                          static shell (HTML + inline JS)
//   GET  /api/runs                  list runs (sidebar)
//   GET  /api/runs/:id              one run, normalised into turns
//   GET  /api/logs/:id              logs from the run and all derived executions
//   POST /api/submit                body: {prompt} -> {execution_id}
//   POST /api/input/:runId          body: {offer_id, input} -> accepted event
//   POST /api/answer/:childId       body: {answer} -> {ok: true}
//
// The SPA polls the run list every 10s and active open runs every 3s, switching
// to a short poll while a shell command is outstanding. Terminal runs stop
// polling. Layout is two-pane: sidebar = "new conversation" button + run list;
// right pane = chat-style transcript with a persistent composer pinned at the
// bottom and a specific agent/shell activity indicator directly above it.
//
// This entry is the HTTP router only; the implementation lives in ./lib/* (server
// logic) and ./ui/shell.js (the served single-page app).

import { jsonError, jsonResponse, nonNegativeInteger, parseQuery } from "./lib/http.js";
import { loadModels } from "./lib/models.js";
import { detailRun, listRuns, loadExecutionTreeLogs } from "./lib/runs.js";
import {
    answerStub,
    cancelRun,
    createSession,
    pauseExecution,
    submitSessionInput,
    submit,
} from "./lib/mutations.js";
import { htmlShell } from "./ui/shell.js";

export default async function handle(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
        const query = parseQuery(request.url);
        if (method === "GET" && path === "/") return htmlShell();
        if (method === "GET" && path === "/api/models") return jsonResponse(loadModels());
        if (method === "GET" && path === "/api/runs") return jsonResponse(await listRuns());
        if (method === "GET" && path.startsWith("/api/runs/")) {
            const id = decodeURIComponent(path.substring("/api/runs/".length));
            if (!id) return jsonError(400, "missing run id");
            return jsonResponse(await detailRun(id, {
                workflowId: query.workflow_id || "",
                responseCursor: nonNegativeInteger(query.response_cursor),
            }));
        }
        if (method === "GET" && path.startsWith("/api/logs/")) {
            const id = decodeURIComponent(path.substring("/api/logs/".length));
            if (!id) return jsonError(400, "missing run id");
            return jsonResponse(await loadExecutionTreeLogs(id, query.cursor || ""));
        }
        if (method === "POST" && path === "/api/submit") return await submit(request);
        if (method === "POST" && path === "/api/sessions") return await createSession(request);
        if (method === "POST" && path.startsWith("/api/pause/")) {
            return await pauseExecution(decodeURIComponent(path.substring("/api/pause/".length)), false);
        }
        if (method === "POST" && path.startsWith("/api/unpause/")) {
            return await pauseExecution(decodeURIComponent(path.substring("/api/unpause/".length)), true);
        }
        if (method === "POST" && path.startsWith("/api/cancel/")) {
            return await cancelRun(decodeURIComponent(path.substring("/api/cancel/".length)));
        }
        if (method === "POST" && path.startsWith("/api/input/")) {
            return await submitSessionInput(request, decodeURIComponent(path.substring("/api/input/".length)));
        }
        if (method === "POST" && path.startsWith("/api/answer/")) {
            const childId = decodeURIComponent(path.substring("/api/answer/".length));
            return await answerStub(request, childId);
        }
    } catch (e) {
        return jsonError(500, String(e));
    }
    return jsonError(404, "not found");
}
