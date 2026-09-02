import { test } from "node:test";
import assert from "node:assert/strict";
import { Bash } from "../bash.js";

function projectEnv() {
    const bash = new Bash({ cwd: "/project" });
    bash.vfs.mkdirp("/project");
    for (const [path, content] of [
        ["/project/README.md", "# Project"],
        ["/project/src/index.ts", "export {}"],
        ["/project/src/utils/helpers.ts", "export function helper() {}"],
        ["/project/src/utils/format.ts", "export function format() {}"],
        ["/project/tests/index.test.ts", "test"],
        ["/project/package.json", "{}"],
        ["/project/tsconfig.json", "{}"],
    ]) {
        bash.vfs.writeFile(path, content);
    }
    return bash;
}

test("finds all files and directories in preorder, sorted", () => {
    const bash = projectEnv();
    const r = bash.exec("find /project");
    assert.equal(
        r.stdout,
        "/project\n" +
        "/project/README.md\n" +
        "/project/package.json\n" +
        "/project/src\n" +
        "/project/src/index.ts\n" +
        "/project/src/utils\n" +
        "/project/src/utils/format.ts\n" +
        "/project/src/utils/helpers.ts\n" +
        "/project/tests\n" +
        "/project/tests/index.test.ts\n" +
        "/project/tsconfig.json\n",
    );
    assert.equal(r.exitCode, 0);
});

test("-name filters by glob pattern", () => {
    const r = projectEnv().exec('find /project -name "*.ts"');
    assert.equal(
        r.stdout,
        "/project/src/index.ts\n/project/src/utils/format.ts\n/project/src/utils/helpers.ts\n/project/tests/index.test.ts\n",
    );
});

test("-type f and -type d", () => {
    const r = projectEnv().exec("find /project -type d");
    assert.equal(r.stdout, "/project\n/project/src\n/project/src/utils\n/project/tests\n");
});

test("predicates combine with implicit AND", () => {
    const r = projectEnv().exec('find /project -name "*.ts" -type f');
    assert.equal(
        r.stdout,
        "/project/src/index.ts\n/project/src/utils/format.ts\n/project/src/utils/helpers.ts\n/project/tests/index.test.ts\n",
    );
});

test("relative search preserves the ./ prefix", () => {
    const r = projectEnv().exec('find . -name "*.md"');
    assert.equal(r.stdout, "./README.md\n");
});

test("nonexistent path errors without aborting other paths", () => {
    const r = projectEnv().exec("find /nonexistent");
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "find: /nonexistent: No such file or directory\n");
    assert.equal(r.exitCode, 1);
});

test("unknown predicate errors", () => {
    const r = projectEnv().exec("find /project -unknown");
    assert.match(r.stderr, /find: unknown predicate '-unknown'/);
    assert.equal(r.exitCode, 1);
});
