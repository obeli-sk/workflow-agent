// Pure helpers for chat.js (PORT: workflow/workflow-rs/src/chat.rs), kept free
// of any `obelisk` global or WIT-module import so it is unit-testable under
// plain `node --test` (see chat-logic.test.js) -- mirrors session.js's split
// from session-logic.js. `chat.js` is the thin host-facing wrapper that
// dispatches `chat` subcommands, submits child sessions, and durably sleeps
// between `chat watch` polls; nothing else needs to touch `obelisk.*`.
//
// `parseDurationMs`/`validateSlug` are PORTs of this same Rust module's own
// `parse_duration_ms`/`validate_slug`, but they were pulled forward into
// session-logic.js in an earlier phase (session.js's rename-at-creation path
// needed them before this module existed) -- imported from there, not
// reimplemented here.

import { parseDurationMs, validateSlug } from "./session-logic.js";

export const DEFAULT_PEERS_JOIN_SET = "peers";
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh"];

// States `chat watch` wakes on: the child stopped progressing on its own or
// needs its owner. A queued child (`awaiting-user`, nothing done yet) and a
// busy one deliberately do not wake.
export const WATCH_WAKE_STATES = [
    "final-response",
    "step-limit",
    "awaiting-answer",
    "shell-only",
    "finished-ok",
    "cancelled",
    "failed",
];
export const WATCH_DEFAULT_INTERVAL_MS = 2_000;
export const WATCH_DEFAULT_TIMEOUT_MS = 15 * 60_000;

// PORT: chat.rs's `parent_of`. The session that created an execution, derived
// from the derived-execution id shape (`<parent-id>.<join-set-ref>`); `null`
// for top-level executions.
export function parentOf(executionId) {
    const dot = executionId.lastIndexOf(".");
    return dot === -1 ? null : executionId.slice(0, dot);
}

// PORT: chat.rs's `current_payload`. `own` is duck-typed: `{executionId,
// backend, effort, name}` (a plain object or a `ChatSelf` instance).
export function currentPayload(own) {
    return {
        execution_id: own.executionId,
        backend: own.backend,
        effort: own.effort,
        name: own.name ?? null,
        parent_id: parentOf(own.executionId),
    };
}

// PORT: chat.rs's `current_output`.
export function currentOutput(own) {
    return { stdout: `${JSON.stringify(currentPayload(own))}\n`, stderr: "", exitCode: 0 };
}

// PORT: chat.rs's `has_help_flag`.
export function hasHelpFlag(args) {
    return args.some((arg) => arg === "--help" || arg === "-h");
}

// PORT: chat.rs's `usage`.
export function usage(detail) {
    return { stdout: "", stderr: `chat: ${detail}\nTry 'chat --help' for more information.\n`, exitCode: 2 };
}

// PORT: chat.rs's `failure`.
export function failure(message) {
    return { stdout: "", stderr: `chat: ${message}\n`, exitCode: 1 };
}

// PORT: chat.rs's `parse_create_args`. Mirrors the activity-side create
// parser for the flags that matter to child scheduling; `--top-level` never
// reaches here (commandHandler routes it straight to `delegate`). Throws a
// string message on invalid input, matching this module's other parsers.
export function parseCreateArgs(args) {
    const positional = [];
    let model = null;
    let effort = null;
    let name = null;
    let watch = false;
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        const eq = arg.indexOf("=");
        const flag = eq === -1 ? arg : arg.slice(0, eq);
        const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
        if (flag === "--model" || flag === "--effort" || flag === "--name") {
            const already = flag === "--model" ? model !== null : flag === "--effort" ? effort !== null : name !== null;
            if (already) throw `duplicate option: ${flag}`;
            let value;
            if (inlineValue !== undefined) {
                value = inlineValue;
            } else {
                i += 1;
                value = args[i];
                if (value === undefined) throw `option requires a value: ${flag}`;
            }
            if (value === "") throw `option requires a non-empty value: ${flag}`;
            if (flag === "--model") {
                model = value;
            } else if (flag === "--name") {
                const error = validateSlug(value);
                if (error) throw `--name: ${error}`;
                name = value;
            } else {
                if (!EFFORTS.includes(value)) throw `--effort must be one of: ${EFFORTS.join("|")}`;
                effort = value;
            }
        } else if (flag === "--watch") {
            watch = true;
        } else if (arg.startsWith("-")) {
            throw `unsupported option: ${arg}`;
        } else {
            positional.push(arg);
        }
        i += 1;
    }
    return { prompt: positional.join(" "), model, effort, name, watch };
}

// PORT: chat.rs's `stamp_watch_fields`. Adds `timed_out`/`waited_ms` to
// `payload`, coercing a non-object payload to `{}` first. Returns the
// (possibly new) object rather than mutating a non-object in place -- JS has
// no by-reference primitives/`null`, unlike Rust's `&mut Value`, so callers
// must take the return value: `payload = stampWatchFields(payload, ...)`.
export function stampWatchFields(payload, timedOut, waitedMs) {
    const object = payload !== null && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
    object.timed_out = timedOut;
    object.waited_ms = waitedMs;
    return object;
}

// PORT: chat.rs's `parse_watch_args`. `--timeout DURATION`/`--interval
// DURATION` (via `parseDurationMs`) plus exactly one positional session id;
// `--flag=value` inline form supported too. Throws a string message on
// invalid input.
export function parseWatchArgs(args) {
    let id = null;
    let timeoutMs = WATCH_DEFAULT_TIMEOUT_MS;
    let intervalMs = WATCH_DEFAULT_INTERVAL_MS;
    let i = 0;
    while (i < args.length) {
        const arg = args[i];
        const eq = arg.indexOf("=");
        const flag = eq === -1 ? arg : arg.slice(0, eq);
        const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
        const takeValue = () => {
            if (inlineValue !== undefined) return inlineValue;
            i += 1;
            const value = args[i];
            if (value === undefined || value === "") throw `option requires a value: ${flag}`;
            return value;
        };
        if (flag === "--timeout") {
            timeoutMs = parseDurationMs(takeValue());
        } else if (flag === "--interval") {
            intervalMs = parseDurationMs(takeValue());
        } else if (arg.startsWith("-")) {
            throw `unsupported option: ${arg}`;
        } else {
            if (id !== null) throw "exactly one session id is required";
            id = arg;
        }
        i += 1;
    }
    if (id === null) throw "exactly one session id is required";
    return { id, timeoutMs, intervalMs };
}
