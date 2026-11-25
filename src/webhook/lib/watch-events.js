// Pure parts of the watch stream: which runs to follow and how upstream
// Obelisk follow events map to the SPA's change signals.

const MAX_WATCHED_IDS = 200;
const HEARTBEAT = ": heartbeat\n\n";

export function watchIds(run, ids) {
    return [...new Set([run, ...ids].filter(Boolean))].slice(0, MAX_WATCHED_IDS);
}

// Returns the downstream SSE text for one upstream block.
export function translate(kind, block) {
    if (kind === "statuses" && block.event === "statuses") {
        let items = [];
        try { items = JSON.parse(block.data); } catch (_) { return HEARTBEAT; }
        const statuses = (Array.isArray(items) ? items : []).map((item) => ({
            id: item.execution_id,
            status: item.pending_state?.status || "unknown",
            max_version: item.max_version,
        }));
        return `event: statuses\ndata: ${JSON.stringify(statuses)}\n\n`;
    }
    if (kind === "run" && block.event === "responses") {
        let page = {};
        try { page = JSON.parse(block.data); } catch (_) { return HEARTBEAT; }
        if ((page.responses || []).length === 0) return HEARTBEAT;
        return "event: run\ndata: {}\n\n";
    }
    return HEARTBEAT;
}
