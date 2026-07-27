# Durable Bash Agent Sessions

## Status

Prototype implemented and validated locally.

Completed:

- Split just-bash's embedded interpreter from its default command registry.
- Built a single-file workflow bundle with an explicit command set.
- Added an in-workflow `obelisk-control` pack module whose command receives the
  live just-bash context.
- Added a session shell event and structured output path.
- Added UI controls for switching between prompt and shell input and an empty
  session creation endpoint.
- Added workflow-safe timer, clock, UTF-8, and explicit command-registry seams.
- Added deterministic Promise draining to Obelisk's JavaScript workflow runtime.
- Use just-bash's complete browser-compatible command catalog in the core rather
  than maintaining a reduced allowlist that can accidentally omit essentials
  such as `chmod`, `stat`, `wc`, `rg`, `awk`, `sort`, `xargs`, or `bash`.
- Keep network commands and non-browser runtimes out of the core. External I/O
  crosses a durable pack boundary, while Python, Node.js, tar, yq, xan, and
  SQLite require runtimes that workflow JavaScript does not provide. The gzip,
  gunzip, and zcat commands are also excluded because they depend on Node zlib;
  ordinary `rg` remains available, without compressed-file search.
- Open the operator input channel before pack mounting, so an empty session is
  ready for shell exploration without a first prompt.
- Pin JavaScript wall-clock reads (`Date.now()`, `new Date()`, and `Date()`) to
  the workflow's logical epoch at the start of the bundled module. just-bash
  already receives the same logical clock explicitly, and this avoids recording
  dozens of durable `sleep(now)` calls during filesystem initialization.
- Race the outstanding operator offer and the LLM completion in one durable
  join set. Shell events execute against the live VFS while the LLM child is
  pending, and prompt events are inserted into message history for the next
  model turn.
- Detect a terminal session with no transcript in the UI, show its actual
  workflow outcome, and avoid guessing which server capability caused it.
- Validated async pack commands, durable VFS replay, deployment mounting, direct
  shell input, cross-event file persistence, and structured shell output against
  a local Obelisk server.

Validated flow:

1. Create an empty long-running session.
2. Mount the active deployment at `/workspace/deployment/<deployment-id>` and
   point `/workspace/deployment/current` to it.
3. Run a shell event that creates `note.txt`, reads it, lists the mounted
   deployment, and reads its `deployment.toml`.
4. Run another shell event after replay that reads the same `note.txt`.
5. Run `obelisk deployment current` in that event. The pack executable calls a
   real Obelisk activity and its result is combined with normal shell output.

Current prototype boundaries:

- It mounts only the active deployment, not the last several deployments.
- It eagerly fetches each owned source blob during session startup. Lazy bodies
  and a batched checkout API remain follow-up work.
- It exposes source blobs stored by Obelisk. Source that is not part of the
  deployment, such as Rust source behind an OCI component, needs another pack or
  backing repository.
- Mount edits are ordinary mutable session files. Dirty-path tracking and safe
  refresh conflict handling are not implemented yet.
- The browser uses a command form and transcript, not a TTY or file browser.
- just-bash has no job table or asynchronous statement execution. Job-control
  names are not advertised as builtins, and the workflow rejects statements
  terminated by `&` instead of treating them as durable background execution.
- Production use requires an Obelisk workflow JS runtime containing the Promise
  drain added by this prototype. A stock runtime treats the async entry point as
  an immediate empty return, which is the concrete failure seen in execution
  `E_01KYG2QXGE8PFBDFT8TWJ8YQ2E`.

The target architecture is feasible. The prototype adds the required embedding
layer to `just-bash` and the required Promise handling to Obelisk. The agent
session, Bash interpreter, virtual filesystem, and chat history now live in one
long-running workflow, while packs expose external systems as executables inside
that shell.

## Goals

- Expose one model-facing tool, `bash`.
- Keep virtual filesystem changes for the lifetime of an agent session.
- Reconstruct filesystem state deterministically when Obelisk replays a
  workflow.
- Let users run Bash commands before, during, and after agent turns.
- Give the user and the agent the same shell and filesystem.
- Split the application into a generic core and independently selectable packs.
- Let packs contribute copy-on-write directories to the virtual filesystem.
- Make pack capabilities available as Bash executables that can read and write
  explicitly scoped parts of that filesystem.
- Preserve durable calls, retries, cancellation, human gates, and inspection
  through Obelisk.

## Non-goals for the first version

- A POSIX terminal with job control, signals, or an interactive TTY.
- Concurrent mutations of one virtual filesystem.
- Arbitrary native binaries.
- Full `just-bash` command coverage.
- Python, QuickJS, SQLite, compression, archive, worker, or network commands.
- Transparent access to host files.
- Filesystem checkpointing or session migration.

## Architecture

```text
web UI
  |
  | session events: shell, prompt, cancel, human response
  v
long-running session workflow
  |
  +-- just-bash interpreter
  |     +-- in-memory filesystem
  |     +-- deterministic core commands
  |     +-- in-workflow pack executables
  |
  +-- provider-neutral message history
  +-- agent loop
  +-- one model-facing `bash` tool
  +-- structured session output recorder
  |
  +-- compiled pack modules
  |     +-- system prompts
  |     +-- just-bash custom commands
  |     +-- VFS mounts and seed files
  |
  v
external pack activities
  +-- HTTP, secrets, retries, and external side effects
```

The session workflow is the owner of all mutable session state. It serializes
filesystem mutations, but keeps one LLM child and one operator input offer
pending together. An operator shell event can therefore run while the external
LLM child is pending without introducing concurrent VFS mutations. Pack command
adapters run inside that workflow and receive the same live filesystem as
built-in Bash commands.

## Session lifecycle

1. Construct the Bash instance and its in-memory filesystem.
2. Create one named session join set and submit the first operator-input stub.
3. Mount installed packs into the VFS.
4. If there is no initial prompt, block on the operator offer. Shell events run
   immediately; prompt events start an LLM completion.
5. Submit LLM completion into the same join set as the next operator offer.
6. If shell input completes first, re-arm operator input, execute the command,
   record its structured output, and continue waiting for the same LLM child.
7. If prompt input completes first, re-arm operator input and queue the text
   immediately after the assistant response and any required tool result.
8. If the LLM child completes first, process its response and keep the operator
   offer pending throughout tool execution and the following wait.

The runtime must await the Promise returned by the workflow entry point. This is
not optional for the architecture: just-bash and its filesystem interface are
Promise-based even when an individual operation is in-memory. The sibling
Obelisk change now uses Boa's `JsPromise::await_blocking` and includes a
regression test with 128 nested awaits.

## Durable filesystem model

The initial implementation should keep one `Bash` and one `InMemoryFs` instance
in the session workflow. A file edit is ordinary workflow memory, not an
external side effect.

Durability comes from replay:

1. Session inputs are recorded as completed stub executions.
2. External activity and workflow calls made by pack commands are recorded as
   child executions.
3. Pure Bash computation and filesystem mutations are repeated during replay.
4. Recorded child results are returned during replay without repeating the
   external operation.

No whole-session filesystem checkpoint is required for correctness in the first
version. Recovery work grows with the session history, so the core must enforce
limits on source size, output size, command work, file count, and total file
bytes. Checkpointing can be added after the session semantics are stable.

## Core and pack boundary

### Core responsibilities

The core owns:

- Session lifecycle and event processing.
- The Bash interpreter and virtual filesystem.
- The single model-facing `bash` tool.
- Provider-neutral chat history and the LLM adapters.
- Registration of pack executables as custom Bash commands.
- Operator input, human gates, cancellation, and structured output recording.
- The web API and UI.
- Generic limits and security policy.

The core must not contain Obelisk-control-specific command parsing or HTTP
routes.

### Pack responsibilities

A pack owns:

- Its system prompt and shell usage guidance.
- Its in-workflow just-bash custom commands.
- Its virtual filesystem mounts and seed files.
- The external data used to populate those mounts.
- Executable argument parsing and help text.
- Activities and workflows that communicate with external systems.
- Allowed hosts, credentials, retries, and idempotency policy.
- Any approval gates required before risky operations.

The first pack remains `obelisk-control`.

### Pack descriptor

Packs are JavaScript modules compiled into the session workflow bundle. A
deployment determines the installed pack set. Session configuration can enable
a subset of installed packs, but it cannot load new executable code dynamically.

A pack exports metadata and an installer:

```javascript
export const descriptor = {
  name: "obelisk-control",
  systemPrompt: "Use the obelisk executable to inspect and control Obelisk.",
};

export function installPack(host) {
  host.registerCommand(obeliskCommand);
  host.mount("/workspace/deployment", createDeploymentFs(host));
}
```

The first implementation uses the smaller equivalent module surface
`descriptor`, `commands()`, and `mount(fs)`. A generic `installPack(host)`
registry is the natural next step when a second pack is added.

`host` is an in-workflow capability object supplied by the core. It exposes only
the pack installation operations the core supports, such as command
registration and mounting. The installed command itself receives just-bash's
normal `ResolvedCommandContext` when invoked.

Pack modules may statically import their activity interfaces. Obelisk verifies
those imports when deploying the workflow. Adding or upgrading a pack therefore
creates a new workflow component version, while existing sessions remain pinned
to the version with which they started.

### Pack-provided virtual filesystem

A pack can contribute one or more directories to the session filesystem. For
example, `obelisk-control` can expose:

```text
/workspace/deployment/
  current -> D_01...
  D_01.../
    deployment.toml
    activity/
      llm-chat.js
    workflow/
      agent-loop.js
  D_02.../
    deployment.toml
    ...
```

The exact contents depend on what the backing system can supply. Obelisk's
deployment store can provide its manifest and owned source blobs. Rust source
would require another backing source, such as a repository exposed by the pack.

Mounts are session-pinned and copy-on-write:

1. At session creation, the pack calls an indexing activity. It returns a
   bounded tree of directories, symlinks, files, metadata, and opaque content
   references.
2. The pack builds and mounts a filesystem from that recorded index.
3. File bodies can be lazy. The first read calls the pack's read activity with
   the opaque reference, and Obelisk records the result.
4. A local write replaces or shadows the mounted file in workflow memory.
5. Editing a mounted file never changes the external system by itself.
6. An explicit pack command reads the edited virtual tree and calls submit,
   apply, push, or another external activity.

This gives both the user and agent realistic files to explore with `find`,
`rg`, `sed`, `diff`, and editors while preserving an explicit boundary for
external side effects.

An explicit refresh command may update a mount by returning filesystem
changes from its indexing activity. It must not silently replace local changes.
The first version should reject refresh when affected paths are dirty, unless
the user selects a documented merge or overwrite mode.

### In-workflow executable interface

Pack executables are normal just-bash custom commands. They run in the session
workflow and receive the live command context:

```javascript
const obeliskCommand = defineCommand("obelisk", async (args, ctx) => {
  const path = ctx.fs.resolvePath(ctx.cwd, args.at(-1) || ".");
  const manifest = await ctx.fs.readFile(`${path}/deployment.toml`);
  const result = deploymentSubmit(manifest);
  await ctx.fs.writeFile(`${path}/submitted.json`, JSON.stringify(result));
  return { stdout: JSON.stringify(result) + "\n", stderr: "", exitCode: 0 };
});
```

The real implementation must parse arguments, handle binary content correctly,
and return normal command errors, but it needs no VFS serialization protocol.
It can use `ctx.fs`, `ctx.cwd`, `ctx.env`, `ctx.stdin`, and `ctx.exec` like any
other embedded program.

External operations remain Obelisk activities or child workflows. A pack command
reads the file contents it needs from `ctx.fs`, passes ordinary values to the
external function, receives its recorded result, and may update `ctx.fs`
afterward. The activity never receives the live filesystem object and does not
need to know that the values came from a virtual filesystem.

This permits commands that naturally consume or update several virtual files:

```bash
cd /workspace/deployment/current
rg 'max_retries' .
sed -i 's/max_retries = 3/max_retries = 5/' deployment.toml
obelisk deployment check .
obelisk deployment submit .
```

Pipes and redirections work normally because pack commands implement the same
command interface as built-ins. Direct filesystem reads and writes work
normally because all commands share the same mounted VFS.

### Cross-pack composition

All packs selected for a session contribute commands to one Bash command
namespace and mounts to one virtual filesystem. The user, agent, or a shell
script can therefore compose commands from different packs:

```bash
source-pack export /workspace/data/source.json
transform-pack convert /workspace/data/source.json /workspace/data/result.json
destination-pack import /workspace/data/result.json
```

Pack 1 can also invoke pack 2 through `ctx.exec`:

```javascript
const result = await ctx.exec("destination-pack import result.json", {
  cwd: ctx.cwd,
});
```

The nested command shares the filesystem and the parent execution budget.
just-bash's command, recursion, depth, byte, and time limits must cover the
entire nested call graph so cross-pack cycles terminate predictably.

Packs may also import stable JavaScript helpers from another compiled pack when
they need an API rather than command semantics. Such dependencies should be
declared and cycle-checked by the pack build.

Pipeline filesystem semantics need explicit validation. If just-bash executes
pipeline stages concurrently against one shared filesystem, the core should
either serialize pack stages that can mutate the VFS or document and test a
deterministic copy-and-merge rule. Sequential command composition with `;`,
`&&`, files, and command substitution is sufficient for the first version.

## Model-facing Bash tool

The LLM receives only this tool:

```json
{
  "name": "bash",
  "description": "Run a Bash script in the session's persistent virtual workspace.",
  "input_schema": {
    "type": "object",
    "properties": {
      "script": {
        "type": "string"
      },
      "stdin": {
        "type": "string"
      }
    },
    "required": ["script"]
  }
}
```

The result sent to the model is:

```json
{
  "stdout": "",
  "stderr": "",
  "exit_code": 0
}
```

Multiple Bash calls in one model response must execute serially. The system
prompt should describe available commands, filesystem limits, pack executables,
and how to use `help` or `<executable> --help`.

## Session workflow

Replace the current public workflow plus nested, permanently blocking agent loop
with one session workflow that owns Bash state.

Conceptual event loop:

```javascript
const bash = createSessionBash(pack);
const messages = [];
const input = openSessionInput();

while (true) {
  const event = takeSessionEvent(input);

  if (event.kind === "shell") {
    const result = await bash.exec(event.script, { stdin: event.stdin });
    recordSessionOutput(event.id, result);
    continue;
  }

  if (event.kind === "prompt") {
    messages.push(userText(event.text));
    await runAgentUntilResponse({ bash, messages });
    continue;
  }
}
```

The actual input can initially remain a JSON string returned by a stub:

```json
{
  "id": "client-generated-id",
  "kind": "shell",
  "script": "find . -type f",
  "stdin": ""
}
```

Use one named join set for the session's lifetime and re-arm the input stub after
each consumed event, matching the current operator-channel pattern.

### Input ordering

- Shell and prompt events mutate one session and therefore execute serially.
- The session stores its logical working directory alongside the Bash instance.
  Each command starts there and updates it from the command's resulting `PWD`,
  so `cd` affects later operator and model commands.
- The UI may submit an event while an LLM call or pack command is running.
- That event is accepted by the outstanding stub and processed at the next safe
  workflow boundary.
- The UI renders an accepted shell command optimistically, labels its work as
  shell work rather than agent work, and polls quickly until its durable output
  appears. It derives agent work from completion and transcript state instead of
  treating every runnable workflow state as agent work.
- The composer uses a shell-like prefix instead of a prompt/shell selector.
  Input beginning with `$ ` is a direct shell command; all other input is an
  agent prompt. This also works before a session exists by creating an empty
  session first. After a shell submission, the composer is prefilled with `$ `.
- Shell output shows end-to-end latency from the durable command event to the
  durable output event. Agent output shows end-to-end latency from the initial
  or injected prompt to the final response. Model-originated Bash calls show
  latency from the completion that emitted the tool use to the next durable
  completion request containing its `tool_result`.
- The transcript scrolls to its newest entry when the operator submits input or
  a durable transcript delta arrives. It scrolls again after asynchronous
  Markdown or Mermaid rendering changes the content height.

### Publishing shell results

Pure workflow return values are not independently queryable while the workflow
is still running. After every user-originated shell command, submit a
`session.record-output` stub, immediately fulfil it with `obelisk.stub`, and
consume its successful result from a dedicated join set. The result becomes a
structured, durable child response that the UI can discover through the
existing execution response API, without scheduling an echo activity.

Model-originated Bash results do not need a second record call because they are
already included in the next durable LLM request. They may still be logged as
structured output if the UI needs a uniform transcript.

## UI and HTTP API

Treat a run as a session rather than a single prompt.

### API changes

The prototype exposes:

- `POST /api/sessions`: create a session with model, effort, and pack.
- `POST /api/shell/:id`: queue a shell event.
- `POST /api/say/:id`: queue a prompt event.
- `GET /api/runs/:id`: return chat turns, shell entries, pending events, and
  current execution state.
- Keep pause, unpause, cancel, human answer, and approval endpoints.

The old `/api/submit` route remains as a compatibility path for creating a
session with an initial prompt. Nested `/api/sessions/:id/...` aliases can be
added later if a versioned API cleanup is useful.

### UI layout

Use one session page with:

- Chat transcript.
- Shell transcript and command composer.
- Optional file browser built from shell commands or a read-only session query.
- Model, effort, and pack selectors at session creation.
- Clear working, queued, waiting, paused, and terminal states.

The user should be able to:

1. Create an empty session.
2. Explore or prepare files with Bash.
3. Submit a prompt to the agent.
4. Inspect and edit the same filesystem after the response.
5. Submit another prompt without starting a new workflow.

Do not implement a browser TTY initially. A command form with stdout, stderr,
exit code, and durable history is sufficient.

## Required just-bash work

### 1. Minimal embeddable command registry

The current `commands` option filters the registry at runtime, but the main
registry still contains static imports for all commands. A single-file browser
bundle therefore reaches Node-only and externally loaded dependencies even when
those commands are disabled.

Add an entry point or constructor seam that accepts an explicit command registry
without importing the default registry. The Obelisk bundle should contain only
the selected commands.

Implemented command set:

```text
cat cp echo find grep head jq ls mkdir mv printf pwd rm sed sleep
tail tee touch
```

Add commands only after verifying that their dependency graph is compatible
with a single Boa ES module. In particular, `rg` currently reaches a Node zlib
dependency and is intentionally omitted from the workflow bundle.

### 2. Workflow-safe host timing

just-bash currently uses JavaScript timers for per-command deadlines and cleanup
grace periods. Obelisk workflows reject `setTimeout`.

Add host adapters that allow the embedding environment to provide:

- A clock.
- Sleep.
- Deadline and cancellation behavior.

The Obelisk adapter should:

- Back deliberate shell `sleep` with `obelisk.sleep`.
- Avoid JavaScript timeout jobs.
- Use deterministic work limits for interpreter protection.
- Rely on Obelisk execution cancellation and outer execution limits for the
  hard runtime boundary.
- Use a logical or injected time source for filesystem metadata.

The existing command count, loop, recursion, byte, and output limits remain
enabled.

The prototype implements `sleep` and `now` host hooks. Positive `sleep`
durations call `obelisk.sleep`; internal zero-duration yields resolve without a
workflow event. The session supplies a pure logical `now` function so
interpreter boundary checks do not turn Obelisk's durable `Date.now()` into
dozens of history entries per command.

### 2a. Future durable background jobs

Background jobs cannot be implemented safely by starting an unawaited
`bash.exec()` Promise. Such a Promise is not represented in Obelisk history,
has no durable output channel, and could mutate the live VFS concurrently with
the session loop. Pack commands may also block on durable calls, so a normal
JavaScript microtask scheduler is insufficient.

A future implementation requires structured job control in the session owner:

1. just-bash parses `&` into a job submission instead of silently executing the
   statement as a foreground command.
2. The session assigns deterministic virtual job and process IDs and records a
   job table in workflow memory.
3. Each job writes stdout and stderr to bounded per-job buffers. `jobs` reads
   the table, while `wait` joins a job and publishes its buffered output and
   exit status.
4. Pack operations started by a job use named Obelisk child executions. The
   session scheduler joins those children alongside operator input and LLM
   work, so every suspension and result remains in workflow history.
5. VFS access remains single-writer. Runnable jobs take deterministic turns,
   and no other job or operator command mutates the filesystem during a turn.
6. Replay recreates job IDs, scheduling order, VFS mutations, output, and child
   joins from the recorded session history.

This needs an interpreter suspension seam: a running command must be able to
yield a continuation when it waits for a pack child or durable sleep. The
current synchronous Obelisk workflow-JS calls block inside a just-bash command,
so adding a job table alone would not provide background execution. `fg`, `bg`,
terminal process groups, and signals should remain out of scope until a TTY
model exists.

### 2b. Obelisk workflow Promise support

just-bash uses Promises throughout the interpreter and filesystem, even when an
operation is entirely in memory. Obelisk's JavaScript workflow runtime formerly
serialized a returned Promise without running its deterministic job queue.

The prototype changes the runtime to:

1. Detect a Promise returned by the workflow's default export.
2. Drain the deterministic Promise job queue.
3. Serialize the fulfilled value or propagate the rejection.
4. Continue rejecting timeout jobs.

The Obelisk worker test that previously expected async workflow functions to
fail now verifies that an async function returns its resolved value. This
runtime change is required for the workflow-agent bundle.

### 3. Filesystem export for future checkpointing

Checkpointing is not needed for the first version, but design a public, lossless
snapshot API before sessions become large. It must:

- Snapshot and restore files, including binary contents.
- Snapshot and restore directories and symlinks.
- Preserve modes and modification times.
- Preserve hard-link identity if supported.

Do not reach into the private `InMemoryFs` map from workflow-agent.

### 4. Lazy copy-on-write mounts

Provide or validate a filesystem composition that supports:

- Mounting a pack tree at a virtual absolute path.
- A recorded directory and metadata index.
- Lazy asynchronous file bodies.
- Local copy-on-write edits.
- Dirty-path tracking for safe refresh.

`MountableFs` plus `InMemoryFs` lazy files may provide most of this behavior,
but the final implementation must verify globbing, `find`, symlinks, metadata,
and replay in the Obelisk runtime.

## Obelisk-control executable

Implement one `obelisk` executable rather than registering every current tool
with the model.

Suggested initial subcommands:

```text
obelisk functions list
obelisk functions wit <ffqn>
obelisk executions list
obelisk executions get <execution-id>
obelisk executions logs <execution-id>
obelisk executions result <execution-id>
obelisk call <ffqn>
obelisk deployment current
obelisk deployment refresh [path]
obelisk deployment check [path]
obelisk deployment submit [path]
obelisk deployment switch <deployment-id>
obelisk deployment apply <deployment-id>
```

Subcommands should have stable `--help` output and return machine-readable JSON
by default where composition with `jq` is expected.

Reuse the existing HTTP activities behind the executable. Keep confirmation as
a durable human gate before hot apply. The in-workflow pack command may call
several activities to implement one CLI command.

The target mount should expose recent deployments under
`/workspace/deployment`. `current` should be an absolute VFS symlink to the
session-pinned active deployment. just-bash directory reads must resolve
symlinks in intermediate path components so paths such as `current/activity`
work normally. Deployment commands should accept a directory path and read the
manifest plus owned sources directly from the VFS command context. Commands that
create or fetch deployments should write the corresponding directory through
that same context. Source directories such as `activity/`, `packs/`,
`webhook/`, and `workflow/` reflect the deployment manifest's owned source
locations.

## Security and resource policy

- Register only explicitly selected commands.
- Keep network access disabled in just-bash.
- Route external access through pack executables.
- Never expose Obelisk credentials to Bash or virtual files.
- Enforce maximum script, stdin, stdout, stderr, file, filesystem, and tool
  result sizes.
- Keep pack activities responsible for outbound allowlists and secret
  replacement.
- Treat installed in-workflow packs as trusted code with the same VFS authority
  as other session commands.
- Pass only explicitly selected values and file contents from a pack command to
  its external activities. Activities never receive the VFS capability.
- Add scoped filesystem facades later if untrusted packs become a requirement.
- Preserve confirmation gates for destructive or externally visible actions.
- Do not permit concurrent filesystem mutation.

## Implementation phases

### Phase 0: just-bash compatibility spike

Status: complete for the prototype.

Deliverables:

- Minimal single-file bundle with a small command set.
- Workflow-safe clock, sleep, and deadline adapters.
- A real Obelisk workflow execution that writes a file, reads it in a later
  Bash call, and survives replay.

Acceptance criteria:

- No unresolved module imports.
- No timeout jobs in the workflow runtime.
- `echo hello > note.txt` followed by `cat note.txt` returns `hello`.
- An async custom command can call an Obelisk activity, await its recorded
  result, and then update the live VFS.
- Cancelling the workflow stops the session.
- Replaying the execution produces the same calls and results.

### Phase 1: durable shell session

Status: complete for the prototype.

Deliverables:

- One session workflow with persistent Bash state.
- Session input stub supporting shell events.
- Structured shell-output recorder.
- Minimal shell API and transcript UI.

Acceptance criteria:

- A user can create an empty session and run several commands.
- Files persist between commands.
- Refreshing the UI reconstructs the shell transcript.
- Shell commands are queued and executed in order.

### Phase 2: single-tool agent loop

Status: implemented. Live model behavior was not part of the local runtime
proof because the configured local LLM endpoint was not started.

Deliverables:

- One model-facing `bash` tool.
- Agent turns and interactive shell events sharing one Bash instance.
- Serial execution of multiple model Bash calls.
- Updated system prompt and transcript rendering.

Acceptance criteria:

- The agent creates and edits files through Bash.
- The user can inspect the same files after the assistant response.
- A second prompt observes all earlier file changes.
- Tool errors and non-zero exit codes are visible to both model and user.

### Phase 3: in-workflow packs

Status: partially complete. The pack executable, active deployment mount,
direct VFS access, activity calls, and deployment commands are implemented.
Recent-deployment indexing, lazy files, and dirty refresh handling remain.

Deliverables:

- Pack module and installer interface.
- Build-time pack registry.
- Copy-on-write pack mount support.
- Initial in-workflow `obelisk` command backed by existing pack activities.

Acceptance criteria:

- The model receives only `bash`.
- `obelisk ... | jq ...` works inside the virtual shell.
- Recent deployments appear under `/workspace/deployment`.
- The agent can inspect and edit a deployment tree with ordinary shell
  commands.
- `obelisk deployment check .` and `obelisk deployment submit .` receive the
  edited manifest and owned sources from the VFS.
- Pack commands can read and write the live VFS, and their changes remain
  visible to later shell commands.
- External activity calls remain visible as durable child executions.
- Hot apply still requires operator approval.

### Phase 4: session-focused UI

Status: partially complete. Empty session creation, `$ ` shell dispatch,
durable shell transcript rendering, and the existing lifecycle controls are
present. Pack selection, queued-state polish, and file exploration remain.

Deliverables:

- Session creation independent of the first prompt.
- Chat and shell panels.
- Pack selector.
- Queued and working states.
- Basic file exploration.

Acceptance criteria:

- The complete prepare, prompt, inspect, edit, prompt flow works without
  creating another workflow.
- Reloading the page loses no transcript data.
- Pause, unpause, cancel, ask-user, and confirmation flows still work.

### Phase 5: hardening and scale

Status: pending beyond the focused tests and runtime proof described below.

Deliverables:

- Resource-policy tests.
- Replay and recovery tests.
- Pack executable conformance tests.
- Session-size metrics.
- A checkpoint design based on measured replay costs.

Acceptance criteria:

- Oversized input and output fail predictably.
- Runaway scripts stop through deterministic limits.
- A server restart during a session restores the same filesystem.
- Pack retries do not duplicate operations beyond their documented idempotency
  guarantees.

## Validation strategy

Test behavior through real entry points:

- just-bash unit tests for the new embedding seams.
- Obelisk deployment verification for the bundled workflow.
- Real workflow executions for shell persistence and replay.
- Real pack calls for stdin, stdout, error, retry, and approval behavior.
- Web API tests for event ordering and transcript reconstruction.
- One end-to-end UI flow after the API and workflow semantics stabilize.

Avoid tests that only assert thin descriptor wrappers. Focus on state recovery,
ordering, file transfer, cancellation, and external-call durability.

### Prototype validation results

- just-bash typecheck passed.
- 58 focused just-bash tests passed, covering the embedded registry, nested
  custom command execution, command compatibility, and execution scopes.
- The 879.6 KB workflow bundle rebuilt successfully and all authored JavaScript
  passed syntax checks.
- `obelisk server verify` accepted the deployment.
- The Obelisk async workflow worker test passed with the Promise-capable runtime.
- A local server accepted an empty session, mounted 33 owned source blobs plus
  the deployment manifest, and waited on the operator stub.
- The first shell event returned `hello`, listed the mounted deployment tree,
  and read the manifest.
- The second shell event returned the persisted `hello` and the active
  deployment id from an `obelisk` pack activity call.
- Both shell events produced durable `session.record-output` child executions.
- The webhook returned HTTP 200 for the UI and created an empty session through
  `POST /api/sessions`.
- A latency probe showed that accepting a shell event takes about 64 ms. In the
  exercised session, the durable injection-to-output path took about 4 seconds.
  Fast polling removes up to 3 additional seconds of UI delay, while optimistic
  command rendering gives immediate feedback. A later event-level trace isolated
  a 3.90-second interval between the injected stub finishing and the workflow
  creating `session.record-output`. The workflow was locked immediately, so this
  time is workflow activation and in-memory session reconstruction, including
  re-evaluating the just-bash bundle and rebuilding the mounted VFS. It is not
  the shell command, output stub publication, API polling, or executor
  scheduling.
- Transcript reconstruction must correlate model tool calls and the
  `tool_result` blocks sent back to the model by `tool_use_id`. Positional
  pairing is invalid because pack-mount activities are interleaved in the same
  workflow response history. The prototype once paired a Bash call with the
  startup `deployment-checkout` child and rendered its large `deployment_toml`
  as the Bash result. Completion requests are identified by their target FFQN
  because they share the session's named `operator` join set. Pack-internal
  child payloads are omitted from the transcript API.
- Cancelling the payload-less `agent-loop-cancellable` child is normalized by
  the supervisor to the string error `agent session cancelled`. Transparently
  rethrowing that child error would otherwise produce `err(null)`, which cannot
  satisfy the public workflow's `result<_, string>` return type.

## Main risks

### Replay cost

Each resumed workflow activation reconstructs the just-bash instance and VFS
from durable history. The Replay RPC can still appear fast, but a live trace
shows about 3.90 seconds after the workflow is locked and before it emits the
next output request. Reduce bundle evaluation and mount reconstruction cost, or
introduce a checkpoint/session-host design, before treating direct shell
interaction as low latency. Checkpoints remain useful for bounding
reconstruction work as histories grow.

### Bundle compatibility

Runtime command filtering alone does not remove incompatible modules. Require a
compile-time registry and validate the final single file in the real workflow
runtime.

### Timer incompatibility

Any remaining JavaScript timeout can trap the workflow runtime. Audit the
selected command dependency graph and exercise every host timing path.

### Output-history growth

Large shell output and repeated output recording can grow execution history
quickly. Cap results and encourage files plus targeted `head`, `tail`, `sed`,
`rg`, and `jq` inspection.

### Pack CLI design

A weak CLI will make the single-tool agent less effective than the current
typed catalog. Give every subcommand good help, predictable JSON, actionable
errors, and composable stdin/stdout behavior.

### Pack trust

Compiled pack adapters execute in the workflow and can access session state.
They are trusted application code, not isolated plugins. If third-party packs
are introduced later, add scoped capability facades or move those packs behind
an explicit serialization boundary.

## Implemented vertical slice

The prototype includes:

1. Add the just-bash embedding seams.
2. Bundle the explicit command set listed above.
3. Start an empty session workflow.
4. Accept shell events through a named stub.
5. Record structured shell results.
6. Render those results in the existing UI.
7. Mount the active deployment and expose the `obelisk` pack executable.
8. Keep the LLM-facing surface to one `bash` tool.
9. Verify filesystem persistence, mounted files, pack activity calls, output
   recording, and replay with a real Obelisk execution.

This proves the hardest runtime property: a durable, interactive virtual shell
whose state belongs to one long-running workflow.
