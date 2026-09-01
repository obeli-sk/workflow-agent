// Public API: a persistent shell instance, matching just-bash-rs's `Bash`
// struct (see vendor/just-bash-rs/src/bash.rs). One `Bash` per session; `cwd`
// and `env` persist across `exec` calls, matching the durable session loop's
// expectation of a single long-lived interpreter.

import { Vfs } from "./fs.js";
import { parseScript, ParseError } from "./parser.js";
import { Interpreter, OutputLog, ExitSignal, WatchInterrupt, ShellError } from "./interpreter.js";
import { ShellExpansionError } from "./expansion.js";
import { ArithError } from "./arithmetic.js";
import { dispatch, BUILTIN_NAMES } from "./commands/index.js";

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
    }

    fs() {
        return this.vfs;
    }

    registerCommand(name, handler) {
        this.custom.set(name, handler);
    }

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
        });
        interp.watcher = this.watcher;
        let exitCode = 0;
        let interrupted = null;
        try {
            interp.runStatements(ast.statements, {
                0: { kind: "string", text: stdin },
                1: { kind: "log", tag: "stdout" },
                2: { kind: "log", tag: "stderr" },
            });
            exitCode = interp.lastExitCode;
        } catch (e) {
            if (e instanceof ExitSignal) {
                exitCode = e.code;
            } else if (e instanceof WatchInterrupt) {
                exitCode = e.exitCode;
                interrupted = e.kind;
            } else if (e instanceof ShellExpansionError || e instanceof ArithError) {
                log.push("stderr", `bash: ${e.message}\n`);
                exitCode = 1;
            } else if (e instanceof ShellError) {
                log.push("stderr", `${e.message}\n`);
                exitCode = 1;
            } else {
                throw e;
            }
        }
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
