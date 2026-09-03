// Public API: a persistent shell instance, matching just-bash-rs's `Bash`
// struct (see vendor/just-bash-rs/src/bash.rs). One `Bash` per session; `cwd`
// and `env` persist across `exec` calls, matching the durable session loop's
// expectation of a single long-lived interpreter.

import { Vfs, FsError } from "./fs.js";
import { parseScript, ParseError } from "./parser.js";
import { Interpreter, OutputLog, ExitSignal, WatchInterrupt, ShellError, stringSource } from "./interpreter.js";
import { ShellExpansionError } from "./expansion.js";
import { ArithError } from "./arithmetic.js";
import { dispatch, BUILTIN_NAMES } from "./commands/index.js";
import { exitCodeForInterrupt } from "./watch.js";

export class Bash {
    constructor(options = {}) {
        this.vfs = new Vfs();
        this.cwd = options.cwd ?? "/workspace";
        this.vfs.mkdirp(this.cwd);
        this.env = { ...(options.env ?? {}) };
        this.nowMs = options.nowMs ?? (() => 0);
        this.sleepMs = options.sleepMs ?? (() => {});
        this.custom = new Map();
        this.watcher = null;
        this.logContext = null;
    }

    // Free-text tag (e.g. "turn=3 id=toolu_..." ) prefixed onto this session's
    // per-command "bash step" debug logs, so a live tracing stream can be
    // correlated back to a turn/tool call without cross-referencing separately.
    setLogContext(text) {
        this.logContext = text ?? null;
    }

    fs() {
        return this.vfs;
    }

    registerCommand(name, handler) {
        this.custom.set(name, handler);
    }

    // Install the abort watcher (watch.js's duck-typed ScriptWatch) observed
    // at durable boundaries (after custom commands and inside `sleep`). The
    // session loop swaps it in before one script and takes it back out
    // afterward (PORT: just-bash-rs's `Bash::set_script_watch`).
    setScriptWatch(watcher) {
        this.watcher = watcher;
    }

    commandNames() {
        return [...new Set([...BUILTIN_NAMES, ...this.custom.keys()])];
    }

    exec(script, { stdin = "", cwd } = {}) {
        const log = new OutputLog();
        let ast;
        try {
            ast = parseScript(script);
        } catch (e) {
            if (e instanceof ParseError) {
                const message = `bash: syntax error: ${e.message}\n`;
                log.push("stderr", message);
                return this._result(log, 2, null);
            }
            throw e;
        }
        const interp = new Interpreter({
            vfs: this.vfs,
            cwd: cwd ?? this.cwd,
            env: this.env,
            now: this.nowMs,
            sleep: this.sleepMs,
            customCommands: this.custom,
            dispatchBuiltin: dispatch,
            commandNames: BUILTIN_NAMES,
            log,
            logContext: this.logContext,
        });
        interp.watcher = this.watcher;
        let exitCode = 0;
        try {
            interp.runStatements(ast.statements, {
                0: stringSource(stdin),
                1: { kind: "log", tag: "stdout" },
                2: { kind: "log", tag: "stderr" },
            });
            exitCode = interp.lastExitCode;
        } catch (e) {
            if (e instanceof ExitSignal) {
                exitCode = e.code;
            } else if (e instanceof WatchInterrupt) {
                // interp.interrupted (read below) carries the "why"; this
                // signal only unwound the statement lists.
            } else if (e instanceof ShellExpansionError || e instanceof ArithError) {
                log.push("stderr", `bash: ${e.message}\n`);
                exitCode = 1;
            } else if (e instanceof ShellError || e instanceof FsError) {
                // Commands are expected to catch FsError themselves (see rm's
                // handling in commands/fsutil.js) and report it via their own
                // exit code/stderr; this is the last-resort net for the ones
                // that don't (e.g. a lazy-mounted file that's too large or
                // unreachable), so a VFS problem never aborts the whole
                // workflow the way an uncaught exception would.
                log.push("stderr", `${e.message}\n`);
                exitCode = 1;
            } else {
                throw e;
            }
        }
        // An interrupt overrides whatever status the last statement left,
        // whether or not it was actually observed as a thrown WatchInterrupt
        // (e.g. the triggering custom command was the script's very last
        // statement, so no later boundary check ever ran) -- PORT: bash.rs's
        // `exec`'s exit-code override.
        const interrupted = interp.interrupted;
        if (interrupted !== null) exitCode = exitCodeForInterrupt(interrupted);
        this.cwd = interp.cwd;
        this.env = interp.envSnapshot();
        return this._result(log, exitCode, interrupted, interp.envSnapshot());
    }

    _result(log, exitCode, interrupted, env = {}) {
        return {
            stdout: log.stdoutString(),
            stderr: log.stderrString(),
            output: log.chunks,
            exitCode,
            interrupted,
            env,
        };
    }
}
