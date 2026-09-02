// PORT: workflow/workflow-rs/src/chat.rs
//
// Caller-aware subcommands of the `chat` shell program. The activity behind
// `chat` speaks HTTP to this Obelisk instance but cannot know which session
// invoked it, nor schedule child executions; `commandHandler` wraps that
// program's generic handler (`delegate`, built exactly like this module's own
// `commandHandler` -- see vendor/just-bash/src/obelisk-program.js's header
// comment) and intercepts what only a session can answer: `current`
// (identity), `rename` (slug), and `create` (child scheduling by default).
// Everything else delegates to the activity unchanged.
//
// Custom-command handlers in this runtime receive the *full* argv including
// argv[0] = the command name (see obelisk-program.js's header comment and
// interpreter.js's `invoke`), unlike workflow-rs's `CustomCommandHandler`
// (argv[0] already stripped). `commandHandler`'s returned function strips it
// once (`stripped = args.slice(1)`) so the rest of this module can mirror
// chat.rs's already-stripped `args` byte-for-byte; every call this module
// makes back into `delegate` (from `watchLoop`/`attachFinal`, and the default
// pass-through) must in turn supply its own leading placeholder element
// (`"chat"`) since `delegate` applies the same `.slice(1)` convention.
//
// Deferred: `create_child`'s self-referential child submit. chat.rs's
// `create_child` schedules a new session of the *same kind* via
// `workflow_ext::run_cancellable_submit` (`crate::generated::obelisk_agent::
// workflow_obelisk_ext::workflow`, generated from `obelisk-agent:
// workflow-obelisk-ext/workflow`'s `run-cancellable-submit`). The JS side of
// that WIT package has not been generated/verified in this worktree (no live
// `obelisk` server to run `just verify` against), so `createChild` here takes
// the submit call as an injected `submitFn(joinSet, prompt, model, effort,
// name) -> executionId` parameter instead of a static import. Wiring the real
// `obelisk-agent:workflow-obelisk-ext/workflow`'s generated `runCancellable
// Submit` binding (or whatever it turns out to be named) into this parameter
// happens centrally in session.js, where a live `just verify` can confirm the
// exact import path. `submitFn` is expected to return the plain execution-id
// string (matching every other `*Submit` binding already in use in
// session.js/script-watch.js, e.g. `injectionSubmit`/`interruptSubmit`, whose
// return value is compared directly against a join set's `.lastId`).

import {
    DEFAULT_PEERS_JOIN_SET,
    WATCH_DEFAULT_INTERVAL_MS,
    WATCH_DEFAULT_TIMEOUT_MS,
    WATCH_WAKE_STATES,
    currentOutput,
    failure,
    hasHelpFlag,
    parentOf,
    parseCreateArgs,
    parseWatchArgs,
    stampWatchFields,
    usage,
} from "./chat-logic.js";
import { validateSlug } from "./session-logic.js";

export { parentOf };

// Live identity of the invoking session, captured where commands are
// registered (the activity cannot learn its caller). PORT: chat.rs's
// `ChatSelf` -- Rust needs `Rc<RefCell<...>>` for shared mutability across
// the closures `command_handler` builds; a plain mutable field/`Map` on a
// plain JS object already has that (JS closures capture by reference), so no
// such wrapper is needed here.
export class ChatSelf {
    constructor(executionId, backend, effort, name = null) {
        this.executionId = executionId;
        this.backend = backend;
        this.effort = effort;
        this.name = name;
        // Join sets holding the sessions created by `chat create`, keyed by
        // slug (`--name` labels each child with its own join set, so its
        // execution id shows what it is); created lazily on first use and
        // closed when the session ends, cancelling outstanding children.
        this.peers = new Map();
    }

    // The session that created this one, if any. Derived executions carry
    // their parent in the id (`<parent-id>.<join-set-ref>`).
    parentId() {
        return parentOf(this.executionId);
    }
}

// PORT: chat.rs's `command_handler`.
export function commandHandler(delegate, own, notifications, submitFn) {
    return (interp, args, stdin) => {
        const stripped = args.slice(1);
        const sub = stripped[0];
        const rest = stripped.slice(1);
        if (sub === "current" && !hasHelpFlag(rest)) {
            return currentOutput(own);
        }
        if (sub === "rename" && !hasHelpFlag(stripped)) {
            return rename(stripped, own, notifications);
        }
        if (sub === "create" && !hasHelpFlag(rest) && !rest.includes("--top-level")) {
            return createChild(own, rest, delegate, interp, submitFn);
        }
        if (sub === "watch" && !hasHelpFlag(stripped)) {
            return watchCommand(delegate, interp, rest);
        }
        return delegate(interp, args, stdin);
    };
}

// PORT: chat.rs's `rename`. `args` is the stripped subcommand argv
// (`args[0] === "rename"`, `args[1]` the slug).
export function rename(args, own, notifications) {
    const name = args[1];
    if (name === undefined) return usage("rename expects a slug name");
    if (args.length > 2) return usage("rename takes exactly one argument");
    const invalid = validateSlug(name);
    if (invalid) return usage(invalid);
    try {
        notifications.sessionRenamed(name);
    } catch (error) {
        return failure(describeError(error));
    }
    own.name = name;
    return { stdout: `renamed to ${name}\n`, stderr: "", exitCode: 0 };
}

// PORT: chat.rs's `create_child`. `args` is `rest` (the `create` argv without
// the `create` word itself, matching chat.rs's already-stripped call site).
export function createChild(own, args, delegate, interp, submitFn) {
    let parsed;
    try {
        parsed = parseCreateArgs(args);
    } catch (error) {
        return usage(describeError(error));
    }
    // A true derived child on a session-owned join set: it shows up under
    // --show-derived listings and is cancelled when this session ends. A
    // named child gets its own join set so its execution id carries the slug.
    const setName = parsed.name ?? DEFAULT_PEERS_JOIN_SET;
    let joinSet = own.peers.get(setName);
    if (!joinSet) {
        try {
            joinSet = obelisk.createJoinSet({ name: setName });
        } catch (error) {
            return failure(`child join set: ${describeError(error)}`);
        }
        own.peers.set(setName, joinSet);
    }
    const executionId = submitFn(joinSet, parsed.prompt, parsed.model, parsed.effort, parsed.name);
    if (!parsed.watch) {
        return { stdout: `${executionId}\n`, stderr: "", exitCode: 0 };
    }
    return watchLoop(delegate, interp, {
        id: executionId,
        timeoutMs: WATCH_DEFAULT_TIMEOUT_MS,
        intervalMs: WATCH_DEFAULT_INTERVAL_MS,
    });
}

// ----- chat watch -----------------------------------------------------

// PORT: chat.rs's `watch_command`. `args` is `rest` (the `watch` argv without
// the `watch` word itself).
export function watchCommand(delegate, interp, args) {
    let parsed;
    try {
        parsed = parseWatchArgs(args);
    } catch (error) {
        return usage(describeError(error));
    }
    return watchLoop(delegate, interp, parsed);
}

// Poll `chat state` for one session until it reports a wake state or the
// timeout elapses. Each poll goes through `delegate` (a durable activity
// call) and each wait is a durable sleep, so the whole loop survives
// restarts and pause. PORT: chat.rs's `watch_loop`.
export function watchLoop(delegate, interp, parsed) {
    const startedMs = nowMs();
    const deadline = startedMs + parsed.timeoutMs;
    let stderrNotes = "";
    let lastPayloadText = null;
    while (true) {
        const out = delegate(interp, ["chat", "state", parsed.id], "");
        let parsedPayload;
        let parsedOk = false;
        if (out.exitCode === 0) {
            try {
                parsedPayload = JSON.parse(out.stdout.trim());
                parsedOk = true;
            } catch {
                parsedOk = false;
            }
        }
        if (parsedOk) {
            const state = typeof parsedPayload?.state === "string" ? parsedPayload.state : "unknown";
            if (WATCH_WAKE_STATES.includes(state)) {
                const payload = stampWatchFields(parsedPayload, false, Math.max(0, nowMs() - startedMs));
                attachFinal(delegate, interp, parsed.id, payload);
                return { stdout: `${JSON.stringify(payload)}\n`, stderr: stderrNotes, exitCode: 0 };
            }
            lastPayloadText = out.stdout.trim();
        } else {
            stderrNotes += `chat watch: state read failed: ${out.stderr}`;
        }
        const now = nowMs();
        if (now >= deadline) break;
        try {
            obelisk.sleep({ milliseconds: Math.min(parsed.intervalMs, deadline - now) });
        } catch {
            // Cancelled durable sleep: the `sleep` builtin just returns,
            // matching session.js's hostSleepMs (which drops the
            // cancellation error too).
        }
    }
    const waited = Math.max(0, nowMs() - startedMs);
    let lastPayload;
    try {
        lastPayload = JSON.parse(lastPayloadText ?? "{}");
    } catch {
        lastPayload = {};
    }
    const payload = stampWatchFields(lastPayload, true, waited);
    attachFinal(delegate, interp, parsed.id, payload);
    const state = typeof payload.state === "string" ? ` (state: ${payload.state})` : "";
    stderrNotes += `chat watch: gave up after ${waited} ms waiting for ${parsed.id}${state}\n`;
    return { stdout: `${JSON.stringify(payload)}\n`, stderr: stderrNotes, exitCode: 1 };
}

// Adds the `final` field: the same outcome text `chat read ID --final`
// prints (finished reply, error/failure reason, or pending question), so a
// caller does not need a second round trip after `watch` wakes. Best effort:
// a failed read leaves `final` absent rather than failing the whole watch.
// PORT: chat.rs's `attach_final`.
export function attachFinal(delegate, interp, id, payload) {
    const out = delegate(interp, ["chat", "read", id, "--final"], "");
    if (out.exitCode === 0 && payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
        payload.final = out.stdout.trim();
    }
}

// Current time as Unix epoch milliseconds. PORT: chat.rs's `now_ms` (which
// reads the durable clock via `workflow_support::sleep(ScheduleAt::Now)`);
// this file follows session.js's `hostNowMs` precedent of calling `Date.now()`
// directly instead, since the value here only ever drives watch-loop
// timing/reporting (deadline math, `waited_ms`), the same non-determinism
// tradeoff session.js already made throughout its own turn/duration
// accounting.
function nowMs() {
    return Date.now();
}

function describeError(error) {
    if (error instanceof Error) return error.message;
    return typeof error === "string" ? error : String(error);
}
