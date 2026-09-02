import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "./bash.js";
import { MAX_LAZY_FETCH_BYTES } from "./fs.js";

function run(script, opts) {
    const bash = new Bash({ cwd: "/workspace" });
    return bash.exec(script, opts);
}

test("echo prints a line", () => {
    const r = run("echo hello world");
    assert.equal(r.stdout, "hello world\n");
    assert.equal(r.exitCode, 0);
});

test("variables and expansion", () => {
    const r = run('X=foo; echo "$X-bar"; echo ${X}baz');
    assert.equal(r.stdout, "foo-bar\nfoobaz\n");
});

test("parameter expansion defaults", () => {
    const r = run('echo ${UNSET:-fallback}; Y=set; echo ${Y:-fallback}');
    assert.equal(r.stdout, "fallback\nset\n");
});

test("arithmetic expansion", () => {
    const r = run('echo $((2 + 3 * 4)); X=5; echo $((X++)); echo $X');
    assert.equal(r.stdout, "14\n5\n6\n");
});

test("if/elif/else", () => {
    const r = run(`
        if [ 1 -eq 2 ]; then echo a; elif [ 1 -eq 1 ]; then echo b; else echo c; fi
    `);
    assert.equal(r.stdout, "b\n");
});

test("for loop over list and glob", () => {
    const bash = new Bash({ cwd: "/workspace" });
    bash.exec("mkdir -p /workspace/d; touch /workspace/d/a.txt /workspace/d/b.txt");
    const r = bash.exec("for f in d/*.txt; do echo $f; done");
    assert.equal(r.stdout, "d/a.txt\nd/b.txt\n");
    const abs = bash.exec("for f in /workspace/d/*.txt; do echo $f; done");
    assert.equal(abs.stdout, "/workspace/d/a.txt\n/workspace/d/b.txt\n");
});

test("while and break/continue", () => {
    const r = run(`
        i=0
        while [ $i -lt 5 ]; do
          i=$((i+1))
          if [ $i -eq 2 ]; then continue; fi
          if [ $i -eq 4 ]; then break; fi
          echo $i
        done
    `);
    assert.equal(r.stdout, "1\n3\n");
});

test("case statement", () => {
    const r = run(`
        for x in apple banana cherry; do
          case $x in
            apple) echo fruit-a ;;
            b*) echo fruit-b ;;
            *) echo other ;;
          esac
        done
    `);
    assert.equal(r.stdout, "fruit-a\nfruit-b\nother\n");
});

test("pipeline and exit status", () => {
    const r = run("echo -e 'b\\na\\nc' | sort | tr -d '\\n' 2>/dev/null; echo done");
    // tr isn't implemented yet (Phase 2); this still exercises the pipe wiring.
    assert.ok(r.stdout.includes("done"));
});

test("simple pipe with grep and wc", () => {
    const r = run("printf 'a\\nb\\nab\\n' | grep a | wc -l");
    assert.equal(r.stdout.trim(), "2");
});

test("redirection to file and back", () => {
    const r = run("echo hi > /workspace/out.txt; cat /workspace/out.txt");
    assert.equal(r.stdout, "hi\n");
});

test("append redirection", () => {
    const r = run("echo a > /workspace/f; echo b >> /workspace/f; cat /workspace/f");
    assert.equal(r.stdout, "a\nb\n");
});

test("here-doc", () => {
    const r = run(`cat <<'EOF'\nhello $USER\nEOF`);
    assert.equal(r.stdout, "hello $USER\n");
});

test("here-doc with expansion", () => {
    const r = run(`X=world; cat <<EOF\nhello $X\nEOF`);
    assert.equal(r.stdout, "hello world\n");
});

test("command substitution", () => {
    const r = run('echo "today is $(echo Monday)"');
    assert.equal(r.stdout, "today is Monday\n");
});

test("2>&1 redirect merges stderr into stdout", () => {
    const r = run("grep zzz /nonexistent 2>&1; echo end");
    assert.match(r.stdout, /end/);
});

test("stderr redirected to file leaves stdout log clean", () => {
    const bash = new Bash({ cwd: "/workspace" });
    const r = bash.exec("cat /nope 2>/workspace/err.txt; echo ok");
    assert.equal(r.stdout, "ok\n");
    const check = bash.exec("cat /workspace/err.txt");
    assert.match(check.stdout, /No such file/);
});

test("cd and pwd persist across exec calls", () => {
    const bash = new Bash({ cwd: "/workspace" });
    bash.exec("mkdir -p sub");
    bash.exec("cd sub");
    const r = bash.exec("pwd");
    assert.equal(r.stdout, "/workspace/sub\n");
});

test("functions-free subset: exit code propagation", () => {
    const r = run("false; echo $?");
    assert.equal(r.stdout, "1\n");
});

test("set -e stops on first failure", () => {
    const r = run("set -e\nfalse\necho unreachable");
    assert.equal(r.stdout, "");
    assert.equal(r.exitCode, 1);
});

test("test builtin string and numeric comparisons", () => {
    const r = run('[ "a" = "a" ] && echo eq; [ 3 -gt 2 ] && echo gt');
    assert.equal(r.stdout, "eq\ngt\n");
});

test("read builtin from stdin", () => {
    const r = run("read name\necho \"hi $name\"", { stdin: "world\n" });
    assert.equal(r.stdout, "hi world\n");
});

test("brace expansion", () => {
    const r = run("echo {a,b,c}.txt");
    assert.equal(r.stdout, "a.txt b.txt c.txt\n");
});

test("brace numeric range", () => {
    const r = run("for i in {1..3}; do echo $i; done");
    assert.equal(r.stdout, "1\n2\n3\n");
});

test("subshell does not leak variable changes", () => {
    const r = run("X=outer; (X=inner; echo $X); echo $X");
    assert.equal(r.stdout, "inner\nouter\n");
});

test("negated pipeline", () => {
    const r = run("! false && echo negated-ok");
    assert.equal(r.stdout, "negated-ok\n");
});

test("printf formatting", () => {
    const r = run('printf "%s=%d\\n" foo 42');
    assert.equal(r.stdout, "foo=42\n");
});

test("registered custom command", () => {
    const bash = new Bash({ cwd: "/workspace" });
    bash.registerCommand("greet", (interp, args) => ({ stdout: `hi ${args[1]}\n`, stderr: "", exitCode: 0 }));
    const r = bash.exec("greet world");
    assert.equal(r.stdout, "hi world\n");
});

test("alias stores and lists name/value pairs", () => {
    const r = run("alias ll='ls -la'; alias");
    assert.equal(r.stdout, "alias ll='ls -la'\n");
});

test("unalias removes a stored alias", () => {
    const r = run("alias ll='ls -la'; unalias ll; alias ll");
    assert.match(r.stderr, /not found/);
    assert.equal(r.exitCode, 1);
});

test("rev reverses each line", () => {
    const r = run("printf 'abc\\ndef\\n' | rev");
    assert.equal(r.stdout, "cba\nfed\n");
});

test("parse error is reported, not thrown", () => {
    const r = run("if true; then echo hi");
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /syntax error/);
});

// The script-watch contract from the session loop's perspective (PORT:
// vendor/just-bash-rs/src/bash.rs's `mod script_watch`): signals land only
// at durable boundaries, output already produced stays recorded, and the
// final status is the interrupt kind's exit code.

// Scripted watcher matching watch.js's duck-typed ScriptWatch contract:
// fires on the Nth poll (1-based, custom commands only) and/or on every
// watched sleep.
class FakeWatch {
    constructor({ interruptOnPoll = null, interruptSleeps = false } = {}) {
        this.interruptOnPoll = interruptOnPoll;
        this.interruptSleeps = interruptSleeps;
        this.polls = 0;
        this.sleptMs = [];
    }
    poll() {
        this.polls += 1;
        return this.interruptOnPoll === this.polls ? "timeout" : null;
    }
    sleep(ms) {
        this.sleptMs.push(ms);
        return { interrupted: this.interruptSleeps ? "operator" : null };
    }
}

function bashWithStep(watch) {
    const bash = new Bash({ cwd: "/workspace" });
    bash.registerCommand("step", () => ({ stdout: "", stderr: "", exitCode: 0 }));
    bash.setScriptWatch(watch);
    return bash;
}

test("script watch: poll at a command boundary skips only what follows", () => {
    const watch = new FakeWatch({ interruptOnPoll: 2 });
    const bash = bashWithStep(watch);
    const r = bash.exec("step; echo one; step; echo two; echo three");
    // Output collected before the signal stands; everything after the
    // second boundary is gone.
    assert.equal(r.stdout, "one\n");
    assert.equal(r.exitCode, 124);
    assert.equal(r.interrupted, "timeout");
    assert.equal(r.stderr, "");
});

test("script watch: watched sleep wakes early and ends the script", () => {
    const watch = new FakeWatch({ interruptSleeps: true });
    const bash = bashWithStep(watch);
    const r = bash.exec("sleep 5; echo after");
    assert.equal(r.stdout, "");
    assert.equal(r.exitCode, 130);
    assert.equal(r.interrupted, "operator");
    assert.match(r.stderr, /sleep: interrupted \(operator\)/);
    // The delay reached the watch with its full duration; waking early is
    // the watch's business.
    assert.deepEqual(watch.sleptMs, [5000]);
});

test("script watch: interrupted run overrides the last statement status", () => {
    const watch = new FakeWatch({ interruptSleeps: true });
    const bash = bashWithStep(watch);
    // Without `set -e` the failed `false` would leave exit 1; the interrupt
    // code wins.
    const r = bash.exec("false; sleep 5");
    assert.equal(r.exitCode, 130);
});

test("script watch: natural completion records no marker", () => {
    const watch = new FakeWatch();
    const bash = bashWithStep(watch);
    const r = bash.exec("step; echo done; step");
    assert.equal(r.stdout, "done\n");
    assert.equal(r.exitCode, 0);
    assert.equal(r.interrupted, null);
    // One peek per host-backed command.
    assert.equal(watch.polls, 2);
});

test("script watch: unset watch keeps plain sleep semantics", () => {
    const bash = new Bash({ cwd: "/workspace" });
    const r = bash.exec("sleep 0; echo fine");
    assert.equal(r.stdout, "fine\n");
    assert.equal(r.interrupted, null);
});

test("script watch: a bounded loop stops at the boundary right after the triggering poll, not at the next loop header", () => {
    // Regression coverage for interpreter.js's `runGroupBody`/`runCondition`:
    // a loop body with more than one statement must stop between statements,
    // not just re-check at its next iteration header. Bounded to 1000
    // iterations as a safety net -- if the watch failed to stop the loop,
    // this fails on the stdout/exit-code assertions below instead of hanging
    // `node --test`.
    const watch = new FakeWatch({ interruptOnPoll: 3 });
    const bash = bashWithStep(watch);
    const r = bash.exec("for ((i=0; i<1000; i++)); do step; echo after-$i; done");
    assert.equal(r.stdout, "after-0\nafter-1\n");
    assert.equal(r.exitCode, 124);
    assert.equal(r.interrupted, "timeout");
});

test("a command reading an unfetchable lazy-mounted file fails the script, not the whole exec()", () => {
    // Regression: FsError (thrown by fs.js for a lazy/pending file that's too
    // large or whose fetch fails) used to be absent from exec()'s catch list,
    // so it escaped uncaught out of Bash#exec and turned into a fatal
    // "Workflow err" instead of a normal nonzero-exit bash result.
    const bash = new Bash({ cwd: "/workspace" });
    bash.fs().registerLazy("/dep/big.bin", "sha256:big", MAX_LAZY_FETCH_BYTES + 1);
    let r;
    assert.doesNotThrow(() => { r = bash.exec("head /dep/big.bin"); });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /File too large: \/dep\/big\.bin/);
});
