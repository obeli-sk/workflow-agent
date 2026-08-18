// Unit tests for the transcript renderer embedded in the served SPA. The
// rendering functions live as browser JS inside the SHELL_HTML template literal
// (not module exports), so the test extracts the served <script>, evaluates it
// in a node:vm sandbox with a minimal DOM stub, and drives the pure
// transcript -> turns/steps functions against a synthetic session projection.

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { htmlShell } from "./shell.js";

function stubElement() {
    return {
        innerHTML: "", value: "", disabled: false, placeholder: "", textContent: "",
        hidden: false, style: {}, dataset: {},
        addEventListener() {}, removeAttribute() {}, setAttribute() {},
        setSelectionRange() {}, focus() {}, replaceWith() {},
        querySelector() { return null; }, querySelectorAll() { return []; },
        classList: { add() {}, remove() {} },
    };
}

function sandbox() {
    const document = {
        getElementById() { return stubElement(); },
        querySelectorAll() { return []; },
        createElement() { return stubElement(); },
        addEventListener() {},
        hidden: false,
    };
    const window = {
        location: { search: "", href: "http://localhost/" },
        history: { replaceState() {} },
    };
    return {
        document, window,
        setTimeout: () => 0, clearTimeout: () => {}, requestAnimationFrame: () => {},
        fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
        alert: () => {},
        console, process: { env: {} },
        URL, URLSearchParams, TextDecoder,
        atob: (s) => Buffer.from(s, "base64").toString("binary"),
    };
}

// Load the served browser script, evaluate it, and expose the transcript
// renderer's internals (the `state` lexical and the top-level functions).
async function loadRenderer() {
    const html = await htmlShell().text();
    const marker = "<script>\nconst OBELISK_UI_URL";
    const start = html.indexOf(marker);
    assert.notEqual(start, -1, "served shell must contain the inline SPA script");
    const open = html.indexOf(">", start) + 1;
    const end = html.indexOf("</script>", open);
    const code = html.slice(open, end)
        + "\n;globalThis.__render = { state, buildCachedTurns, groupTurns, renderTurnGroup };";
    const ctx = vm.createContext(sandbox());
    vm.runInContext(code, ctx);
    return ctx.__render;
}

function toolStep(ti, at, durationMs, calls, narration = "", complete = false) {
    return {
        reply: { tool_calls: calls },
        narration,
        created_at: at,
        turn_index: ti,
        duration_milliseconds: durationMs,
        turn_complete: complete,
    };
}

function bashCall(id) {
    return { id, name: "bash", args: { script: "echo hi" } };
}

function bashResult(id, ti, durationMs) {
    return { id, turn_index: ti, duration_milliseconds: durationMs, ok: { output: [], exit_code: 0 } };
}

// A two-turn session mirroring the run in the task description: turn 0 exhausts
// the step budget (10 tool steps then a turn-limit error), turn 1 finishes with
// a final response after two tool steps.
function twoTurnTranscript() {
    const created = "2026-08-18T10:17:40.548Z";
    const times0 = [
        "2026-08-18T10:17:42.919Z", "2026-08-18T10:17:45.378Z", "2026-08-18T10:17:47.117Z",
        "2026-08-18T10:17:49.163Z", "2026-08-18T10:17:53.771Z", "2026-08-18T10:17:57.051Z",
        "2026-08-18T10:17:58.869Z", "2026-08-18T10:18:00.632Z", "2026-08-18T10:18:02.273Z",
        "2026-08-18T10:18:04.116Z",
    ];
    const durations0 = [1921, 2366, 1631, 1941, 4533, 3207, 1688, 1691, 1547, 1756];
    const replies = [];
    const sentResults = [];
    for (let i = 0; i < 10; i += 1) {
        const id = "bash_" + i;
        replies.push(toolStep(0, times0[i], durations0[i], [bashCall(id)], i === 0 ? "Planning the change." : ""));
        sentResults.push(bashResult(id, 0, [1, 22, 40, 0, 2, 1, 0, 3, 0, 0][i]));
    }
    replies.push({
        reply: { error: "exceeded MAX_STEPS=10 without yielding an assistant response" },
        narration: "",
        created_at: "2026-08-18T10:18:04.181Z",
        turn_index: 0,
        turn_complete: true,
    });

    const goAt = "2026-08-18T10:18:27.493Z";
    replies.push(toolStep(1, "2026-08-18T10:18:32.785Z", 5219, [bashCall("bash_10")], "Let's continue."));
    replies.push(toolStep(1, "2026-08-18T10:18:34.833Z", 1602, [bashCall("bash_11")]));
    replies.push({
        reply: { response: "Done. The background is now blue." },
        narration: "",
        created_at: "2026-08-18T10:18:37.503Z",
        turn_index: 1,
        duration_milliseconds: 2204,
        turn_complete: true,
    });
    sentResults.push(bashResult("bash_10", 1, 379));
    sentResults.push(bashResult("bash_11", 1, 325));

    return {
        transcript: {
            replies,
            user_messages: [{ id: "go-1", text: "go", created_at: goAt, turn_index: 1 }],
            shell_events: [],
            turn_starts: [{ id: "go-1", kind: "prompt", created_at: goAt }],
            sent_results: sentResults,
        },
        created,
        prompt: "change background of the webhook's HTML page, then redeploy",
    };
}

function render(renderer, fixture) {
    renderer.state.transcript = fixture.transcript;
    const turns = renderer.buildCachedTurns(fixture.created, fixture.prompt);
    const groups = renderer.groupTurns(turns);
    return groups.map((g, i) => renderer.renderTurnGroup(g, i));
}

test("groups the flat timeline into turns keyed by turn_index", async () => {
    const renderer = await loadRenderer();
    const fixture = twoTurnTranscript();
    renderer.state.transcript = fixture.transcript;
    const turns = renderer.buildCachedTurns(fixture.created, fixture.prompt);
    const groups = renderer.groupTurns(turns);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].turn_index, 0);
    assert.equal(groups[1].turn_index, 1);
});

test("turn header summarizes step count, tool-call count and total latency", async () => {
    const renderer = await loadRenderer();
    const [turn0, turn1] = render(renderer, twoTurnTranscript());
    // Turn 0: 10 tool steps + a terminal error (the error is not a step).
    assert.match(turn0, /Turn 1 · 10 steps · 10 tool calls/);
    assert.match(turn0, /total 23\.6s/);
    // Turn 1: two tool steps + a final-response step; the error/response are the
    // terminal, so total spans the "go" prompt through the response.
    assert.match(turn1, /Turn 2 · 3 steps · 2 tool calls/);
    assert.match(turn1, /total 10\.0s/);
});

test("numbers steps within a turn and keeps each step's LLM latency", async () => {
    const renderer = await loadRenderer();
    const [turn0, turn1] = render(renderer, twoTurnTranscript());
    assert.match(turn0, /Step 1<\/span><span class="latency"[^>]*>LLM 1\.92s/);
    assert.match(turn0, /Step 10<\/span><span class="latency"[^>]*>LLM 1\.76s/);
    assert.match(turn1, /Step 1<\/span><span class="latency"[^>]*>LLM 5\.22s/);
    assert.match(turn1, /Step 2<\/span><span class="latency"[^>]*>LLM 1\.60s/);
    assert.match(turn1, /Step 3<\/span><span class="latency"[^>]*>LLM 2\.20s/);
});

test("a silent step (no narration) still shows its LLM latency", async () => {
    const renderer = await loadRenderer();
    const [turn0] = render(renderer, twoTurnTranscript());
    // Step 2 emitted no narration; its latency (2366ms) must remain visible.
    assert.match(turn0, /Step 2<\/span><span class="latency"[^>]*>LLM 2\.37s/);
});

test("renders the turn-limit error as a terminal event, not a step", async () => {
    const renderer = await loadRenderer();
    const [turn0] = render(renderer, twoTurnTranscript());
    assert.match(turn0, /exceeded MAX_STEPS=10 without yielding an assistant response/);
    // Still only 10 steps despite the trailing error.
    assert.match(turn0, /10 steps/);
});

test("shows the user message and final response inside the turn", async () => {
    const renderer = await loadRenderer();
    const [, turn1] = render(renderer, twoTurnTranscript());
    assert.match(turn1, /<div class="bubble user">.*go/s);
    assert.match(turn1, /final response/);
    // The response renders as markdown (URL-encoded into the hydration source).
    assert.match(turn1, /data-source="Done\./);
});

test("keeps individual tool-call latencies visible", async () => {
    const renderer = await loadRenderer();
    const [turn0, turn1] = render(renderer, twoTurnTranscript());
    assert.match(turn0, /in 1ms/);
    assert.match(turn1, /in 379ms/);
});

test("renders multiple tool calls emitted by a single step", async () => {
    const renderer = await loadRenderer();
    const fixture = {
        transcript: {
            replies: [toolStep(0, "2026-08-18T10:00:01.000Z", 1200,
                [bashCall("bash_0"), bashCall("bash_1")], "Two at once.")],
            user_messages: [],
            shell_events: [],
            turn_starts: [],
            sent_results: [bashResult("bash_0", 0, 5), bashResult("bash_1", 0, 9)],
        },
        created: "2026-08-18T10:00:00.000Z",
        prompt: "do two things",
    };
    const [turn0] = render(renderer, fixture);
    assert.match(turn0, /Turn 1 · 1 step · 2 tool calls/);
    // Both calls render under the single step.
    assert.equal((turn0.match(/<details class="call"/g) || []).length, 2);
    assert.match(turn0, /in 5ms/);
    assert.match(turn0, /in 9ms/);
});
