// Builtin command registry + dispatch. Full command-set parity with
// vendor/just-bash-rs/src/commands/*.rs is landed — see
// docs/js-backend-migration.md for the tracker and any noted scope gaps
// (jq/awk are deliberately-scoped subsets, not full implementations).

import { core, ok, fail, unknownOption } from "./core.js";
import { fsutil } from "./fsutil.js";
import { base64Command, md5sumCommand, sha256sumCommand } from "./hash.js";
import { cutCommand, trCommand, revCommand } from "./text.js";
import { findCommand } from "./find.js";
import { xargsCommand } from "./xargs.js";
import { diffCommand } from "./diff.js";
import { sedCommand } from "./sed.js";
import { grepCommand, egrepCommand, fgrepCommand } from "./grep.js";
import { sortCommand, uniqCommand } from "./sort_uniq.js";
import { jqCommand } from "./jq.js";
import { awkCommand } from "./awk.js";
import { dateCommand, exprCommand, sleepCommand, timeoutCommand, timeCommand } from "./timeutil.js";
import {
    commCommand,
    joinCommand,
    nlCommand,
    odCommand,
    foldCommand,
    expandCommand,
    unexpandCommand,
    columnCommand,
    pasteCommand,
    stringsCommand,
    splitCommand,
} from "./textutil2.js";

export const BUILTIN_NAMES = [
    "echo", "printf", "pwd", "cd", "true", "false", ":",
    "export", "unset", "read", "test", "[", "exit",
    "set", "shift", "break", "continue",
    "date", "sleep", "seq", "which", "env", "printenv", "whoami", "hostname",
    "help", "clear", "alias", "unalias", "basename", "dirname", "source", ".",
    "ls", "cat", "mkdir", "touch", "rm", "rmdir", "cp", "mv",
    "wc", "head", "tail", "sort", "uniq", "tee", "stat",
    "chmod", "readlink", "ln", "file", "du", "tree",
    "grep", "egrep", "fgrep",
    "base64", "md5sum", "sha256sum", "cut", "tr", "rev", "find", "xargs", "diff", "sed",
    "jq", "awk", "expr", "timeout", "time",
    "comm", "join", "nl", "od", "fold", "expand", "unexpand", "column", "paste", "strings", "split",
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
    rev: revCommand,
    find: findCommand,
    xargs: xargsCommand,
    diff: diffCommand,
    sed: sedCommand,
    sort: sortCommand,
    uniq: uniqCommand,
    jq: jqCommand,
    awk: awkCommand,
    date: dateCommand,
    sleep: sleepCommand,
    expr: exprCommand,
    timeout: timeoutCommand,
    time: timeCommand,
    comm: commCommand,
    join: joinCommand,
    nl: nlCommand,
    od: odCommand,
    fold: foldCommand,
    expand: expandCommand,
    unexpand: unexpandCommand,
    column: columnCommand,
    paste: pasteCommand,
    strings: stringsCommand,
    split: splitCommand,
};

export function dispatch(interp, args, stdin) {
    const name = args[0];
    const handler = handlers[name];
    if (!handler) return fail(`${name}: command not found\n`, 127);
    return handler(interp, args, stdin);
}

export { ok, fail, unknownOption };
