// Central session-state projection: one place maps raw execution/session
// facts onto the state label rendered by the sidebar, the detail header, and
// reported by `chat state`. Consumers: webhook/lib/runs.js (which serves the
// precomputed state/label/cls) and activity/chat.js (`state` field). The
// browser shell cannot import modules (inline script), so it only consumes
// the rendered labels. Rationale: meta/designs/workflow-agent-session-learnings.md
// learning 3.

export const SESSION_STATES = {
    THINKING: "thinking",
    WORKING: "working",
    AWAITING_USER: "awaiting-user",
    AWAITING_ANSWER: "awaiting-answer",
    FINAL_RESPONSE: "final-response",
    STEP_LIMIT: "step-limit",
    FINISHED_OK: "finished-ok",
    CANCELLED: "cancelled",
    FAILED: "failed",
    SHELL_ONLY: "shell-only",
    PAUSED: "paused",
    UNKNOWN: "unknown",
};

// Terminal marker turns derived from the session-event stream; both readers
// (full walk in chat.js, recent-window scan in webhook/lib/responses.js)
// produce this shape so the projection stays identical.
//   lastReplyTurn: newest completed assistant text message (a final response).
//   stepLimitTurn: newest MAX_STEPS agent error.
//   hasShellEvents: any recorded shell command.
//
//   {
//     lastReplyTurn: number | null,
//     stepLimitTurn: number | null,
//     hasShellEvents: boolean,
//   }

/**
 * @param {object} input
 * @param {string} input.status obelisk pending_state.status
 * @param {object|null} input.resultKind parsed final result ({ok}|{err}) when finished
 * @param {string} input.joinName suffix of the blocked-on join set
 * @param {boolean} input.working latest agent_status.working flag
 * @param {object} input.markers terminal-marker turns (see above)
 */
export function projectSessionState({ status, resultKind, joinName, working, markers }) {
    if (status === "finished") return finishedState(resultKind);
    if (status === "paused") return SESSION_STATES.PAUSED;
    if (status === "running") return SESSION_STATES.WORKING;
    if (status === "blocked_by_join_set") {
        return blockedState(joinName || "", working === true, markers || EMPTY_MARKERS);
    }
    return SESSION_STATES.UNKNOWN;
}

const EMPTY_MARKERS = {};

function finishedState(resultKind) {
    const err = errArm(resultKind);
    if (err !== undefined) {
        return err?.execution_failure === "cancelled"
            ? SESSION_STATES.CANCELLED
            : SESSION_STATES.FAILED;
    }
    return SESSION_STATES.FINISHED_OK;
}

function errArm(resultKind) {
    if (!resultKind || typeof resultKind !== "object") return undefined;
    if (resultKind.err !== undefined) return resultKind.err;
    if (resultKind.Err !== undefined) return resultKind.Err;
    return undefined;
}

function blockedState(join, working, markers) {
    // Ask-user stubs park on their own `o:N-ask-user` set; the offer is the
    // question awaiting an answer.
    if (/ask-user/.test(join)) return SESSION_STATES.AWAITING_ANSWER;
    // The completion child shares the per-turn user join set (user input races
    // the model call there), so `user + working` means thinking, not parked.
    if (join === "completion") return SESSION_STATES.THINKING;
    if (working) return join === "user" ? SESSION_STATES.THINKING : SESSION_STATES.WORKING;
    // Parked on the user offer: whatever ended the last turn decides the label.
    if (join === "user") {
        const stepLimitTurn = markers.stepLimitTurn ?? null;
        const lastReplyTurn = markers.lastReplyTurn ?? null;
        if (stepLimitTurn !== null && (lastReplyTurn === null || stepLimitTurn > lastReplyTurn)) {
            return SESSION_STATES.STEP_LIMIT;
        }
        if (lastReplyTurn !== null) return SESSION_STATES.FINAL_RESPONSE;
        if (markers.hasShellEvents) return SESSION_STATES.SHELL_ONLY;
        return SESSION_STATES.AWAITING_USER;
    }
    // Blocked elsewhere without a working flag is a transient tool wait.
    return SESSION_STATES.WORKING;
}

// Rendered chip per state: [label, css class]. Classes come from the existing
// shell.css palette (.working warn, .awaiting accent, .finished ok-green,
// .err red, .paused accent); empty string inherits the muted meta color.
export const SESSION_STATE_LABELS = {
    [SESSION_STATES.THINKING]: ["thinking", "working"],
    [SESSION_STATES.WORKING]: ["working", "working"],
    [SESSION_STATES.AWAITING_USER]: ["your turn", "awaiting"],
    [SESSION_STATES.AWAITING_ANSWER]: ["awaiting answer", "awaiting"],
    [SESSION_STATES.FINAL_RESPONSE]: ["final response", "finished"],
    [SESSION_STATES.STEP_LIMIT]: ["step limit", "awaiting"],
    [SESSION_STATES.FINISHED_OK]: ["ok", "finished"],
    [SESSION_STATES.CANCELLED]: ["cancelled", "err"],
    [SESSION_STATES.FAILED]: ["failed", "err"],
    [SESSION_STATES.SHELL_ONLY]: ["shell", ""],
    [SESSION_STATES.PAUSED]: ["paused", "paused"],
    [SESSION_STATES.UNKNOWN]: ["unknown", ""],
};

/** Accumulate terminal-marker facts from one raw session-event value. */
export function scanMarkers(markers, value) {
    if (!value || typeof value !== "object") return;
    if (value.agent_error) {
        const err = value.agent_error;
        if (
            typeof err.id === "string" && err.id.startsWith("step-limit-")
            || typeof err.text === "string" && err.text.startsWith("exceeded MAX_STEPS")
        ) {
            const turn = intOr(err.turn_index, -1);
            if (turn >= 0) markers.stepLimitTurn = Math.max(markers.stepLimitTurn ?? -1, turn);
        }
        return;
    }
    if (value.assistant_reply) {
        const rep = value.assistant_reply;
        if (rep.turn_complete !== true) return;
        let textOnly = false;
        try {
            const blocks = JSON.parse(rep.content_json);
            textOnly = Array.isArray(blocks)
                && blocks.some((b) => b?.type === "text" && b.text)
                && !blocks.some((b) => b?.type === "tool_use");
        } catch (_) { /* unparseable content never counts as a final reply */ }
        if (textOnly) {
            const turn = intOr(rep.turn_index, -1);
            if (turn >= 0) markers.lastReplyTurn = Math.max(markers.lastReplyTurn ?? -1, turn);
        }
        return;
    }
    if (value.shell_output) markers.hasShellEvents = true;
}

function intOr(value, fallback) {
    return Number.isInteger(value) ? value : fallback;
}

export function emptyMarkers() {
    return { lastReplyTurn: null, stepLimitTurn: null, hasShellEvents: false };
}
