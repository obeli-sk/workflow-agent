/**
 * Pre-captured global references.
 *
 * Defense-in-depth replaces dangerous globals with blocking proxies during
 * bash execution. These pre-captured references are taken at module load
 * time (before defense patches are applied) so that just-bash's own
 * infrastructure can use them safely.
 *
 * IMPORTANT: This module must be imported eagerly (at Bash construction time),
 * not lazily during exec(), to ensure the capture happens before patching.
 */
import { DefenseInDepthBox } from "./security/defense-in-depth-box.js";

const nativeSetTimeout =
  typeof globalThis.setTimeout === "function"
    ? globalThis.setTimeout.bind(globalThis)
    : undefined;
const nativeClearTimeout =
  typeof globalThis.clearTimeout === "function"
    ? globalThis.clearTimeout.bind(globalThis)
    : undefined;
const nativeSetInterval =
  typeof globalThis.setInterval === "function"
    ? globalThis.setInterval.bind(globalThis)
    : undefined;
const nativeClearInterval =
  typeof globalThis.clearInterval === "function"
    ? globalThis.clearInterval.bind(globalThis)
    : undefined;

type TimerCallback = (...args: unknown[]) => unknown;

function bindTimerCallback<T>(callback: T): T {
  if (typeof callback !== "function") return callback;
  return DefenseInDepthBox.bindCurrentContext(callback as TimerCallback) as T;
}

export const _setTimeout: typeof globalThis.setTimeout = ((
  callback: Parameters<typeof globalThis.setTimeout>[0],
  delay?: number,
  ...args: unknown[]
) => {
  if (!nativeSetTimeout) {
    throw new Error("Host does not provide setTimeout");
  }
  return nativeSetTimeout(bindTimerCallback(callback), delay, ...args);
}) as typeof globalThis.setTimeout;

export const _clearTimeout: typeof globalThis.clearTimeout = ((handle) => {
  nativeClearTimeout?.(handle);
}) as typeof globalThis.clearTimeout;

const MAX_NATIVE_TIMEOUT_MS = 2_147_483_647;

export interface FiniteTimeoutHandle {
  cleared: boolean;
  remainingMs: number;
  timer: ReturnType<typeof globalThis.setTimeout> | undefined;
}

/**
 * Schedule a configured deadline without overflowing the host timer. Positive
 * Infinity means no deadline; longer finite delays are advanced in native-safe
 * chunks so they retain their actual duration.
 */
export function _setTimeoutIfFinite(
  callback: Parameters<typeof globalThis.setTimeout>[0],
  delay: number,
): FiniteTimeoutHandle | undefined {
  if (delay === Number.POSITIVE_INFINITY) return undefined;
  if (!nativeSetTimeout) {
    throw new Error("Host does not provide setTimeout for a finite deadline");
  }
  const boundCallback = bindTimerCallback(callback) as () => void;
  const handle: FiniteTimeoutHandle = {
    cleared: false,
    remainingMs: Math.max(0, delay),
    timer: undefined,
  };
  const schedule = (): void => {
    if (handle.cleared) return;
    const chunk = Math.min(handle.remainingMs, MAX_NATIVE_TIMEOUT_MS);
    handle.timer = nativeSetTimeout(() => {
      if (handle.cleared) return;
      handle.remainingMs -= chunk;
      if (handle.remainingMs > 0) schedule();
      else boundCallback();
    }, chunk);
  };
  schedule();
  return handle;
}

export function _clearFiniteTimeout(
  handle: FiniteTimeoutHandle | undefined,
): void {
  if (!handle) return;
  handle.cleared = true;
  if (handle.timer !== undefined) nativeClearTimeout?.(handle.timer);
}

export const _setInterval: typeof globalThis.setInterval = ((
  callback: Parameters<typeof globalThis.setInterval>[0],
  delay?: number,
  ...args: unknown[]
) => {
  if (!nativeSetInterval) {
    throw new Error("Host does not provide setInterval");
  }
  return nativeSetInterval(bindTimerCallback(callback), delay, ...args);
}) as typeof globalThis.setInterval;

export const _clearInterval: typeof globalThis.clearInterval = ((handle) => {
  nativeClearInterval?.(handle);
}) as typeof globalThis.clearInterval;

// _SharedArrayBuffer, _Atomics, _performanceNow moved to security/trusted-globals.ts
