// Runs `run(signal)` with a signal aborted after `ms`; the timer is cleared so it cannot keep the activity alive.
export async function withTimeout(ms, run) {
    if (ms === null || typeof AbortController !== "function" || typeof setTimeout !== "function") {
        return run(undefined);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await run(controller.signal);
    } finally {
        clearTimeout(timer);
    }
}
