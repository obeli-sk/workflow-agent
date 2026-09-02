// Unit tests for the centralized session-state projection
// (shared/session-state.js): raw execution facts -> state enum, plus the
// marker scanner fed by both the webhook walk and the chat activity.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    SESSION_STATES,
    SESSION_STATE_LABELS,
    emptyMarkers,
    projectLatestWindow,
    projectSessionState,
    scanMarkers,
    sessionEventValue,
} from "./session-state.js";

function project(overrides = {}) {
    return projectSessionState({
        status: "blocked_by_join_set",
        resultKind: null,
        joinName: "user",
        working: false,
        markers: emptyMarkers(),
        ...overrides,
    });
}

test("finished sessions separate cancelled from real failures", () => {
    assert.equal(
        project({ status: "finished", resultKind: { err: { execution_failure: "cancelled" } } }),
        SESSION_STATES.CANCELLED,
    );
    assert.equal(
        project({ status: "finished", resultKind: { err: { execution_failure: "failed" } } }),
        SESSION_STATES.FAILED,
    );
    assert.equal(project({ status: "finished", resultKind: { ok: null } }), SESSION_STATES.FINISHED_OK);
    assert.equal(project({ status: "finished", resultKind: { Err: { x: 1 } } }), SESSION_STATES.FAILED);
});

test("working sessions think or work depending on the join set", () => {
    assert.equal(project({ working: true, joinName: "user" }), SESSION_STATES.THINKING);
    assert.equal(project({ working: true, joinName: "completion" }), SESSION_STATES.THINKING);
    assert.equal(project({ working: true, joinName: "33-chat" }), SESSION_STATES.WORKING);
});

test("ask-user offers are awaiting-answer regardless of naming", () => {
    assert.equal(project({ joinName: "ask-user" }), SESSION_STATES.AWAITING_ANSWER);
    assert.equal(project({ joinName: "12-ask-user" }), SESSION_STATES.AWAITING_ANSWER);
});

test("parked sessions distinguish final response, step limit, shell-only, queued", () => {
    const finalMarkers = { ...emptyMarkers(), lastReplyTurn: 3 };
    assert.equal(project({ markers: finalMarkers }), SESSION_STATES.FINAL_RESPONSE);

    // A step-limit error newer than the last reply wins.
    const limited = { ...emptyMarkers(), lastReplyTurn: 1, stepLimitTurn: 2 };
    assert.equal(project({ markers: limited }), SESSION_STATES.STEP_LIMIT);
    // An older step-limit error stays superseded by the newer final reply.
    const recovered = { ...emptyMarkers(), lastReplyTurn: 5, stepLimitTurn: 2 };
    assert.equal(project({ markers: recovered }), SESSION_STATES.FINAL_RESPONSE);

    const shelled = { ...emptyMarkers(), hasShellEvents: true };
    assert.equal(project({ markers: shelled }), SESSION_STATES.SHELL_ONLY);

    assert.equal(project(), SESSION_STATES.AWAITING_USER);
});

test("a later turn's terminal event supersedes an earlier final response", () => {
    // The model answered turn 1, then a composer command ran at turn 2:
    // the reply no longer is the latest word.
    const continued = { ...emptyMarkers(), lastReplyTurn: 1, lastShellTurn: 2, hasShellEvents: true };
    assert.equal(project({ markers: continued }), SESSION_STATES.SHELL_ONLY);

    // And the other order: a command first, a fresh answer after.
    const answered = { ...emptyMarkers(), lastReplyTurn: 3, lastShellTurn: 2, hasShellEvents: true };
    assert.equal(project({ markers: answered }), SESSION_STATES.FINAL_RESPONSE);

    // A step limit newer than both still wins.
    const limited = { ...emptyMarkers(), lastReplyTurn: 1, lastShellTurn: 2, stepLimitTurn: 3 };
    assert.equal(project({ markers: limited }), SESSION_STATES.STEP_LIMIT);

    // A queued (turn-incomplete) shell inside a model turn never counts.
    const queuedShellOnly = { ...emptyMarkers(), lastReplyTurn: null, hasShellEvents: true };
    assert.equal(project({ markers: queuedShellOnly }), SESSION_STATES.SHELL_ONLY);
});

test("paused, running, and unknown statuses map directly", () => {
    assert.equal(project({ status: "paused" }), SESSION_STATES.PAUSED);
    assert.equal(project({ status: "running" }), SESSION_STATES.WORKING);
    assert.equal(project({ status: "something_new" }), SESSION_STATES.UNKNOWN);
});

test("every state has a rendered label", () => {
    for (const state of Object.values(SESSION_STATES)) {
        const [label, cls] = SESSION_STATE_LABELS[state];
        assert.ok(typeof label === "string" && label.length > 0, state);
        assert.ok(typeof cls === "string", state);
    }
    assert.equal(SESSION_STATE_LABELS[SESSION_STATES.CANCELLED][0], "cancelled");
    assert.equal(SESSION_STATE_LABELS[SESSION_STATES.FINAL_RESPONSE][0], "final response");
});

test("scanMarkers reads raw session-event values", () => {
    const markers = emptyMarkers();
    scanMarkers(markers, {
        assistant_reply: {
            content_json: JSON.stringify([{ type: "text", text: "done" }]),
            turn_complete: true,
            turn_index: 4,
        },
    });
    scanMarkers(markers, {
        // A mid-turn tool-call reply never counts as a final response.
        assistant_reply: {
            content_json: JSON.stringify([{ type: "tool_use", id: "t", name: "bash", input: {} }]),
            turn_complete: true,
            turn_index: 2,
        },
    });
    scanMarkers(markers, {
        agent_error: { id: "step-limit-6", text: "exceeded MAX_STEPS=25...", turn_index: 6 },
    });
    scanMarkers(markers, { shell_output: { id: "s1", script: "ls" } });
    scanMarkers(markers, {
        // A queued shell (turn incomplete) never ends a turn.
        shell_output: { id: "s2", script: "pwd", turn_index: 5, turn_complete: false },
    });
    scanMarkers(markers, {
        shell_output: { id: "s3", script: "cat f", turn_index: 6, turn_complete: true },
    });
    scanMarkers(markers, { input_offered: { execution_id: "E_x.n:user_7", turn_index: 7 } });

    assert.deepEqual(markers, {
        lastReplyTurn: 4,
        stepLimitTurn: 6,
        lastShellTurn: 6,
        hasShellEvents: true,
    });
});

test("scanMarkers accepts the pre-id MAX_STEPS text fallback", () => {
    const markers = emptyMarkers();
    scanMarkers(markers, {
        agent_error: { text: "exceeded MAX_STEPS=25 without yielding an assistant response.", turn_index: 1 },
    });
    assert.equal(markers.stepLimitTurn, 1);
});

// One GET /responses row as served (the record-output stub's result hides
// three levels deep).
function row(value) {
    return {
        event: {
            created_at: "2026-08-25T00:00:00Z",
            event: {
                join_set_id: "n:session-events",
                event: { type: "child_execution_finished", result: { ok: { value } } },
            },
        },
    };
}

test("sessionEventValue unwraps the recorded stub payload", () => {
    const value = { agent_status: { working: false, turn_index: 1 } };
    assert.deepEqual(sessionEventValue(row(value)), value);
    assert.equal(sessionEventValue({ event: { event: { event: { type: "other" } } } }), null);
    assert.equal(sessionEventValue(undefined), null);
});

test("latest-window scan lets the newest status win over older turns", () => {
    // Pages arrive oldest-first even in the older direction; a session parked
    // after its final answer must not read the earlier model turn's true.
    const scan = projectLatestWindow([
        row({ agent_status: { working: true, turn_index: 0 } }),
        row({ assistant_reply: { content_json: JSON.stringify([{ type: "text", text: "done" }]), turn_complete: true, turn_index: 0 } }),
        row({ input_offered: { execution_id: "E_s.n:user_3", turn_index: 0 } }),
        row({ agent_status: { working: false, turn_index: 0 } }),
    ]);
    assert.equal(scan.working, false);
    assert.equal(scan.offerId, "E_s.n:user_3");
    assert.equal(scan.markers.lastReplyTurn, 0);
});

test("latest-window scan reports null flags when nothing matches", () => {
    const scan = projectLatestWindow([row({ session_started: { prompt: "p" } })]);
    assert.equal(scan.working, null);
    assert.equal(scan.offerId, null);
    assert.deepEqual(scan.markers, emptyMarkers());
    assert.equal(projectLatestWindow([]).working, null);
});

test("latest-window scan invalidates a turn's offer until the next one is advertised", () => {
    const ended = projectLatestWindow([
        row({ input_offered: { execution_id: "E_s.n:user-0_2", turn_index: 0 } }),
        row({ shell_output: { id: "shell-0", turn_complete: true, turn_index: 0 } }),
    ]);
    assert.equal(ended.offerId, null);

    const advanced = projectLatestWindow([
        row({ input_offered: { execution_id: "E_s.n:user-0_2", turn_index: 0 } }),
        row({ assistant_reply: { content_json: "[]", turn_complete: true, turn_index: 0 } }),
        row({ input_offered: { execution_id: "E_s.n:user-1_1", turn_index: 1 } }),
    ]);
    assert.equal(advanced.offerId, "E_s.n:user-1_1");
});
