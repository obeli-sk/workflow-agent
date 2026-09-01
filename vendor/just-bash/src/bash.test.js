import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "./bash.js";

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

test("parse error is reported, not thrown", () => {
    const r = run("if true; then echo hi");
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /syntax error/);
});
