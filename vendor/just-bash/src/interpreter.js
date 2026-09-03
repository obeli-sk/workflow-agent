// Tree-walking interpreter: statement/pipeline/command execution, I/O
// binding & redirection, and control flow. Builtins (commands/*.js) receive
// `(interp, args, stdin)` and return `{stdout, stderr, exitCode}` — routing
// that output to the right destination (terminal log, a pipe buffer, or a
// VFS file, following redirects and fd dups) happens once per command here,
// not incrementally, since this interpreter is fully synchronous.

import { globToRegExp } from "./glob.js";
import { expandWordSingle, expandWordToFields, ShellExpansionError, braceExpandWord } from "./expansion.js";
import { Arith, ArithError } from "./arithmetic.js";

export class ShellError extends Error {}

class BreakSignal {
    constructor(level) { this.level = level; }
}
class ContinueSignal {
    constructor(level) { this.level = level; }
}
export class ExitSignal {
    constructor(code) { this.code = code; }
}
// Thrown to unwind statement-list execution once a script-watch guard
// (watch.js: timeout / operator interrupt) has fired -- the actual "why" is
// read back off `interp.interrupted` (see `checkWatch`/`Bash#exec`), not off
// this signal, since the boundary that notices the flag (a loop header, a
// statement-list check) is not necessarily the boundary that set it (after a
// custom command, or inside `sleep`). Mirrors just-bash-rs's `interpreter.rs`
// `halted()` check, ported to JS's exception-based control flow instead of a
// per-call boolean return.
export class WatchInterrupt {}

export class OutputLog {
    constructor() {
        this.chunks = [];
    }
    push(tag, text) {
        if (!text) return;
        const last = this.chunks[this.chunks.length - 1];
        if (last && last.fd === tag) last.text += text;
        else this.chunks.push({ fd: tag, text });
    }
    stdoutString() {
        return this.chunks.filter((c) => c.fd === "stdout").map((c) => c.text).join("");
    }
    stderrString() {
        return this.chunks.filter((c) => c.fd === "stderr").map((c) => c.text).join("");
    }
}

function logSink(tag) {
    return { kind: "log", tag };
}
function bufferSink() {
    return { kind: "buffer", ref: { data: "" } };
}
function discardSink() {
    return { kind: "discard" };
}
function stringSource(text) {
    return { kind: "string", text };
}

export class Interpreter {
    constructor({ vfs, cwd, env, now, sleep, customCommands, dispatchBuiltin, commandNames, log, logContext }) {
        this.vfs = vfs;
        this.cwd = cwd;
        this.vars = new Map(Object.entries(env ?? {}));
        this.exported = new Set(this.vars.keys());
        this.positionalParams = [];
        this.scriptName = "bash";
        this.lastExitCode = 0;
        this.now = now;
        this.sleepFn = sleep;
        this.custom = customCommands ?? new Map();
        this.dispatchBuiltin = dispatchBuiltin;
        this.commandNames = commandNames ?? [];
        this.rootLog = log;
        this.logContext = logContext ?? null;
        this.opts = { errexit: false, nounset: false, pipefail: false, xtrace: false };
        // Host-installed abort watcher (watch.js's duck-typed ScriptWatch),
        // installed by `Bash#exec` for the duration of one script.
        this.watcher = null;
        // Set once the watcher fires (PORT: interpreter.rs's `interrupted`
        // field); `null` while the script runs normally. Read directly by
        // `Bash#exec` after the run, so the exit code is correct even when
        // nothing after the triggering point calls `checkWatch` again (e.g.
        // the interrupted command was the script's last statement).
        this.interrupted = null;
        this.aliases = new Map();
        // Diagnostics only (see `invoke`): a monotonic count of every command
        // dispatched this exec() run, and the current recursion depth (command
        // substitution, `sh -c`, etc. re-enter `invoke` while already inside one).
        this.invocationSeq = 0;
        this.invocationDepth = 0;
    }

    // Durable boundary check (PORT: interpreter.rs's `halted()`), called at
    // every statement-list/loop-iteration boundary. Peeking the watcher
    // itself only happens in `pollWatchAfterCustomCommand`/`sleep` -- this
    // just observes the flag those set and unwinds once it's there.
    checkWatch() {
        if (this.interrupted !== null) throw new WatchInterrupt();
    }

    // Durable boundary (PORT: commands/mod.rs's `poll_script_watch`), called
    // once right after a *custom* command handler returns (never after a
    // builtin). Records the signal without unwinding: this command's own
    // output/status still land normally, matching Rust's "the remaining
    // statements are skipped but this command's output and status stand."
    pollWatchAfterCustomCommand() {
        if (!this.watcher || this.interrupted !== null) return;
        const kind = this.watcher.poll();
        if (kind) this.interrupted = kind;
    }

    getVar(name) {
        const value = this.vars.has(name) ? this.vars.get(name) : undefined;
        if (value === undefined && this.opts.nounset && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
            throw new ShellExpansionError(`${name}: unbound variable`);
        }
        if (name === "?") return String(this.lastExitCode);
        if (name === "0") return this.scriptName;
        return value;
    }

    setVar(name, value) {
        this.vars.set(name, value);
    }

    envSnapshot() {
        return Object.fromEntries(this.vars.entries());
    }

    expandCtx(io) {
        return {
            getVar: (name) => this.getVar(name),
            setVar: (name, value) => this.setVar(name, value),
            positional: () => this.positionalParams,
            vfs: this.vfs,
            cwd: this.cwd,
            runCommandSub: (script) => this.runCaptured(script, io).stdout.replace(/\n+$/, ""),
            evalArith: (expr) => this.evalArith(expr),
            procSub: () => { throw new ShellError("process substitution is not supported"); },
        };
    }

    evalArith(expr) {
        try {
            return new Arith(expr, {
                getVar: (name) => this.getVar(name) ?? "0",
                setVar: (name, value) => this.setVar(name, value),
            }).evaluate().toString();
        } catch (e) {
            if (e instanceof ArithError) throw new ShellError(`bash: ((: ${expr}: ${e.message}`);
            throw e;
        }
    }

    runCaptured(script, io) {
        const bindings = { 0: io[0], 1: bufferSink(), 2: bufferSink() };
        this.runStatements(script.statements, bindings);
        return {
            stdout: bindings[1].ref.data,
            stderr: bindings[2].ref.data,
            exitCode: this.lastExitCode,
        };
    }

    resolveStdinText(source) {
        if (source.kind === "string") return source.text;
        if (source.kind === "file-read") {
            if (!this.vfs.isFile(source.path)) throw new ShellError(`bash: ${source.path}: No such file or directory`);
            return this.vfs.readFile(source.path);
        }
        return "";
    }

    deliver(sink, text) {
        if (!text) return;
        if (sink.kind === "log") this.rootLog.push(sink.tag, text);
        else if (sink.kind === "buffer") sink.ref.data += text;
        else if (sink.kind === "file") {
            if (sink.path === "/dev/null") return;
            this.vfs.appendFile(sink.path, text);
        }
    }

    runStatements(statements, io) {
        for (const statement of statements) {
            this.checkWatch();
            const status = this.runStatement(statement, io);
            if (this.opts.errexit && status !== 0) {
                throw new ExitSignal(status);
            }
        }
    }

    runStatement(statement, io) {
        let status = this.runPipeline(statement.pipelines[0], io);
        for (let i = 0; i < statement.operators.length; i++) {
            const op = statement.operators[i];
            if ((op === "and" && status === 0) || (op === "or" && status !== 0)) {
                status = this.runPipeline(statement.pipelines[i + 1], io);
            }
        }
        this.lastExitCode = status;
        return status;
    }

    runPipeline(pipeline, io) {
        let stdinSource = io[0];
        let status = 0;
        for (let i = 0; i < pipeline.commands.length; i++) {
            const isLast = i === pipeline.commands.length - 1;
            const stageIo = { 0: stdinSource, 1: isLast ? io[1] : bufferSink(), 2: io[2] };
            status = this.runCommand(pipeline.commands[i], stageIo);
            if (!isLast) {
                stdinSource = stringSource(stageIo[1].ref ? stageIo[1].ref.data : "");
            }
            if (this.opts.pipefail) {
                if (status !== 0) this._pipefailStatus = status;
            } else {
                this._pipefailStatus = status;
            }
        }
        const finalStatus = this.opts.pipefail ? this._pipefailStatus : status;
        return pipeline.negated ? (finalStatus === 0 ? 1 : 0) : finalStatus;
    }

    runCommand(command, io) {
        if (command.kind === "arith") {
            const value = this.evalArith(this.stringifyArithExpr(command.expr));
            return value === "0" ? 1 : 0;
        }
        if (command.kind === "simple") return this.runSimple(command, io);
        return this.runCompound(command.compound, io);
    }

    stringifyArithExpr(expr) {
        return expr;
    }

    resolveBindings(redirects, io) {
        const bindings = { 0: io[0], 1: io[1], 2: io[2] };
        const ctx = this.expandCtx(io);
        for (const r of redirects) {
            const target = r.target;
            if (target.type === "file") {
                const path = this.resolvePath(expandWordSingle(target.word, ctx));
                this.vfs.ensureMountedFor(path);
                if (r.kind === "read") {
                    bindings[r.fd] = { kind: "file-read", path };
                } else {
                    const sink = path === "/dev/null" ? discardSink() : { kind: "file", path };
                    if (r.kind === "write" && sink.kind === "file") this.vfs.writeFile(path, "");
                    bindings[r.fd] = sink;
                }
            } else if (target.type === "dup") {
                if (target.fd === -1) bindings[r.fd] = discardSink();
                else bindings[r.fd] = bindings[target.fd] ?? discardSink();
            } else if (target.type === "heredoc") {
                bindings[0] = stringSource(expandWordSingle(target.body, ctx));
            } else if (target.type === "herestring") {
                bindings[0] = stringSource(`${expandWordSingle(target.word, ctx)}\n`);
            }
        }
        return bindings;
    }

    runSimple(cmd, io) {
        const bindings = this.resolveBindings(cmd.redirects, io);
        const ctx = this.expandCtx(io);
        const savedVars = new Map();
        for (const a of cmd.assignments) {
            savedVars.set(a.name, this.vars.has(a.name) ? this.vars.get(a.name) : undefined);
            this.vars.set(a.name, expandWordSingle(a.value, ctx));
        }
        if (cmd.words.length === 0) {
            // Assignment-only statement: bindings persist in the current shell.
            return 0;
        }
        const words = cmd.words.flatMap(braceExpandWord);
        const args = words.flatMap((w) => expandWordToFields(w, ctx));
        // Fire a deferred mount (the deployment tree, an MCP server's
        // resources, ...) if this command references a path under its root,
        // so a session that never touches a given mount never fetches it.
        // Checks cwd (for `cd .../current; cat foo`) and each expanded
        // argument (absolute or relative references); runs after glob
        // expansion, so a glob as the very first reference to a tree lists
        // nothing until the mount materializes on the next access.
        this.vfs.ensureMountedFor(this.cwd);
        for (const arg of args) this.vfs.ensureMountedFor(this.resolvePath(arg));
        const stdinText = this.resolveStdinText(bindings[0]);
        const result = this.invoke(args, stdinText, bindings);
        // Prefix assignments (`FOO=bar cmd`) are scoped to this invocation only.
        for (const [name, prev] of savedVars) {
            if (prev === undefined) this.vars.delete(name); else this.vars.set(name, prev);
        }
        this.deliver(bindings[1], result.stdout);
        this.deliver(bindings[2], result.stderr);
        this.lastExitCode = result.exitCode;
        return result.exitCode;
    }

    invoke(args, stdin, bindings) {
        const name = args[0];
        if (!name) return { stdout: "", stderr: "", exitCode: 0 };
        const isCustom = this.custom.has(name);
        const ctx = this.logContext ? `${this.logContext} ` : "";
        this.invocationSeq += 1;
        this.invocationDepth += 1;
        const seq = this.invocationSeq;
        const depth = this.invocationDepth;
        console.debug(`${ctx}bash step start: seq=${seq} depth=${depth} [${isCustom ? "custom" : "builtin"}] ${JSON.stringify(args)}`);
        let result;
        if (isCustom) {
            result = this.custom.get(name)(this, args, stdin);
            this.pollWatchAfterCustomCommand();
        } else {
            result = this.dispatchBuiltin(this, args, stdin);
        }
        console.debug(`${ctx}bash step done: seq=${seq} depth=${depth} [${isCustom ? "custom" : "builtin"}] ${name} exitCode=${result.exitCode}`);
        this.invocationDepth -= 1;
        return result;
    }

    resolvePath(path) {
        return path.startsWith("/") ? normalize(path) : normalize(`${this.cwd}/${path}`);
    }

    runCompound(compound, io) {
        switch (compound.type) {
            case "if": return this.runIf(compound, io);
            case "for": return this.runFor(compound, io);
            case "cstylefor": return this.runCStyleFor(compound, io);
            case "while": return this.runWhile(compound, io);
            case "case": return this.runCase(compound, io);
            case "group": return this.runGroupBody(compound.body, io);
            case "subshell": return this.runSubshell(compound.body, io);
            default: throw new ShellError(`unsupported compound command: ${compound.type}`);
        }
    }

    runGroupBody(body, io) {
        let status = 0;
        const errexit = this.opts.errexit;
        this.opts.errexit = false;
        try {
            for (const statement of body) {
                this.checkWatch();
                status = this.runStatement(statement, io);
                if (errexit && status !== 0) throw new ExitSignal(status);
            }
        } finally {
            this.opts.errexit = errexit;
        }
        return status;
    }

    runSubshell(body, io) {
        const savedVars = new Map(this.vars);
        const savedExported = new Set(this.exported);
        const savedCwd = this.cwd;
        const savedPositional = this.positionalParams.slice();
        try {
            return this.runGroupBody(body, io);
        } finally {
            this.vars = savedVars;
            this.exported = savedExported;
            this.cwd = savedCwd;
            this.positionalParams = savedPositional;
        }
    }

    runIf(node, io) {
        if (this.runCondition(node.cond, io) === 0) return this.runGroupBody(node.body, io);
        for (const [cond, body] of node.elifs) {
            if (this.runCondition(cond, io) === 0) return this.runGroupBody(body, io);
        }
        if (node.elseBody) return this.runGroupBody(node.elseBody, io);
        return 0;
    }

    runCondition(statements, io) {
        const errexit = this.opts.errexit;
        this.opts.errexit = false;
        try {
            let status = 0;
            for (const statement of statements) {
                this.checkWatch();
                status = this.runStatement(statement, io);
            }
            return status;
        } finally {
            this.opts.errexit = errexit;
        }
    }

    runWhile(node, io) {
        let status = 0;
        while (true) {
            this.checkWatch();
            const condStatus = this.runCondition(node.cond, io);
            const shouldRun = node.until ? condStatus !== 0 : condStatus === 0;
            if (!shouldRun) break;
            try {
                status = this.runGroupBody(node.body, io);
            } catch (e) {
                if (e instanceof BreakSignal) { if (e.level > 1) { e.level--; throw e; } break; }
                if (e instanceof ContinueSignal) { if (e.level > 1) { e.level--; throw e; } continue; }
                throw e;
            }
        }
        return status;
    }

    runFor(node, io) {
        const ctx = this.expandCtx(io);
        const items = node.items.flatMap(braceExpandWord).flatMap((w) => expandWordToFields(w, ctx));
        let status = 0;
        for (const item of items) {
            this.checkWatch();
            this.vars.set(node.name, item);
            try {
                status = this.runGroupBody(node.body, io);
            } catch (e) {
                if (e instanceof BreakSignal) { if (e.level > 1) { e.level--; throw e; } break; }
                if (e instanceof ContinueSignal) { if (e.level > 1) { e.level--; throw e; } continue; }
                throw e;
            }
        }
        return status;
    }

    runCStyleFor(node, io) {
        if (node.init) this.evalArith(node.init);
        let status = 0;
        while (node.cond === null || this.evalArith(node.cond) !== "0") {
            this.checkWatch();
            try {
                status = this.runGroupBody(node.body, io);
            } catch (e) {
                if (e instanceof BreakSignal) { if (e.level > 1) { e.level--; throw e; } break; }
                if (e instanceof ContinueSignal) {
                    if (e.level > 1) { e.level--; throw e; }
                } else {
                    throw e;
                }
            }
            if (node.update) this.evalArith(node.update);
        }
        return status;
    }

    runCase(node, io) {
        const ctx = this.expandCtx(io);
        const subject = expandWordSingle(node.subject, ctx);
        for (const arm of node.arms) {
            for (const patternWord of arm.patterns) {
                const pattern = expandWordSingle(patternWord, ctx);
                if (globToRegExp(pattern).test(subject)) {
                    return this.runGroupBody(arm.body, io);
                }
            }
        }
        return 0;
    }
}

function normalize(path) {
    const parts = path.split("/");
    const out = [];
    for (const part of parts) {
        if (part === "" || part === ".") continue;
        if (part === "..") { if (out.length) out.pop(); continue; }
        out.push(part);
    }
    return `/${out.join("/")}`;
}

export { BreakSignal, ContinueSignal, logSink, bufferSink, discardSink, stringSource };
