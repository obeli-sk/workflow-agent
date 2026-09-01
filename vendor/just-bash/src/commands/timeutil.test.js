import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "../bash.js";
import { dateCommand, exprCommand, sleepCommand, timeoutCommand, timeCommand } from "./timeutil.js";

// timeutil.js's exported handlers aren't wired into the command registry
// yet (see the file's own header comment + the migration doc) — these
// tests register them as custom commands on a fresh Bash instance so the
// port can be exercised end-to-end through the real interpreter/parser.
function freshBash(options = {}) {
    const bash = new Bash({ cwd: "/workspace", ...options });
    bash.registerCommand("date", dateCommand);
    bash.registerCommand("expr", exprCommand);
    bash.registerCommand("sleep", sleepCommand);
    bash.registerCommand("timeout", timeoutCommand);
    bash.registerCommand("time", timeCommand);
    return bash;
}

function run(script, options) {
    return freshBash(options).exec(script);
}

// ----- date -----

test("date: default clock is the unix epoch", () => {
    assert.equal(run("date +%Y-%m-%d").stdout, "1970-01-01\n");
});

const HOST_CLOCK = 1_700_000_000_000; // 2023-11-14T22:13:20Z

test("date: reads the host clock seam", () => {
    const out = run("date -u +%Y-%m-%d", { nowMs: () => HOST_CLOCK });
    assert.equal(out.stdout, "2023-11-14\n");
});

test("date: format directives", () => {
    const bash = freshBash();
    assert.equal(bash.exec("date +%Y").stdout, "1970\n");
    assert.equal(bash.exec("date +%H:%M:%S").stdout, "00:00:00\n");
    assert.equal(bash.exec("date +%a").stdout, "Thu\n");
    assert.equal(bash.exec("date +%A").stdout, "Thursday\n");
    assert.equal(bash.exec("date +%j").stdout, "001\n");
    assert.equal(bash.exec("date '+%s'").stdout, "0\n");
});

test("date: -d at epoch", () => {
    assert.equal(run("date -d @1000000000 +%Y-%m-%d").stdout, "2001-09-09\n");
});

test("date: -d iso date", () => {
    assert.equal(run("date -d 2024-03-05 +%Y-%m-%d").stdout, "2024-03-05\n");
    assert.equal(run("date -d '2024-03-05 08:09:10' +%T").stdout, "08:09:10\n");
});

test("date: -I and -R flags", () => {
    assert.equal(run("date -I").stdout, "1970-01-01T00:00:00+00:00\n");
    assert.equal(run("date -R").stdout, "Thu, 01 Jan 1970 00:00:00 +0000\n");
});

test("date: invalid date errors", () => {
    const out = run("date -d nonsense");
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /invalid date/);
});

const FRACTIONAL_CLOCK = 1_700_000_123_456; // fraction .456

test("date: sub-second directives zero-pad below milliseconds", () => {
    const bash = freshBash({ nowMs: () => FRACTIONAL_CLOCK });
    assert.equal(bash.exec("date +%3N").stdout, "456\n");
    assert.equal(bash.exec("date +%N").stdout, "456000000\n");
    assert.equal(bash.exec("date +%1N").stdout, "4\n");
    assert.equal(bash.exec("date +%6N").stdout, "456000\n");
    assert.equal(bash.exec("date +%12N").stdout, "456000000000\n");
    assert.equal(bash.exec("date +%s%N").stdout, "1700000123456000000\n");
});

test("date: sub-second field is zero for pinned dates", () => {
    const out = run("date -d @1000000000 +%s%N", { nowMs: () => FRACTIONAL_CLOCK });
    assert.equal(out.stdout, "1000000000000000000\n");
});

test("date: digits before an unknown directive pass through", () => {
    assert.equal(run("date +%3q").stdout, "%3q\n");
});

// ----- expr -----

test("expr: arithmetic", () => {
    const bash = freshBash();
    assert.equal(bash.exec("expr 1 + 2").stdout, "3\n");
    assert.equal(bash.exec("expr 10 - 3").stdout, "7\n");
    assert.equal(bash.exec("expr 4 \\* 5").stdout, "20\n");
    assert.equal(bash.exec("expr 17 / 5").stdout, "3\n");
    assert.equal(bash.exec("expr 17 % 5").stdout, "2\n");
});

test("expr: precedence and parens", () => {
    const bash = freshBash();
    assert.equal(bash.exec("expr 2 + 3 \\* 4").stdout, "14\n");
    assert.equal(bash.exec("expr \\( 2 + 3 \\) \\* 4").stdout, "20\n");
});

test("expr: comparisons", () => {
    const bash = freshBash();
    assert.equal(bash.exec("expr 3 = 3").stdout, "1\n");
    assert.equal(bash.exec("expr 3 != 3").stdout, "0\n");
    assert.equal(bash.exec("expr abc = abc").stdout, "1\n");
    assert.equal(bash.exec("expr 3 \\< 5").stdout, "1\n");
});

test("expr: logical or and and", () => {
    const bash = freshBash();
    assert.equal(bash.exec("expr 0 \\| 5").stdout, "5\n");
    assert.equal(bash.exec("expr 3 \\& 5").stdout, "3\n");
    assert.equal(bash.exec("expr 0 \\& 5").stdout, "0\n");
});

test("expr: string functions", () => {
    const bash = freshBash();
    assert.equal(bash.exec("expr length hello").stdout, "5\n");
    assert.equal(bash.exec("expr substr hello 2 3").stdout, "ell\n");
    assert.equal(bash.exec("expr index hello l").stdout, "3\n");
});

test("expr: match operator", () => {
    const bash = freshBash();
    assert.equal(bash.exec("expr hello : he").stdout, "2\n");
    assert.equal(bash.exec("expr hello : xyz").stdout, "0\n");
});

test("expr: exit code reflects falsiness", () => {
    const bash = freshBash();
    assert.equal(bash.exec("expr 1 - 1").exitCode, 1);
    assert.equal(bash.exec("expr 1 + 1").exitCode, 0);
});

test("expr: division by zero errors", () => {
    const out = run("expr 1 / 0");
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /division by zero/);
});

test("expr: missing operand errors", () => {
    const out = run("expr");
    assert.equal(out.exitCode, 2);
    assert.match(out.stderr, /missing operand/);
});

// ----- sleep -----

test("sleep: valid durations return immediately", () => {
    const bash = freshBash();
    assert.equal(bash.exec("sleep 2").exitCode, 0);
    assert.equal(bash.exec("sleep 0.5").exitCode, 0);
    assert.equal(bash.exec("sleep 1s").exitCode, 0);
    assert.equal(bash.exec("sleep 1m").exitCode, 0);
    assert.equal(bash.exec("sleep 1 2 3").exitCode, 0);
});

test("sleep: missing operand errors", () => {
    const out = run("sleep");
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /missing operand/);
});

test("sleep: invalid interval errors", () => {
    let out = run("sleep abc");
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /invalid time interval/);
    out = run("sleep 1x");
    assert.match(out.stderr, /invalid time interval/);
});

test("sleep: sleeps for the summed duration via the host seam", () => {
    let sleptMs = 0;
    const out = run("sleep 1 0.5s 2", { sleepMs: (ms) => { sleptMs = ms; } });
    assert.equal(out.exitCode, 0);
    // 1 + 0.5s + 2 = 3.5s -> 3500ms passed to the durable sleep seam.
    assert.equal(sleptMs, 3500);
});

// ----- timeout -----

test("timeout: runs the wrapped command", () => {
    const out = run("timeout 5 echo hi");
    assert.equal(out.stdout, "hi\n");
    assert.equal(out.exitCode, 0);
});

test("timeout: propagates the wrapped command exit code", () => {
    const out = run("timeout 5 false");
    assert.equal(out.exitCode, 1);
});

test("timeout: missing operand errors", () => {
    const out = run("timeout");
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /missing operand/);
});

test("timeout: invalid interval errors", () => {
    const out = run("timeout abc echo hi");
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /invalid time interval/);
});

// ----- time -----

test("time: runs command and reports timing on stderr", () => {
    const out = run("time echo hi");
    assert.equal(out.stdout, "hi\n");
    assert.match(out.stderr, /0\.00/);
});

test("time: posix format", () => {
    const out = run("time -p echo hi");
    assert.match(out.stderr, /real 0\.00/);
});

test("time: no command is a no-op", () => {
    const out = run("time");
    assert.equal(out.exitCode, 0);
    assert.equal(out.stdout, "");
});

test("time: -o writes the report to a file instead of stderr", () => {
    const bash = freshBash();
    bash.exec("time -o /report.txt echo hi");
    const out = bash.exec("cat /report.txt");
    assert.match(out.stdout, /0\.00/);
});
