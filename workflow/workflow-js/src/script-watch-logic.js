// Pure per-script watch join-set logic, kept free of any
// `obelisk` global or WIT-module import so it is unit-testable under plain
// `node --test` with a fake join-set object -- mirrors session.js's split
// from session-logic.js. `script-watch.js` is the thin host-facing wrapper
// that submits the real interrupt offer/watchdog delay and hands back a
// `ScriptWatchGuard`; nothing else needs to touch `obelisk.*`.
//
// `joinSet` is expected to have `obelisk.createJoinSet()`'s ergonomic shape:
// `.submitDelay(schedule)` (returns a
// delay id string), `.joinNextTry()` / `.joinNext()` (return the completed
// child's ok value, or `null` for a completed delay; `joinNextTry` returns
// `undefined` when nothing has completed yet; both throw on a completed
// child's own error, or when the set is exhausted), `.lastId` (the id of
// whatever just completed -- still readable after a throw), `.close()`.

export class ScriptWatchGuard {
    // `watchdogDelayId` is `null` when no timeout was armed.
    constructor(joinSet, offerExecutionId, watchdogDelayId = null) {
        this.joinSet = joinSet;
        this.offerExecutionId = offerExecutionId;
        this.watchdogDelayId = watchdogDelayId;
    }

    // What a completed response means for this script. Responses from
    // earlier children of the session cannot appear here: the set is fresh
    // per script.
    classify(id) {
        if (id === this.offerExecutionId) return "operator";
        if (this.watchdogDelayId !== null && id === this.watchdogDelayId) return "timeout";
        return null;
    }

    // Handle for `Bash#setScriptWatch`, matching vendor/just-bash/src/
    // watch.js's duck-typed ScriptWatch contract (`poll()` / `sleep(ms)`).
    watcher() {
        return {
            poll: () => this.poll(),
            sleep: (ms) => this.sleep(ms),
        };
    }

    // Peek the signal at a durable boundary; never blocks.
    //
    // This runtime's ergonomic
    // `joinSet.joinNextTry()` throws directly when the *completing child's
    // own function* returned an error. Since `classify` only cares about
    // which id completed, not whether its own value was ok or err, an
    // exception is handled the same way a successful completion is: read
    // `lastId` and classify it.
    poll() {
        while (true) {
            let lastId;
            try {
                const value = this.joinSet.joinNextTry();
                if (value === undefined) return null; // Pending: nothing new.
                lastId = this.joinSet.lastId;
            } catch {
                // Exhausted (nothing left to join), or an id this watch
                // isn't tracking failing: neither is a signal for this
                // watch.
                return this.classify(this.joinSet.lastId);
            }
            const kind = this.classify(lastId);
            if (kind) return kind;
            // Unrecognized completion drained; keep looking for ours.
        }
    }

    // Durably wait `ms` milliseconds, waking early when the signal lands.
    // Returns `{ interrupted }` rather than throwing (see watch.js) so the
    // `sleep` builtin decides what to do with it.
    sleep(ms) {
        if (ms <= 0) return { interrupted: null };
        const ownDelayId = this.joinSet.submitDelay({ milliseconds: ms });
        while (true) {
            let lastId;
            try {
                // Blocks: the set always has at least our own delay
                // outstanding here.
                this.joinSet.joinNext();
                lastId = this.joinSet.lastId;
            } catch {
                lastId = this.joinSet.lastId;
                const kind = this.classify(lastId);
                if (kind) return { interrupted: kind };
                // Our own delay erroring (cancellation), a join-set
                // exhaustion, or an untracked id failing: none of these are
                // an interrupt signal. Treat as an ordinary elapsed sleep
                // rather than fabricate one or spin retrying (unreachable
                // while pending children exist).
                return { interrupted: null };
            }
            if (lastId === ownDelayId) return { interrupted: null };
            const kind = this.classify(lastId);
            if (kind) return { interrupted: kind };
            // Unrecognized completion (shouldn't happen: the set is fresh
            // per script); keep waiting for our own delay or the signal.
        }
    }

    // Close the join set, cancelling whichever children are still
    // outstanding (the unfulfilled offer on natural completion, a leftover
    // watchdog delay after an early wake). The caller (session.js) must call
    // this once the script has finished.
    close() {
        this.joinSet.close();
    }
}
