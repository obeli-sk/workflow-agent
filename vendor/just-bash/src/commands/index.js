// Builtin command registry + dispatch. Full parity with
// vendor/just-bash-rs/src/commands/*.rs (awk, jq, hash/timeutil/textutil2
// grab-bags) is still landing — see docs/js-backend-migration.md.

import { core, ok, fail, unknownOption } from "./core.js";
import { fsutil } from "./fsutil.js";
import { base64Command, md5sumCommand, sha256sumCommand } from "./hash.js";
import { cutCommand, trCommand } from "./text.js";
import { findCommand } from "./find.js";
import { xargsCommand } from "./xargs.js";
import { diffCommand } from "./diff.js";
import { sedCommand } from "./sed.js";
import { grepCommand, egrepCommand, fgrepCommand } from "./grep.js";

export const BUILTIN_NAMES = [
    "echo", "printf", "pwd", "cd", "true", "false", ":",
    "export", "unset", "read", "test", "[", "exit",
    "set", "shift", "break", "continue",
    "date", "sleep", "seq", "which", "env", "printenv", "whoami", "hostname",
    "help", "clear", "basename", "dirname", "source", ".",
    "ls", "cat", "mkdir", "touch", "rm", "rmdir", "cp", "mv",
    "wc", "head", "tail", "sort", "uniq", "tee", "stat",
    "grep", "egrep", "fgrep",
    "base64", "md5sum", "sha256sum", "cut", "tr", "find", "xargs", "diff", "sed",
];

const handlers = {
    ...core,
    ...fsutil,
    grep: grepCommand,
    egrep: egrepCommand,
    fgrep: fgrepCommand,
    base64: base64Command,
    md5sum: md5sumCommand,
    sha256sum: sha256sumCommand,
    cut: cutCommand,
    tr: trCommand,
    find: findCommand,
    xargs: xargsCommand,
    diff: diffCommand,
    sed: sedCommand,
};

export function dispatch(interp, args, stdin) {
    const name = args[0];
    const handler = handlers[name];
    if (!handler) return fail(`${name}: command not found\n`, 127);
    return handler(interp, args, stdin);
}

export { ok, fail, unknownOption };
