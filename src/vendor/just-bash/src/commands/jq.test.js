import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "../bash.js";
import { jqCommand } from "./jq.js";

// jq.js's exported handler isn't wired into the command registry yet (see
// the file's own header comment + the migration doc's parity tracker) —
// register it as a custom command on a fresh Bash instance so the port can
// be exercised end-to-end through the real interpreter/parser, matching how
// awk.test.js/timeutil.test.js exercise their not-yet-wired handlers.
function fresh() {
    const bash = new Bash({ cwd: "/test" });
    bash.registerCommand("jq", jqCommand);
    return bash;
}

// ---- basic filters ----

test("identity pretty-prints", () => {
    const r = fresh().exec(`echo '{"a":1}' | jq '.'`);
    assert.equal(r.stdout, '{\n  "a": 1\n}\n');
    assert.equal(r.exitCode, 0);
});

test("pretty-prints arrays", () => {
    const r = fresh().exec("echo '[1,2,3]' | jq '.'");
    assert.equal(r.stdout, "[\n  1,\n  2,\n  3\n]\n");
});

test("object field access, including missing key as null", () => {
    const bash = fresh();
    assert.equal(bash.exec(`echo '{"name":"test"}' | jq '.name'`).stdout, '"test"\n');
    assert.equal(bash.exec(`echo '{"a":{"b":"nested"}}' | jq '.a.b'`).stdout, '"nested"\n');
    assert.equal(bash.exec(`echo '{"a":1}' | jq '.missing'`).stdout, "null\n");
});

test("array index, negative index, and out-of-range", () => {
    const bash = fresh();
    assert.equal(bash.exec(`echo '["a","b","c"]' | jq '.[0]'`).stdout, '"a"\n');
    assert.equal(bash.exec(`echo '["a","b","c"]' | jq '.[-1]'`).stdout, '"c"\n');
    assert.equal(bash.exec("echo '[1,2]' | jq '.[99]'").stdout, "null\n");
});

test("iteration over arrays and objects", () => {
    const bash = fresh();
    assert.equal(bash.exec("echo '[1,2,3]' | jq '.[]'").stdout, "1\n2\n3\n");
    assert.equal(bash.exec(`echo '{"a":1,"b":2}' | jq '.[]'`).stdout, "1\n2\n");
    assert.equal(bash.exec(`echo '{"items":[1,2,3]}' | jq '.items[]'`).stdout, "1\n2\n3\n");
});

test("pipe chains filters", () => {
    const r = fresh().exec(`echo '{"data":{"value":42}}' | jq '.data | .value'`);
    assert.equal(r.stdout, "42\n");
});

test("slicing arrays and strings", () => {
    const bash = fresh();
    assert.equal(bash.exec("echo '[0,1,2,3,4,5]' | jq '.[2:4]'").stdout, "[\n  2,\n  3\n]\n");
    assert.equal(bash.exec("echo '[0,1,2,3,4]' | jq '.[:3]'").stdout, "[\n  0,\n  1,\n  2\n]\n");
    assert.equal(bash.exec("echo '[0,1,2,3,4]' | jq '.[3:]'").stdout, "[\n  3,\n  4\n]\n");
    assert.equal(bash.exec(`echo '"hello"' | jq '.[1:4]'`).stdout, '"ell"\n');
    assert.equal(bash.exec("echo '[0,1,2,3,4]' | jq '.[-2:]'").stdout, "[\n  3,\n  4\n]\n");
});

test("comma produces multiple outputs", () => {
    const r = fresh().exec(`echo '{"a":1,"b":2}' | jq '.a, .b'`);
    assert.equal(r.stdout, "1\n2\n");
});

// ---- select/map/has/conditionals/optional ----

test("select and map", () => {
    const bash = fresh();
    assert.equal(bash.exec("echo '[1,2,3,4,5]' | jq '[.[] | select(. > 3)]'").stdout, "[\n  4,\n  5\n]\n");
    assert.equal(bash.exec("echo '[1,2,3]' | jq 'map(. * 2)'").stdout, "[\n  2,\n  4,\n  6\n]\n");
    assert.equal(
        bash.exec("echo '[1,2,3,4,5]' | jq '[.[] | select(. > 2) | . * 10]'").stdout,
        "[\n  30,\n  40,\n  50\n]\n",
    );
});

test("has checks objects and arrays", () => {
    const bash = fresh();
    assert.equal(bash.exec(`echo '{"foo":42}' | jq 'has("foo")'`).stdout, "true\n");
    assert.equal(bash.exec(`echo '{"foo":42}' | jq 'has("bar")'`).stdout, "false\n");
    assert.equal(bash.exec("echo '[1,2,3]' | jq 'has(1)'").stdout, "true\n");
});

test("if/then/elif/else/end", () => {
    const bash = fresh();
    assert.equal(bash.exec(`echo '5' | jq 'if . > 3 then "big" else "small" end'`).stdout, '"big"\n');
    assert.equal(bash.exec(`echo '2' | jq 'if . > 3 then "big" else "small" end'`).stdout, '"small"\n');
    assert.equal(
        bash.exec(`echo '5' | jq 'if . > 10 then "big" elif . > 3 then "medium" else "small" end'`).stdout,
        '"medium"\n',
    );
});

test("optional operator swallows index errors", () => {
    const bash = fresh();
    assert.equal(bash.exec("echo 'null' | jq '.foo?'").stdout, "null\n");
    assert.equal(bash.exec(`echo '{"foo":42}' | jq '.foo?'`).stdout, "42\n");
    // `.foo?` on a scalar would normally be a type error; `?` swallows it.
    assert.equal(bash.exec("echo '5' | jq '.foo?'").stdout, "");
});

// ---- construction ----

test("object construction: static keys and shorthand", () => {
    const bash = fresh();
    assert.equal(
        bash.exec(`echo '{"name":"test","value":42}' | jq -c '{n: .name, v: .value}'`).stdout,
        '{"n":"test","v":42}\n',
    );
    assert.equal(
        bash.exec(`echo '{"name":"test","value":42}' | jq -c '{name, value}'`).stdout,
        '{"name":"test","value":42}\n',
    );
});

test("object construction: dynamic key and piped value", () => {
    const bash = fresh();
    assert.equal(bash.exec(`echo '{"key":"foo","val":42}' | jq -c '{(.key): .val}'`).stdout, '{"foo":42}\n');
    assert.equal(
        bash.exec("echo '[[1,2],[3,4]]' | jq -c '{a: .[0] | add, b: .[1] | add}'").stdout,
        '{"a":3,"b":7}\n',
    );
});

test("array construction", () => {
    const bash = fresh();
    assert.equal(bash.exec(`echo '{"a":1,"b":2}' | jq '[.a, .b]'`).stdout, "[\n  1,\n  2\n]\n");
    assert.equal(bash.exec(`echo '{"a":1,"b":2,"c":3}' | jq '[.[]]'`).stdout, "[\n  1,\n  2,\n  3\n]\n");
});

// ---- operators ----

test("arithmetic operators follow jq's per-type rules", () => {
    const bash = fresh();
    assert.equal(bash.exec("echo '5' | jq '. + 3'").stdout, "8\n");
    assert.equal(bash.exec("echo '10' | jq '. - 4'").stdout, "6\n");
    assert.equal(bash.exec("echo '6' | jq '. * 7'").stdout, "42\n");
    assert.equal(bash.exec("echo '20' | jq '. / 4'").stdout, "5\n");
    assert.equal(bash.exec("echo '17' | jq '. % 5'").stdout, "2\n");
    assert.equal(bash.exec(`echo '{"a":"foo","b":"bar"}' | jq '.a + .b'`).stdout, '"foobar"\n');
    assert.equal(bash.exec("echo '[[1,2],[3,4]]' | jq '.[0] + .[1]'").stdout, "[\n  1,\n  2,\n  3,\n  4\n]\n");
    assert.equal(bash.exec('echo \'[{"a":1},{"b":2}]\' | jq -c \'.[0] + .[1]\'').stdout, '{"a":1,"b":2}\n');
});

test("comparison and logical operators", () => {
    const bash = fresh();
    assert.equal(bash.exec("echo '5' | jq '. == 5'").stdout, "true\n");
    assert.equal(bash.exec("echo '5' | jq '. != 3'").stdout, "true\n");
    assert.equal(bash.exec("echo '3' | jq '. < 5'").stdout, "true\n");
    assert.equal(bash.exec("echo '10' | jq '. > 5'").stdout, "true\n");
    assert.equal(bash.exec("echo 'true' | jq '. and true'").stdout, "true\n");
    assert.equal(bash.exec("echo 'false' | jq '. or true'").stdout, "true\n");
    assert.equal(bash.exec("echo 'true' | jq 'not'").stdout, "false\n");
    assert.equal(bash.exec(`echo '{"a":null}' | jq '.a // "default"'`).stdout, '"default"\n');
    assert.equal(bash.exec(`echo '{"a":42}' | jq '.a // "default"'`).stdout, "42\n");
});

test("jq's typed ordering for comparisons", () => {
    const bash = fresh();
    assert.equal(bash.exec("echo 'null' | jq '. < false'").stdout, "true\n");
    assert.equal(bash.exec("echo '1' | jq '. < \"a\"'").stdout, "true\n");
    assert.equal(bash.exec(`echo '["a","b"]' | jq '. < {}'`).stdout, "true\n");
});

test("math functions", () => {
    const bash = fresh();
    assert.equal(bash.exec("echo '3.7' | jq 'floor'").stdout, "3\n");
    assert.equal(bash.exec("echo '3.2' | jq 'ceil'").stdout, "4\n");
    assert.equal(bash.exec("echo '3.5' | jq 'round'").stdout, "4\n");
    assert.equal(bash.exec("echo '16' | jq 'sqrt'").stdout, "4\n");
    assert.equal(bash.exec("echo '-5' | jq 'abs'").stdout, "5\n");
});

test("tostring/tonumber", () => {
    const bash = fresh();
    assert.equal(bash.exec("echo '42' | jq 'tostring'").stdout, '"42"\n');
    assert.equal(bash.exec('echo \'"42"\' | jq \'tonumber\'').stdout, "42\n");
});

test("fromjson/tojson round trip and error cases", () => {
    const bash = fresh();
    // The motivating case: a JSON-encoded string field decoded in-pipe.
    assert.equal(bash.exec(`echo '{"a":{"b":2}}' | jq -c '.a | tojson | fromjson | .b'`).stdout, "2\n");
    assert.equal(bash.exec(`echo '"[1,2]"' | jq -c 'fromjson'`).stdout, "[1,2]\n");
    assert.equal(bash.exec(`echo '"42"' | jq -r 'fromjson'`).stdout, "42\n");
    // Invalid JSON is a runtime error (exit 5), not a parse error.
    assert.equal(bash.exec(`echo '"x"' | jq 'fromjson | fromjson'`).exitCode, 5);
    // Non-string input is rejected like upstream.
    assert.equal(bash.exec("echo 42 | jq 'fromjson'").exitCode, 5);
});

test("split and join", () => {
    const bash = fresh();
    assert.equal(bash.exec(`echo '"a,b,c"' | jq 'split(",")'`).stdout, '[\n  "a",\n  "b",\n  "c"\n]\n');
    assert.equal(bash.exec(`echo '["a","b","c"]' | jq 'join("-")'`).stdout, '"a-b-c"\n');
});

test("length/keys/type/add/range", () => {
    const bash = fresh();
    assert.equal(bash.exec(`echo '[1,2,3]' | jq 'length'`).stdout, "3\n");
    assert.equal(bash.exec(`echo '{"b":1,"a":2}' | jq -c 'keys'`).stdout, '["a","b"]\n');
    assert.equal(bash.exec(`echo '{"b":1,"a":2}' | jq -c 'keys_unsorted'`).stdout, '["b","a"]\n');
    assert.equal(bash.exec(`echo 'null' | jq 'type'`).stdout, '"null"\n');
    assert.equal(bash.exec(`echo '[1,2,3]' | jq 'add'`).stdout, "6\n");
    assert.equal(bash.exec(`jq -cn '[range(3)]'`).stdout, "[0,1,2]\n");
    assert.equal(bash.exec(`jq -cn '[range(1;5;2)]'`).stdout, "[1,3]\n");
});

test("@tsv formats an array row", () => {
    const bash = fresh();
    assert.equal(bash.exec(`echo '[1,"a\\tb",null]' | jq -r '@tsv'`).stdout, "1\ta\\tb\t\n");
});

// ---- CLI flags ----

test("-r raw output flag emits raw strings", () => {
    const r = fresh().exec(`echo '"hello"' | jq -r '.'`);
    assert.equal(r.stdout, "hello\n");
});

test("-c compact output flag", () => {
    const r = fresh().exec(`echo '{"a":1,"b":2}' | jq -c '.'`);
    assert.equal(r.stdout, '{"a":1,"b":2}\n');
});

test("-S sort-keys flag", () => {
    const r = fresh().exec(`echo '{"b":1,"a":2}' | jq -Sc '.'`);
    assert.equal(r.stdout, '{"a":2,"b":1}\n');
});

test("-n null-input flag", () => {
    const r = fresh().exec("jq -n '1 + 1'");
    assert.equal(r.stdout, "2\n");
});

test("-s slurp flag wraps stream into one array", () => {
    const r = fresh().exec("printf '1\\n2\\n3\\n' | jq -s 'add'");
    assert.equal(r.stdout, "6\n");
});

test("-Rs encodes whole raw input as a single JSON string", () => {
    const r = fresh().exec(`printf 'a\\nb"c\\n' | jq -Rs '.'`);
    assert.equal(r.stdout, '"a\\nb\\"c\\n"\n');
    assert.equal(r.exitCode, 0);
});

test("-R emits one string per line", () => {
    const r = fresh().exec(`printf 'a\\nb\\n' | jq -R '.'`);
    assert.equal(r.stdout, '"a"\n"b"\n');
});

test("-e exit-status flag reflects truthiness of the last output", () => {
    const bash = fresh();
    assert.equal(bash.exec("echo 'null' | jq -e '.'").exitCode, 1);
    assert.equal(bash.exec("echo 'false' | jq -e '.'").exitCode, 1);
    assert.equal(bash.exec("echo '0' | jq -e '.'").exitCode, 0);
});

test("no filter defaults to identity", () => {
    const r = fresh().exec(`echo '{"a":1}' | jq`);
    assert.equal(r.stdout, '{\n  "a": 1\n}\n');
    assert.equal(r.exitCode, 0);
});

// ---- external-argument flags ----

test("--arg binds a string, always as text even for numeric input", () => {
    const bash = fresh();
    assert.equal(
        bash.exec(`jq -n --arg name World '{greeting: ("Hello " + $name)}'`).stdout,
        '{\n  "greeting": "Hello World"\n}\n',
    );
    assert.equal(bash.exec(`jq -n --arg x 5 '$x'`).stdout, '"5"\n');
});

test("multiple --arg populate $ARGS.named in order", () => {
    const r = fresh().exec(`jq -cn --arg a foo --arg b bar --arg c baz '$ARGS.named'`);
    assert.equal(r.stdout, '{"a":"foo","b":"bar","c":"baz"}\n');
});

test("--argjson binds a decoded value", () => {
    const bash = fresh();
    assert.equal(bash.exec(`jq -n --argjson x 5 '$x'`).stdout, "5\n");
    assert.equal(bash.exec(`jq -n --argjson x '{"a":1}' '$x.a'`).stdout, "1\n");
});

test("--argjson invalid JSON errors with exit 2", () => {
    const r = fresh().exec(`jq -n --argjson x notjson '$x'`);
    assert.equal(r.stderr, "jq: invalid JSON text passed to --argjson\n");
    assert.equal(r.exitCode, 2);
});

test("--rawfile binds raw file contents", () => {
    const r = fresh().exec("printf 'line1\\nline2\\n' > rf.txt && jq -n --rawfile r rf.txt '$r'");
    assert.equal(r.stdout, '"line1\\nline2\\n"\n');
});

test("--slurpfile binds an array of JSON values", () => {
    const r = fresh().exec("printf '1 2 3\\n' > sf.json && jq -cn --slurpfile s sf.json '$s'");
    assert.equal(r.stdout, "[1,2,3]\n");
});

test("--slurpfile on a missing file errors with exit 2", () => {
    const r = fresh().exec(`jq -n --slurpfile s nope.json '$s'`);
    assert.equal(r.exitCode, 2);
});

test("--args collects string positionals", () => {
    const r = fresh().exec("jq -cn '$ARGS.positional' --args a b c");
    assert.equal(r.stdout, '["a","b","c"]\n');
});

test("--jsonargs collects decoded positionals", () => {
    const r = fresh().exec(`jq -cn '$ARGS.positional' --jsonargs 1 '"x"' true`);
    assert.equal(r.stdout, '[1,"x",true]\n');
});

test("--arg and --args together populate both $ARGS fields", () => {
    const r = fresh().exec("jq -cn '$ARGS' --arg k v --args a b");
    assert.equal(r.stdout, '{"positional":["a","b"],"named":{"k":"v"}}\n');
});

test("missing --arg operand errors with exit 2", () => {
    const r = fresh().exec("jq -n --arg x");
    assert.equal(r.stderr, "jq: --arg takes two parameters (e.g. --arg varname value)\n");
    assert.equal(r.exitCode, 2);
});

// ---- string interpolation ----

test("string interpolation", () => {
    const r = fresh().exec(`echo '{"name":"world"}' | jq -r '"hello \\(.name)!"'`);
    assert.equal(r.stdout, "hello world!\n");
});

// ---- errors ----

test("filter parse error exits 3", () => {
    const r = fresh().exec(`echo '{}' | jq '.foo['`);
    assert.equal(r.exitCode, 3);
});

test("malformed JSON input exits 2", () => {
    const r = fresh().exec(`echo 'not json' | jq '.'`);
    assert.equal(r.exitCode, 2);
});

test("multiple JSON documents on stdin are each filtered", () => {
    const r = fresh().exec(`printf '1\\n2\\n3\\n' | jq '. * 10'`);
    assert.equal(r.stdout, "10\n20\n30\n");
});
