# Ephemeral shell command workflows

Status: proposal.

This document proposes running every `bash` tool call in a fresh, short-lived
child workflow. A call gets a clean shell and a session-scoped scratch
filesystem. Shell process state does not survive the call. Scratch filesystem
state does, and the Obelisk execution log remains its only durable store.

The goal is to keep shell implementation changes out of the replay path of the
long-lived agent session. A completed command child has a recorded result, so
replaying or upgrading the session consumes that result instead of running the
historical script through a newer interpreter.

## Execution model

The long-lived session workflow becomes a small supervisor:

```text
session workflow
  receives a model or operator shell request
  submits one shell-command child workflow
  joins the recorded child result
  applies the returned scratch delta
  publishes the returned stdout, stderr, and exit code
```

Each shell-command child receives:

```text
script
stdin
current scratch state
```

and returns:

```text
stdout
stderr
exit code
scratch delta
```

The child owns parsing and executing the script, including any durable Obelisk
calls made by shell programs. The parent must not calculate the shell result or
put calculated output into a child request. Its durable request depends only on
the operator or model input and the scratch state produced by earlier recorded
children.

Every call starts with a fixed cwd, clean environment, default shell options,
and no aliases or functions from previous calls. Variables, exports, `cd`,
aliases, functions, and positional parameters remain effective within one
script but disappear when it finishes. Only filesystem changes under
`/scratch` persist. Reusable behavior is stored as a script in `/scratch`, not
as a shell function in memory.

The `bash` tool description must state this contract clearly:

> Each bash call runs in a fresh shell. Variables, cwd, aliases, and functions
> do not persist. Files under `/scratch` persist for the session.

## Scratch state lives in the execution log

Scratch does not require a database, object store, or mutable service outside
the execution history. The session reconstructs its current scratch state by
folding the deltas returned by its completed command children:

```text
S0 = empty scratch
S1 = apply(S0, delta1)
S2 = apply(S1, delta2)
...
```

Before submitting the next command, the parent supplies a compact materialized
view of the current state. The child returns only mutations made by its script.
Both the request and response are durable execution-log data.

The state must be smart about file provenance. It stores file bodies only when
the session created or changed them. Unmodified Obelisk-owned content remains a
lazy reference.

## Filesystem representation

A scratch state consists of tree mounts plus an overlay:

```text
ScratchState {
  mounts: list<TreeRef>
  overlay: map<Path, ScratchEntry>
}

TreeRef {
  mount_path
  deployment_id
  source_path
}

ScratchEntry =
  InlineFile { bytes, executable }
  ObeliskFile { deployment_id, content_digest, byte_size, executable }
  Directory
  Symlink { target }
  Deleted
```

`TreeRef` makes a deployment-backed directory appear in scratch without
copying its file list or bodies into every execution event. It identifies an
immutable deployment and the subtree mounted at a scratch path. The child can
obtain tree metadata through a durable Obelisk call when an operation needs to
list or traverse it.

`ObeliskFile` identifies one file by its deployment and SHA-256 content digest.
It supports metadata operations without fetching the body. Reading it fetches
the content through a durable Obelisk call for that command, but the persistent
scratch entry remains a lazy reference. A read cache is an implementation
detail and is not a scratch mutation.

`InlineFile` contains bytes directly in the execution log. It is used only for
new or modified files whose bodies fit the configured limits. Binary bodies
must use a deterministic encoding such as base64 at the WIT or JSON boundary.

`Deleted` is a tombstone that hides an entry from a mounted tree. Directories,
symlinks, and the executable bit are represented explicitly. Ownership,
timestamps, host inode numbers, and other nondeterministic metadata are not
preserved.

## Lazy copy and materialization

Copying a deployment into scratch must not fetch every source file. It creates
a `TreeRef`:

```text
copy deployment root to /scratch/deployment-edit
  -> TreeRef(Dep_123, "/", "/scratch/deployment-edit")
```

Copying an untouched lazy file within scratch copies its `ObeliskFile`
reference. Renaming it changes only its path. Commands such as `ls`, `find`,
`tree`, `stat`, digest inspection, and deployment verification use metadata
without materializing file bodies.

Writing, appending, or editing a lazy file materializes that file alone. The
child fetches its old body if the operation needs it, computes the new bytes,
and returns an `InlineFile` mutation. Other files under the same deployment
tree remain references.

This matches the current VFS behavior where lazy files carry their digest and
size, reads fetch on demand, and copying a lazy file preserves the reference.

## Scratch deltas

A command result carries an ordered delta rather than another complete tree:

```text
ScratchDelta = list<ScratchMutation>

ScratchMutation =
  MountTree(TreeRef)
  WriteInline { path, bytes, executable }
  WriteObeliskRef { path, deployment_id, content_digest, byte_size, executable }
  CreateDirectory { path }
  CreateSymlink { path, target }
  Rename { from, to }
  SetExecutable { path, executable }
  Delete { path }
```

The parent applies mutations in order to its in-memory materialized state. On
replay it receives the same recorded child deltas and reconstructs the same
state without executing old shell scripts.

The next stateless child must still receive enough state to read every changed
file. Therefore inline bodies may be repeated in later child request
parameters. Without storage outside the execution log, that repetition is
unavoidable. Deployment-owned files avoid it because their stable digest
references are sufficient. The design relies on changed scratch content being
small and explicitly bounded.

## Commit and failure behavior

Scratch changes are transactional at the child-workflow boundary. The parent
applies a delta only from a completed child result.

A normal shell exit, including a nonzero exit code, commits its filesystem
changes. This matches ordinary shell behavior where a command can write a file
before returning failure. A platform failure that prevents the child from
returning produces no new scratch state in the parent.

Durable calls already made by a failed child remain in that child's history.
Retry and replay behavior for the child follows normal Obelisk workflow rules.
Moving commands to children limits the affected history, but does not permit
nondeterministic changes to an in-flight command workflow.

The session supervisor serializes scratch-mutating commands. Each request uses
the state resulting from the previous completed command, so concurrent operator
and model inputs cannot publish competing scratch generations.

## Limits

The implementation must reject a mutation before publishing it when it would
exceed configured limits. At minimum, limits cover:

- Bytes in one inline file.
- Total inline bytes in the materialized scratch state.
- Number of overlay entries.
- Number and length of mutations returned by one command.
- Path length and directory depth.
- Symlink target length.

Lazy `TreeRef` and `ObeliskFile` bodies do not count toward inline byte limits,
but their metadata entries count toward structural limits when materialized in
the overlay. Error messages must identify the exceeded limit and the affected
path.

## Deployment editing

The active deployment view should be read-only and reconstructed fresh for
each command. An editable checkout belongs in scratch:

```text
/workspace/deployment         read-only active deployment
/scratch/deployment-edit      persistent deployment-backed tree plus overlay
```

Creating the editable checkout adds one deployment `TreeRef`. Editing a source
adds an inline override for that path. Deleting a source adds a tombstone.
Submitting the edited deployment walks the reference tree plus overlay, reuses
the original digests for unchanged sources, and sends bodies only for changed
sources.

## Determinism boundary

This design protects the long-lived session from changes to parsing, expansion,
builtins, `jq`, `sort`, and shell-result formatting. The parent history records
a stable child request followed by a child response. Once that child has
completed, replaying the parent does not run its script again.

The command child remains a workflow because shell programs may make durable
Obelisk calls. A plain activity is insufficient for arbitrary shell execution.
Pure commands could be activities internally, but that does not change the
parent-child contract described here.

The isolation also keeps shell process state deliberately out of the durable
contract. The only cross-command state is the normalized scratch filesystem.

## Tradeoffs

- The shell model is simpler, but users and models cannot rely on `cd`, exports,
  aliases, or functions persisting across calls.
- Changed inline files are repeated in subsequent child inputs unless Obelisk
  later gains execution-log value references.
- Every command creates another execution and adds submission and join latency.
- Deployment metadata may be fetched again by separate child workflows.
- The session supervisor becomes substantially less sensitive to interpreter
  changes, while an in-flight command child can still require replay-compatible
  code.

These costs are acceptable if scratch remains bounded and most large files are
immutable Obelisk references. The resulting execution model is explicit: a
fresh temporary shell for every call, with a small, durable filesystem overlay
as the only shared state.
