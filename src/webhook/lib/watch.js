// Change signal for the SPA: one SSE stream per browser tab, merged from the
// Obelisk status-batch and session-events follow streams. Events carry no
// transcript data; the SPA refetches its incremental views when told to.
//
// Downstream events:
//   statuses  [{id, status, max_version}] for watched runs that changed
//   run       the selected run has new session events
//   end       every upstream stream finished
// Upstream heartbeats are forwarded as comments, so a closed tab is noticed on
// the next write and the webhook execution ends.

import { followResponses, followStatuses } from "./obelisk-api.js";
import { pumpSse } from "./sse.js";
import { translate, watchIds } from "./watch-events.js";

const SESSION_EVENTS_JOIN_SET = "n:session-events";

export async function watchResponse({ run, cursor, ids }) {
    const statusIds = watchIds(run, ids);
    const upstreams = [];
    if (statusIds.length) upstreams.push({ kind: "statuses", resp: await followStatuses(statusIds) });
    if (run) {
        try {
            upstreams.push({ kind: "run", resp: await followResponses(run, SESSION_EVENTS_JOIN_SET, cursor) });
        } catch (_) { /* a missing run still gets its status */ }
    }
    const readers = upstreams.map((upstream) => ({ ...upstream, reader: upstream.resp.body.getReader() }));
    const encoder = new TextEncoder();
    const body = new ReadableStream({
        async start(controller) {
            let open = true;
            const send = (text) => {
                if (!open) return;
                try { controller.enqueue(encoder.encode(text)); }
                catch (_) { open = false; }
            };
            send("retry: 5000\n\n");
            await Promise.all(readers.map(({ kind, reader }) => pumpSse(reader, (block) => {
                if (block.comment !== undefined) send(": heartbeat\n\n");
                else send(translate(kind, block));
            }).catch(() => {})));
            send("event: end\ndata: {}\n\n");
            if (open) {
                try { controller.close(); } catch (_) { /* cancelled meanwhile */ }
            }
        },
        async cancel() {
            await Promise.all(readers.map(({ reader }) => reader.cancel().catch(() => {})));
        },
    });
    return new Response(body, {
        headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
        },
    });
}
