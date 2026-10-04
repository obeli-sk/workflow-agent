# Local agent-session replay benchmark

Run a published Obelisk binary with the workflow-agent source in this checkout:

```sh
OBELISK=/absolute/path/to/obelisk nix develop -c bash scripts/bench-replay.sh /tmp/replay-results
```

The script creates a separate SQLite database and an empty agent session. It
injects 24 direct shell turns, each generating 2,000 JSON rows, summing values
with `jq`, filtering and sorting text, running a nested Bash script, and
appending to persistent virtual files. It checks every turn's output. It
uses no LLM calls, GitHub mounts, external shell programs, or HTTP tools.

After pausing the session through the public API, it measures one warmup and
nine full replays under JavaScript on V8, JavaScript on Boa in WASM, and the
separate Rust workflow in WASM. All three must replay the same execution,
event count, and log version. Results and metadata go to the output directory;
the isolated database is preserved at the path printed on exit.

`BENCH_TURNS`, `BENCH_API_PORT`, and `BENCH_EXTERNAL_PORT` override the defaults
of 24, 15005, and 19090. `REPLAY_SAMPLER` optionally selects an external replay
sampling script with arguments `RUNTIME API_URL EXECUTION_ID`; otherwise the
repository script samples the replay RPC directly.

This is a scripted Bash/VFS workload. It does not represent a recorded
conversation with an LLM, and it should not be described as the earlier
876-event chat session.
