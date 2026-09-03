import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "../bash.js";
import { awkCommand } from "./awk.js";

// awk.js's exported handler isn't wired into the command registry yet (see
// the file's own header comment + the migration doc's parity tracker) —
// register it as a custom command on a fresh Bash instance so the port can
// be exercised end-to-end through the real interpreter/parser, matching how
// timeutil.test.js exercises its not-yet-wired handlers.
function fresh() {
    const bash = new Bash({ cwd: "/test" });
    bash.registerCommand("awk", awkCommand);
    return bash;
}

function withFixtures() {
    const bash = fresh();
    bash.vfs.writeFile("/test/data.txt", "hello world\nfoo bar\n");
    return bash;
}

test("--help", () => {
    const r = fresh().exec("awk --help");
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /awk/);
    assert.match(r.stdout, /pattern scanning/);
});

test("missing program is an error", () => {
    const r = fresh().exec("awk");
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /missing program/);
});

test("missing file is an error", () => {
    const r = fresh().exec("awk '{print}' /nonexistent.txt");
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /No such file/);
});

test("getline is rejected, not silently mishandled", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/src.txt", "a\nb\n");
    const r = bash.exec('awk \'BEGIN{ while((getline l < "/test/src.txt")>0) s=s l; print s }\'');
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /getline is not supported/);
});

test("user-defined functions are rejected, not silently mishandled", () => {
    const r = fresh().exec("echo hi | awk 'function f(x){return x x} {print f($0)}'");
    assert.equal(r.exitCode, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /user-defined functions are not supported/);
});

test("escape sequences", () => {
    const bash = fresh();
    assert.equal(bash.exec('awk \'BEGIN { print "H\\x49\\x4a\\x4BL" }\'').stdout, "HIJKL\n");
    assert.equal(bash.exec('awk \'BEGIN { print "0\\061\\62x\\0645" }\'').stdout, "012x45\n");
});

test("basic field access, $0 and $1", () => {
    const r = withFixtures().exec("awk '{print $0}' /test/data.txt");
    assert.equal(r.stdout, "hello world\nfoo bar\n");
    const r2 = withFixtures().exec("awk '{print $1}' /test/data.txt");
    assert.equal(r2.stdout, "hello\nfoo\n");
});

test("NF for empty line is 0", () => {
    assert.equal(fresh().exec("echo '' | awk '{ print NF }'").stdout, "0\n");
});

test("NR and NF", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/n.txt", "a\nb\nc\n");
    assert.equal(bash.exec("awk '{print NR, $0}' /test/n.txt").stdout, "1 a\n2 b\n3 c\n");
});

test("-F field separator flag (single char and multi-char ERE)", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/d.csv", "a,b,c\n1,2,3\n");
    assert.equal(bash.exec("awk -F',' '{print $2}' /test/d.csv").stdout, "b\n2\n");

    const bash2 = fresh();
    bash2.vfs.writeFile("/test/d2.txt", "a1b2c\n");
    assert.equal(bash2.exec("awk -F'[0-9]+' '{print $1, $2, $3}' /test/d2.txt").stdout, "a b c\n");
});

test("-v assigns a variable before BEGIN", () => {
    const r = fresh().exec("echo x | awk -v name=World '{print \"Hello \" name}'");
    assert.equal(r.stdout, "Hello World\n");
});

test("BEGIN and END blocks", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/ab.txt", "a\nb\n");
    assert.equal(
        bash.exec('awk \'BEGIN{print "start"}{print $0}\' /test/ab.txt').stdout,
        "start\na\nb\n",
    );
    const bash2 = fresh();
    bash2.vfs.writeFile("/test/ab.txt", "a\nb\n");
    assert.equal(
        bash2.exec('awk \'{print $0}END{print "done"}\' /test/ab.txt').stdout,
        "a\nb\ndone\n",
    );
});

test("BEGIN-only program does not require input", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/empty.txt", "");
    assert.equal(bash.exec('awk \'BEGIN{print "hello"}\' /test/empty.txt').stdout, "hello\n");
});

test("regex pattern matches against $0", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/fruit.txt", "apple\nbanana\napricot\ncherry\n");
    assert.equal(bash.exec("awk '/^a/{print}' /test/fruit.txt").stdout, "apple\napricot\n");
});

test("NR-based expression pattern", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/l.txt", "line1\nline2\nline3\n");
    assert.equal(bash.exec("awk 'NR==2{print}' /test/l.txt").stdout, "line2\n");
    assert.equal(bash.exec("awk 'NR>1{print}' /test/l.txt").stdout, "line2\nline3\n");
});

test("range pattern with numeric 0 end matches to EOF", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/toml.txt", "a\n[[webhook]]\nx=1\n[[other]]\nz=3\n[[webhook]]\nb=2\n");
    assert.equal(
        bash.exec("awk '/\\[\\[webhook/,0' /test/toml.txt").stdout,
        "[[webhook]]\nx=1\n[[other]]\nz=3\n[[webhook]]\nb=2\n",
    );
});

test("range pattern closes on the end pattern and re-arms", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/range.txt", "x\nstart\na\nb\nend\ny\nstart\nc\nend\nz\n");
    assert.equal(
        bash.exec("awk '/start/,/end/' /test/range.txt").stdout,
        "start\na\nb\nend\nstart\nc\nend\n",
    );
});

test("range pattern where start and end match the same record closes immediately", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/one.txt", "x\ny\n");
    assert.equal(bash.exec("awk '/x/,/x/' /test/one.txt").stdout, "x\n");
});

test("printf basic", () => {
    const r = fresh().exec("echo 'hello world' | awk '{printf \"%s!\\n\", $1}'");
    assert.equal(r.stdout, "hello!\n");
});

test("reads from stdin when no file given", () => {
    assert.equal(fresh().exec("echo 'a b c' | awk '{print $2}'").stdout, "b\n");
});

test("string concatenation and arithmetic", () => {
    const r = fresh().exec("echo 'hello world' | awk '{print $1 \"-\" $2}'");
    assert.equal(r.stdout, "hello-world\n");
    const r2 = fresh().exec("printf '10 20\\n5 15\\n' | awk '{print $1 + $2}'");
    assert.equal(r2.stdout, "30\n20\n");
});

test("compound assignment", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/nums.txt", "10\n20\n30\n");
    assert.equal(bash.exec("awk 'BEGIN{sum=0}{sum+=$1}END{print sum}' /test/nums.txt").stdout, "60\n");
});

test("increment and decrement", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/abc.txt", "a\nb\nc\n");
    assert.equal(bash.exec("awk 'BEGIN{n=0}{n++}END{print n}' /test/abc.txt").stdout, "3\n");
    assert.equal(bash.exec("awk 'BEGIN{n=0}{++n}END{print n}' /test/abc.txt").stdout, "3\n");
});

test("compound conditions with && and ||", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/rows.txt", "1 10\n2 20\n3 30\n4 40\n5 50\n");
    assert.equal(bash.exec("awk '$1>=2 && $1<=4{print}' /test/rows.txt").stdout, "2 20\n3 30\n4 40\n");
});

test("match(), RSTART, RLENGTH", () => {
    const r = fresh().exec("echo 'hello foo world' | awk '{print match($0, /foo/), RSTART, RLENGTH}'");
    assert.equal(r.stdout, "7 7 3\n");
    const r2 = fresh().exec("echo 'hello world' | awk '{print match($0, /foo/), RSTART, RLENGTH}'");
    assert.equal(r2.stdout, "0 0 -1\n");
});

test("gensub with g and nth-occurrence", () => {
    const r = fresh().exec('echo \'hello world\' | awk \'{print gensub(/o/, "0", "g")}\'');
    assert.equal(r.stdout, "hell0 w0rld\n");
    const r2 = fresh().exec('echo \'foo bar foo baz foo\' | awk \'{print gensub(/foo/, "XXX", 2)}\'');
    assert.equal(r2.stdout, "foo bar XXX baz foo\n");
});

test("power operator ^ and **", () => {
    assert.equal(fresh().exec("echo x | awk '{print 2^3}'").stdout, "8\n");
    assert.equal(fresh().exec("echo x | awk '{print 3**2}'").stdout, "9\n");
});

test("FILENAME and FNR across multiple files", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/a.txt", "a1\na2\n");
    bash.vfs.writeFile("/test/b.txt", "b1\nb2\n");
    const r = bash.exec("awk '{print FILENAME, FNR, NR}' /test/a.txt /test/b.txt");
    assert.equal(r.stdout, "/test/a.txt 1 1\n/test/a.txt 2 2\n/test/b.txt 1 3\n/test/b.txt 2 4\n");
});

test("exit code and next", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/lines.txt", "line1\nline2\nline3\n");
    assert.equal(bash.exec("awk 'NR==2{exit 5}' /test/lines.txt").exitCode, 5);
    const bash2 = fresh();
    bash2.vfs.writeFile("/test/abc.txt", "a\nb\nc\n");
    assert.equal(bash2.exec("awk '/b/{next}{print}' /test/abc.txt").stdout, "a\nc\n");
});

test("do/while and classic for loops with break/continue", () => {
    assert.equal(fresh().exec("awk 'BEGIN{i=0; do{i++}while(i<3); print i}'").stdout, "3\n");
    assert.equal(
        fresh().exec("awk 'BEGIN{for(i=1;i<=10;i++){if(i==5)break; print i}}'").stdout,
        "1\n2\n3\n4\n",
    );
    assert.equal(
        fresh().exec("awk 'BEGIN{for(i=1;i<=5;i++){if(i==3)continue; print i}}'").stdout,
        "1\n2\n4\n5\n",
    );
});

test("printf hex/octal/char/exponential conversions", () => {
    const bash = fresh();
    assert.equal(bash.exec('awk \'BEGIN{printf "%x\\n", 255}\'').stdout, "ff\n");
    assert.equal(bash.exec('awk \'BEGIN{printf "%o\\n", 8}\'').stdout, "10\n");
    assert.equal(bash.exec('awk \'BEGIN{printf "%c\\n", 65}\'').stdout, "A\n");
    assert.equal(bash.exec('awk \'BEGIN{printf "%.2e\\n", 1234}\'').stdout, "1.23e+3\n");
});

test("field assignment extends NF and pads with OFS", () => {
    const r = fresh().exec('echo "a b" | awk \'{ $5 = "e"; print NF, $0 }\'');
    assert.equal(r.stdout, "5 a b   e\n");
    const r2 = fresh().exec('echo "a b c" | awk \'{ $NF = "C"; print }\'');
    assert.equal(r2.stdout, "a b C\n");
});

test("NF= truncates fields", () => {
    const r = fresh().exec('echo "a b c d e" | awk \'{ NF = 2; print $0 }\'');
    assert.equal(r.stdout, "a b\n");
});

test("OFS and ORS", () => {
    const r = fresh().exec('echo "a b c" | awk \'BEGIN{OFS=","}{print $1,$2,$3}\'');
    assert.equal(r.stdout, "a,b,c\n");
    const bash = fresh();
    bash.vfs.writeFile("/test/l3.txt", "line1\nline2\nline3\n");
    assert.equal(bash.exec("awk 'BEGIN{ORS=\";\"} { print }' /test/l3.txt").stdout, "line1;line2;line3;");
});

test("substr variants", () => {
    assert.equal(fresh().exec('echo "hello world" | awk \'{ print substr($0, 7) }\'').stdout, "world\n");
    assert.equal(fresh().exec('echo "hello world" | awk \'{ print substr($0, 1, 5) }\'').stdout, "hello\n");
    assert.equal(fresh().exec('echo "hello" | awk \'{ print substr($0, 0, 3) }\'').stdout, "hel\n");
    assert.equal(
        fresh().exec('awk \'BEGIN { print "[" substr("abc", 10) "]" }\'').stdout,
        "[]\n",
    );
});

test("index()", () => {
    assert.equal(fresh().exec('awk \'BEGIN { print index("hello world", "world") }\'').stdout, "7\n");
    assert.equal(fresh().exec('awk \'BEGIN { print index("hello", "xyz") }\'').stdout, "0\n");
    assert.equal(fresh().exec('awk \'BEGIN { print index("hello", "") }\'').stdout, "1\n");
});

test("toupper/tolower", () => {
    assert.equal(fresh().exec('echo "HELLO WORLD" | awk \'{ print tolower($0) }\'').stdout, "hello world\n");
    assert.equal(fresh().exec('echo "hello world" | awk \'{ print toupper($0) }\'').stdout, "HELLO WORLD\n");
});

test("sub and gsub", () => {
    assert.equal(fresh().exec('echo "hello hello" | awk \'{ sub(/hello/, "hi"); print }\'').stdout, "hi hello\n");
    assert.equal(
        fresh().exec('echo "hello" | awk \'{ n = sub(/l/, "L"); print n, $0 }\'').stdout,
        "1 heLlo\n",
    );
    assert.equal(fresh().exec('echo "hello" | awk \'{ sub(/ll/, "[&]"); print }\'').stdout, "he[ll]o\n");
    assert.equal(
        fresh().exec('echo "hello hello hello" | awk \'{ gsub(/hello/, "hi"); print }\'').stdout,
        "hi hi hi\n",
    );
    assert.equal(
        fresh().exec('echo "ababa" | awk \'{ n = gsub(/a/, "X"); print n, $0 }\'').stdout,
        "3 XbXbX\n",
    );
});

test("sprintf()", () => {
    const r = fresh().exec('awk \'BEGIN{ print sprintf("%s = %d", "x", 42) }\'');
    assert.equal(r.stdout, "x = 42\n");
});

test("ternary operator", () => {
    assert.equal(fresh().exec("awk 'BEGIN { print 1 ? \"yes\" : \"no\" }'").stdout, "yes\n");
    assert.equal(fresh().exec("awk 'BEGIN { print 0 ? \"yes\" : \"no\" }'").stdout, "no\n");
});

test("regex match operators ~ and !~", () => {
    const bash = fresh();
    bash.vfs.writeFile("/test/fruit2.txt", "apple\nbanana\ncherry\n");
    assert.equal(bash.exec("awk '$0 ~ /^a/ { print }' /test/fruit2.txt").stdout, "apple\n");
    assert.equal(bash.exec("awk '$0 !~ /^a/ { print }' /test/fruit2.txt").stdout, "banana\ncherry\n");
});

test("modulo, including negative modulo", () => {
    assert.equal(fresh().exec("awk 'BEGIN { print 17 % 5 }'").stdout, "2\n");
    assert.equal(fresh().exec("awk 'BEGIN { print -17 % 5 }'").stdout, "-2\n");
});

test("split() builtin", () => {
    const r = fresh().exec('echo "a,b,c" | awk \'{ n = split($0, arr, ","); print n, arr[1], arr[2], arr[3] }\'');
    assert.equal(r.stdout, "3 a b c\n");
});
