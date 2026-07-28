# workflow-agent Rust port: correctness findings

Comparison of the native Rust port (`workflow/workflow-rs` + `vendor/just-bash-rs`)
against the legacy JS workflow (`workflow/agent-loop.js` + `vendor/just-bash`).
Method: identical bash scripts run through both interpreters (TS `just-bash` CLI
vs the `just-bash-rs` `examples/run` binary), plus inspection of a live workflow
execution (`E_01KYKNJ6GXMPVF6DMX1J7H6FJ7`) on the source-built obelisk
(`/workspace/obelisk/target/release/obelisk`, HEAD `b1badaaa`).

Two independent problem areas: the shell interpreter (`just-bash-rs`) and the
obelisk-pack mount (`workflow-rs` + `obelisk_pack.rs`). The mount bug is what the
user saw as "VFS is not working".

## A. obelisk-pack mount: `/workspace` ends up empty (HIGH) — FIXED

Fix: `vendor/just-bash-rs/src/obelisk_pack.rs` now peels the single `call_json`
JSON layer at one boundary helper (`call_value`, mirroring JS `obelisk.call`);
`decode_string`/`decode_json` take the peeled `Value`, and blob bodies use a
new `coerce_text` (JS `String(content)`, no re-parse/trim) rather than routing
through `decode_string`. `json_call` prints a string result verbatim. Mount
errors are surfaced into `/workspace/.mount-error` in
`workflow/workflow-rs/src/session.rs` instead of being discarded. Regression
test `mount_peels_double_quoted_deployment_id_before_checkout` covers the
double-quoted id case. All `just-bash-rs` tests pass; `workflow-rs` builds.

Symptom: a live session shows only a bare `/workspace` with nothing in it. The
VFS itself is fine; the pack mount that seeds `/workspace/deployment/...` fails
silently.

Trace of the child session `E_01KYKNJ6GXMPVF6DMX1J7H6FJ7.g:1_1`:

- `webapi.current-deployment-id` returns OK `"\"Dep_01KYKN3A8MT9GZ6YCJ1DQSCWDQ\""`.
- `webapi.deployment-checkout` is called with params
  `["\"Dep_01KYKN3A8MT9GZ6YCJ1DQSCWDQ\""]` (the id still wrapped in literal
  quotes) and fails:
  `HTTP 400: Cannot parse deployment-id with value "Dep_01KYKN3A8MT9GZ6YCJ1DQSCWDQ": wrong prefix, expected Dep_`.
- Mount aborts at the `?`, the error is discarded, `/workspace/deployment/...` is
  never written.

### Root cause: off-by-one JSON layer at the `call_json` boundary

`current-deployment-id` (`packs/obelisk-control/tools/current-deployment.js`)
does `return await resp.text()` of an `application/json` endpoint, so its WIT
string value is itself JSON: literally `"Dep_..."` (quotes included). Both
runtimes must peel that inner layer, but they receive a different number of
layers:

- JS (`packs/obelisk-control/workflow-pack.js:141-152`): the global
  `obelisk.call` returns the already-deserialized native value (JS string
  `"Dep_..."`), then `decodeString` (`workflow-pack.js:245`, one `JSON.parse`)
  peels the inner quotes to `Dep_...`. Correct.
- Rust (`workflow/workflow-rs/src/host.rs`, `RealHost::call_json`): returns the
  raw JSON-encoded value `"\"Dep_...\""` (one extra layer). `decode_string`
  (`vendor/just-bash-rs/src/obelisk_pack.rs:456`) does a single `from_str`,
  removing only the outer layer and landing on `"Dep_..."` (still quoted). Mount
  re-encodes that into `["\"Dep_...\""]` for checkout, which the server rejects.

The ported `obelisk_pack` decode helpers were written against JS `obelisk.call`
semantics (value pre-parsed once), but `RealHost::call_json` hands them JSON text
(one layer higher). Every consumer of `call_json` in the pack is off by one JSON
layer; `current-deployment-id` is where it bites because its value is a
JSON-string-of-a-JSON-string.

### Contributing issue: silent mount failure

`workflow/workflow-rs/src/session.rs:128` discards the mount result:
`let _ = obelisk_pack::mount(bash.fs_mut(), &mut RealHost);`. Even after the
decode fix, a mount error should not vanish. Suggest writing the error into
`/workspace` (e.g. `/workspace/.mount-error`) so the operator/model sees why the
pack is missing instead of a mysteriously empty workspace.

### Fix direction

1. Reconcile the layer mismatch at the `obelisk_pack` boundary. Cleanest: peel
   the extra `call_json` layer before applying the existing decodeString/
   decodeJson logic. Audit every `host.call_json(...)` consumer in
   `obelisk_pack.rs` (current-deployment-id, deployment-checkout,
   deployment-read-blob, and the `obelisk` shell command) since they share the
   boundary.
2. Surface mount errors instead of swallowing them in `session.rs`.
3. Re-run and confirm `/workspace/deployment/current/` populates.

## B. just-bash-rs interpreter gaps vs the JS reference

Basic VFS ops (write/read, `mkdir -p`, append, `rm`, `mv`, `cp`, glob expansion,
`tree` on simple trees, `grep`/`sed`/`awk`/`wc`/`sort`/`cut`/`find`/heredocs)
match the JS reference. The divergences below are pure interpreter semantics and
each is a real workflow bug (the workflow calls the same `Bash::exec`).

### B1. Cannot run a created script (HIGH) — FIXED

Fix: modelled the execute bit in `Vfs` (`executable` set, `set_executable`/
`is_executable`, cleared on `remove`), wired to `chmod` (`mode_sets_execute`
for octal + symbolic). Added `Interpreter::run_source_captured` /
`run_script_isolated`, and command dispatch for `sh`/`bash` (file or `-c`),
`source`/`.` (current shell), and path invocation (`./x.sh`, `/abs/x.sh`) with
bash's 126/127 diagnostics. Subshell env/cwd isolation for `sh`/`bash`/path;
`source`/`.` persist. Tests in `bash.rs`
(`run_script_by_path_requires_execute_bit`, `run_missing_path_script_is_not_found`,
`sh_and_bash_run_a_script_file_without_execute_bit`,
`source_runs_in_current_shell_but_sh_isolates`). Note: positional parameters
(`$1`, `$@`) remain unmodelled in this port, unchanged by this fix.

### B1 (original). Cannot run a created script (HIGH)

Every way of executing a script the model just wrote fails with
`command not found`:

| script | JS (TS) | Rust |
| --- | --- | --- |
| `chmod +x x.sh; /workspace/x.sh` | runs | `bash: /workspace/x.sh: command not found` |
| `./x.sh` | runs | `command not found` |
| `sh x.sh` / `bash x.sh` | runs | `sh/bash: command not found` |
| `. x.sh` / `source x.sh` | sources | `.: command not found` |
| run a non-exec file | `Permission denied` | `command not found` |

Root cause: command dispatch is a fixed builtin table
(`vendor/just-bash-rs/src/commands/mod.rs:87-180`) with a `command not found`
fallback at `mod.rs:180`. There is no path-execution branch (interpret a `/...`
or `./...` word as a VFS file, check the exec bit, run it), and no
`sh`/`bash`/`source`/`.` builtins. The exec bit is not modeled.

### B2. fd-duplication redirects are a hard parse error (HIGH) — FIXED

Fix: added `Token::{GreatAnd, LessAnd, IoNumber}` to the lexer (`>&`, `<&`, and
bash's IO_NUMBER rule for a digit-run immediately before a redirect op), a
`Redirect { fd, kind, target: File | Dup }` AST, and `parse_redirect` in the
parser. The interpreter routes fd1/fd2 through an `OutDest` plan
(`route_output`) mutated in source order, so `2>&1`, `>&2`, `1>&2`, `2>file`,
`> f 2>&1`, and `2>&1 >f` all behave. Tests in `bash.rs`
(`redirect_stdout_to_stderr`, `redirect_stderr_to_stdout_merges`,
`redirect_stderr_to_a_file`, `redirect_both_streams_to_one_file`).

### B2 (original). fd-duplication redirects are a hard parse error (HIGH)

`2>&1`, `>&2`, `1>&2` abort the entire script with
`bash: syntax error: expected a filename after a redirection`, standalone and in
pipelines. Very common in model-written scripts.

Root cause: `vendor/just-bash-rs/src/parser.rs:679-689` only accepts `<`/`>`/`>>`
followed by a filename `Word`; there is no `&fd` target handling, so `&1` trips
the error at `parser.rs:688`.

### B3. `tree` (and `ls`) sort order (MEDIUM; user's "tree has wrong output") — FIXED

Fix: added `commands::locale_compare` (case-insensitive primary, lowercase-first
case tie-break, codepoint fallback) approximating JS `localeCompare`, applied to
`ls`'s `readdir` output and `tree`'s entry sort. `a A b` now sorts as `a, A, b`.
Test `ls_and_tree_sort_case_insensitively_lowercase_first` in `bash.rs`.

### B3 (original). `tree` (and `ls`) sort order (MEDIUM; user's "tree has wrong output")

For names `a A b`: JS prints `a, A, b`; Rust prints `A, a, b`.

Root cause: `vendor/just-bash-rs/src/commands/fsutil.rs:771` uses
`a.0.cmp(&b.0)` (raw ASCII, uppercase before lowercase). JS uses `localeCompare`
(`vendor/just-bash/src/commands/tree/tree.ts:178`), case-insensitive with
lowercase-first tie-break. Same fix class applies to `ls`
(`vendor/just-bash/src/commands/ls/ls.ts`).

### B4. `set` builtin missing (MEDIUM) — FIXED

Fix: added a `ShellOptions { errexit, nounset, xtrace, pipefail }` on the
interpreter, persisted across `exec` via `Bash`, and a `set` builtin
(`-`/`+` short flags, `-o name`, and the `-euo pipefail` combined form; unknown
flags/operands accepted silently so a leading `set -euo pipefail` never aborts).
Implemented: pipefail (last non-zero stage) in `run_pipeline`; errexit in
`run`/`run_block` with the tested-context exceptions (`if`/`while` conditions,
short-circuited `&&`/`||`, `!`); nounset via `lookup_field`; xtrace to the
shell's stderr. Tests in `bash.rs` (`set_pipefail_reports_failing_pipeline_stage`,
`set_errexit_stops_on_failure_with_the_usual_exceptions`,
`set_nounset_errors_on_unset_variable`, `set_xtrace_prints_commands_to_stderr`).

### B4 (original). `set` builtin missing (MEDIUM)

`set -e`, `set -o pipefail`, `set -u`, `set -x` all give
`set: command not found`, and pipefail semantics do not apply
(`false | true; echo $?` gives `0` in Rust vs `1` in JS with pipefail). No `set`
entry in the builtin table.

### B5. `ls -l` / `ls -la` ignore flags (MEDIUM) — FIXED

Fix: rewrote `builtin_ls` with `-l` (long format: `total N`,
`-rw-r--r--`/`drwxr-xr-x`, byte size, fixed `1 user user Jan  1 00:00` as the
JS reference does since the VFS tracks no owner/mtime) and `-a` (`.`/`..` plus
dotfiles). Without `-a`, dotfiles are now hidden (previously always shown).
Tests `ls_long_format_lists_mode_size_and_total`, `ls_hides_dotfiles_unless_all_flag`.

### B5 (original). `ls -l` / `ls -la` ignore flags (MEDIUM)

`ls -l dir` prints bare names in Rust; JS prints the long
`total N` / `-rw-r--r-- ...` format. `ls -a` also omits the `.`/`..` entries.
Agents parse `ls -la` output.

### B6. `ls` on multiple glob args (LOW, cosmetic) — FIXED

Fix: `builtin_ls` now renders each target as a block and joins multiple blocks
with a blank line (test `ls_multiple_dirs_separated_by_blank_line`). Folded into
the B5 rewrite.

### B6 (original). `ls` on multiple glob args (LOW, cosmetic)

JS separates each expanded arg's listing with a blank line; Rust concatenates.

## Suggested priority

1. A (mount decode + surface error): unblocks the workspace entirely.
2. B2 (redirect parser) and B1 (script execution): each aborts whole scripts.
3. B4 (`set`), B3 (`tree`/`ls` sort), B5 (`ls -l`).
4. B6 (cosmetic).

## Status

All findings above are FIXED (see each section). `just-bash-rs` unit tests
pass (415) and `workflow/workflow-rs` builds; clippy is clean for both.

### Positional parameters — FIXED

Previously unmodelled; now implemented. A script run via `sh x.sh a b`,
`bash x.sh a b`, `./x.sh a b`, or `sh -c SRC name a b` receives `$1..`, `$0`,
`$#`, `$@`, and `$*`; `source file a b` scopes the params to the sourced run
(a bare `source file` keeps the caller's), and `set -- a b` / `set --` /
`shift [n]` work. `"$@"` yields one field per parameter (spaces preserved),
`"$*"` joins with the first IFS char, and unquoted `$@`/`$*` IFS-split. Params
persist across `exec` calls in a session, like `set` options. The parser
accepts `$1`..`$9` (multi-digit needs braces: `${10}`), `$@`, `$*`, `$#`, `$0`.
Tests: `path_script_receives_positional_params`, `sh_dashc_sets_arg0_then_params`,
`quoted_at_keeps_each_param_a_separate_word`, `shift_drops_leading_params`,
`set_dashdash_replaces_positional_params`,
`source_with_args_scopes_params_to_the_sourced_script`.

Simplifications kept (minimal port, consistent with the rest of this file):
a bare `$@`/`$*` mixed with adjacent text in one word (e.g. `"pre$@"`) uses the
space-joined string rather than bash's per-parameter word split; `set -u` does
not fire on unset positional params (see `is_plain_var`); and full
`${@:off:len}` / `${@/pat/rep}` positional operations are not ported.

### C1. `cd` into a missing/non-directory path silently succeeded — FIXED

`builtin_cd` set the cwd unconditionally, so `cd nonexistent` succeeded and
moved the shell into a path that does not exist. Fix: validate each path
component (before `..` collapse) against the VFS, matching the JS reference's
component-wise stat walk, and fail with bash's `bash: cd: TARGET: No such file
or directory` (exit 1) or `... Not a directory` when a component is a file.
`missing/..`, which normalizes back to an existing dir, still fails on the bad
component. Test `cd_into_a_missing_directory_fails_and_keeps_cwd`; two existing
tests that leaned on the old behaviour now `mkdir` their target first.

### C2. `ls -l` shows `-rw-r--r--` for a `chmod +x` file — NOT A BUG (faithful)

Raised as a possible divergence, but the JS reference
(`vendor/just-bash/src/commands/ls/ls.ts`) hardcodes the long-format mode as
`stat.isDirectory ? "drwxr-xr-x" : "-rw-r--r--"` in every code path (lines 198,
348, 545) and never reflects the execute bit in `ls -l`. The port already
matches this exactly, so it is left unchanged: making `ls -l` print
`-rwxr-xr-x` would make the port diverge from the just-bash it replaces. (The
execute bit is observable where the reference exposes it: path execution via
`./x.sh` and the 126 "Permission denied" diagnostic.)
