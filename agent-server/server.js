#!/usr/bin/env node

// Provider-specific normalizer. Spawns the configured agent backend and
// translates its native event stream into the common agent protocol below, so
// the host activities, the workflow, and the UI never parse LLM JSON.
//
// Two backends, selected by AGENT_BACKEND:
//   - claude: one persistent `claude -p --input-format stream-json ...` process;
//     each turn is a user message written to its stdin; events stream out
//     continuously and a turn ends at a `result` event.
//   - codex: `codex exec --json` per turn, continued across turns with
//     `codex exec resume <thread_id> --json`. codex runs its full tool loop
//     within each turn; a turn ends at `turn.completed` / `turn.failed`. The
//     codex session is persisted under $CODEX_HOME (host-mounted ~/.codex).
//
// Socket protocol: each connection writes one JSON line, half-closes, reads one
// JSON line back.
//
//   { "op": "send", "input": { "prompt": "..." } }
//   { "op": "send", "input": { "tool_results": [{ "name", "outcome": {ok|err} }] } }
//      Renders the common agent-input into one user message, begins a new turn.
//
//   { "op": "recv", "timeout_ms": 30000 }
//      Polls the current turn. Returns { "ok": true, "outcome": ..., "raw": [...] }
//      where outcome is one of:
//        "working"                                  turn still streaming
//        "reply",      reply: {final}|{tool_calls}  turn complete, parsed reply
//        "rate_limited", rate_limit: {retry_after_seconds, message}
//        "exited",     error: string                backend died mid-turn
//        "error",      error: string                reply did not match envelope
//      "raw" carries the native events seen since the last poll, for the
//      activity to echo to its stderr (debugging only; not in the typed return).
//
//   { "op": "status" }    Diagnostics.
//   { "op": "shutdown" }  Best-effort graceful shutdown.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

const SOCKET_PATH = process.argv[2];
if (!SOCKET_PATH) {
  console.error("usage: server.js <socket-path>");
  process.exit(2);
}

const BACKEND = process.env.AGENT_BACKEND || "claude";
const MODEL = process.env.AGENT_MODEL || "";
const EXTRA = (process.env.AGENT_EXTRA_ARGS || "").trim();
const SYSTEM_PROMPT_PATH = process.env.AGENT_SYSTEM_PROMPT_PATH;
if (!SYSTEM_PROMPT_PATH) {
  console.error("AGENT_SYSTEM_PROMPT_PATH is required");
  process.exit(2);
}

// ---- shared event buffer ----------------------------------------------------

// All native events emitted by the backend(s), in arrival order.
const events = [];
// Number of events already returned to a recv() caller (for the raw stderr echo).
let consumed = 0;
// Index in `events` where the current turn's events begin (set on each send).
let turnStart = 0;
// Number of turns sent so far (the codex backend prepends the system prompt on
// turn 0 and switches to `exec resume` afterward).
let turnCount = 0;

// Parse a child's stdout as newline-delimited JSON, pushing each event onto the
// shared buffer. `onEvent` lets a backend react to events as they arrive.
function attachStdout(child, onEvent) {
  let buf = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); }
      catch (e) { parsed = { type: "_unparseable", raw: line, parse_error: e.message }; }
      events.push(parsed);
      if (onEvent) onEvent(parsed);
    }
  });
}

function attachStderr(child, label) {
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label} stderr] ${chunk}`));
}

function writeLine(child, line) {
  return new Promise((resolve, reject) => {
    child.stdin.write(line + "\n", (err) => (err ? reject(err) : resolve()));
  });
}

// ---- shared parsing helpers -------------------------------------------------

function tryParse(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch (_) { return value; }
}

// Render the common `agent-input` into the user-message text. `prompt` is sent
// verbatim; `tool_results` is serialized into the JSON envelope the system
// prompt instructs the model to expect.
function renderUserText(input) {
  if (input && typeof input.prompt === "string") return input.prompt;
  if (input && Array.isArray(input.tool_results)) {
    const results = input.tool_results.map((tr) => {
      const outcome = tr && tr.outcome;
      if (outcome && "ok" in outcome) return { name: tr.name, ok: tryParse(outcome.ok) };
      return { name: tr.name, err: outcome ? outcome.err : "error" };
    });
    return JSON.stringify({ tool_results: results });
  }
  return null;
}

// Map a parsed envelope to the common agent-reply shape:
//   { final: string } | { tool_calls: [{ name, arguments_json }] }, or null.
function envToReply(env) {
  if (!env) return null;
  if (typeof env.final === "string") return { final: env.final };
  if (Array.isArray(env.tool_calls)) {
    return {
      tool_calls: env.tool_calls.map((c) => ({
        name: c && typeof c.name === "string" ? c.name : "",
        arguments_json: JSON.stringify(c && typeof c.args === "object" && c.args !== null ? c.args : {}),
      })),
    };
  }
  return null;
}

// The model occasionally writes a prose preamble before the JSON envelope. We
// accept that, but only if the envelope is the trailing content, to avoid
// treating `{"final": ...}` quoted inside explanatory prose as the reply.
function extractEnvelope(text) {
  const trimmed = (text || "").trim();
  if (trimmed.startsWith("{")) {
    try { return JSON.parse(trimmed); } catch (_) {}
  }
  if (!trimmed.endsWith("}")) return null;
  for (const marker of ['{"final":', '{"tool_calls":']) {
    const startIdx = trimmed.lastIndexOf(marker);
    if (startIdx === -1) continue;
    const endIdx = findMatchingBrace(trimmed, startIdx);
    if (endIdx === trimmed.length - 1) {
      try { return JSON.parse(trimmed.substring(startIdx, endIdx + 1)); } catch (_) {}
    }
  }
  return null;
}

function findMatchingBrace(s, start) {
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

// Concatenated text of the last claude assistant message in a turn slice.
function lastAssistantText(turnSlice) {
  for (let i = turnSlice.length - 1; i >= 0; i -= 1) {
    const e = turnSlice[i];
    if (!e || e.type !== "assistant") continue;
    const content = e.message && e.message.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join("");
    if (text) return text;
  }
  return "";
}

// Text of the last codex `agent_message` item in a turn slice. A codex turn can
// emit several agent_message items (preambles between tool calls); the final
// one carries the envelope.
function lastCodexAgentMessage(turnSlice) {
  for (let i = turnSlice.length - 1; i >= 0; i -= 1) {
    const e = turnSlice[i];
    if (e && e.type === "item.completed" && e.item && e.item.type === "agent_message"
      && typeof e.item.text === "string") {
      return e.item.text;
    }
  }
  return "";
}

// Parse "... resets 3:50pm (UTC)" into seconds from now until that UTC time.
// Falls back to one hour when the reset time is missing or unparseable.
const DEFAULT_RETRY_AFTER_SECONDS = 3600;
const RESET_BUFFER_SECONDS = 30;

function secondsUntilReset(message) {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\s*\(?\s*UTC\s*\)?/i.exec(message || "");
  if (!m) return DEFAULT_RETRY_AFTER_SECONDS;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3] ? m[3].toLowerCase() : null;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return DEFAULT_RETRY_AFTER_SECONDS;
  const now = new Date();
  const target = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0,
  ));
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  const seconds = Math.ceil((target.getTime() - now.getTime()) / 1000) + RESET_BUFFER_SECONDS;
  return seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
}

function looksRateLimited(message) {
  return /\b(429|too many requests|rate limit|usage limit|quota|session limit)\b/i.test(message || "");
}

// ---- claude backend (one persistent process) --------------------------------

function makeClaudeBackend() {
  let child = null;
  let exited = false;
  let exitInfo = null;

  return {
    name: "claude",
    init() {
      const systemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
      // We intentionally do NOT pass --json-schema: it injects a synthetic
      // StructuredOutput tool plus a stop hook that doubles every assistant
      // message. The system prompt alone defines the envelope.
      const args = [
        "-p",
        "--input-format", "stream-json",
        "--output-format", "stream-json",
        "--verbose",
      ];
      if (MODEL) args.push("--model", MODEL);
      args.push("--append-system-prompt", systemPrompt);
      if (EXTRA) args.push(...EXTRA.split(/\s+/));
      console.error(`[server] spawning claude (model=${MODEL || "default"}, ${systemPrompt.length}B prompt)`);
      child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      attachStdout(child);
      attachStderr(child, "claude");
      child.on("exit", (code, signal) => {
        exited = true; exitInfo = { code, signal };
        console.error(`[server] claude exited code=${code} signal=${signal}`);
      });
      child.on("error", (err) => {
        exited = true; exitInfo = { code: null, signal: null, error: err.message };
        console.error(`[server] claude spawn error: ${err.message}`);
      });
    },
    async send(text /*, turnIndex */) {
      if (exited) throw new Error("claude has exited");
      const event = { type: "user", message: { role: "user", content: [{ type: "text", text }] } };
      await writeLine(child, JSON.stringify(event));
    },
    isTerminator(ev) { return !!ev && ev.type === "result"; },
    classify(turnSlice, termEv) {
      if (termEv.is_error === true && termEv.api_error_status === 429) {
        const message = typeof termEv.result === "string" && termEv.result ? termEv.result : "session limit reached";
        return { kind: "rate_limited", rate_limit: { retry_after_seconds: secondsUntilReset(message), message } };
      }
      const text = typeof termEv.result === "string" && termEv.result ? termEv.result : lastAssistantText(turnSlice);
      const reply = envToReply(extractEnvelope(text));
      if (!reply) return { kind: "error", error: `reply did not match envelope: ${text.slice(0, 500)}` };
      return { kind: "reply", reply };
    },
    isFatallyExited() { return exited; },
    exitInfo() { return exitInfo; },
    shutdown() { try { child.stdin.end(); } catch (_) {} try { child.kill("SIGTERM"); } catch (_) {} },
    status() { return { exited, exit: exitInfo }; },
  };
}

// ---- codex backend (one `codex exec` process per turn) ----------------------

function makeCodexBackend() {
  let threadId = null;
  let turnChild = null;
  let turnTerminated = false;
  // Resolves when the previous turn's process has fully closed. A turn's session
  // file is only flushed to $CODEX_HOME on close, so the next `exec resume` must
  // wait for it or it resumes a half-written session and runs an empty turn.
  let prevClose = Promise.resolve();

  return {
    name: "codex",
    init() {
      fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8"); // fail fast if missing
      console.error(`[server] codex backend ready (model=${MODEL || "config default"})`);
    },
    async send(text, turnIndex) {
      // Wait for the previous turn's process to fully close (session flushed)
      // before resuming, otherwise resume loads a half-written session.
      await prevClose;

      // Prepend the system prompt on the first turn only; codex exec has no
      // --append-system-prompt, so it rides along in the first user message.
      let prompt = text;
      if (turnIndex === 0) {
        const sp = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
        prompt = `${sp}\n\n# User request\n${text}`;
      }

      const args = ["exec"];
      if (threadId) args.push("resume", threadId);
      args.push("--json", "--skip-git-repo-check");
      if (!threadId) {
        // First turn: open the sandbox/approvals so codex can run its tools
        // unattended (the container is the real sandbox). resume inherits this.
        args.push("--dangerously-bypass-approvals-and-sandbox");
        if (MODEL) args.push("-m", MODEL);
        if (EXTRA) args.push(...EXTRA.split(/\s+/));
      }
      args.push("-"); // read the prompt from stdin (avoids argv length limits)

      console.error(`[server] codex exec ${threadId ? `resume ${threadId}` : "(new session)"} turn=${turnIndex}`);
      const ch = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      turnChild = ch;
      turnTerminated = false;
      attachStdout(ch, (ev) => {
        if (ev && ev.type === "thread.started" && typeof ev.thread_id === "string") threadId = ev.thread_id;
        if (ev && (ev.type === "turn.completed" || ev.type === "turn.failed")) turnTerminated = true;
      });
      attachStderr(ch, "codex");
      // Resolve prevClose on `close` (not `exit`): close fires only after stdout
      // has fully drained, so the real terminator line is parsed and the session
      // file is flushed before the next resume runs.
      prevClose = new Promise((resolve) => {
        ch.on("close", (code, signal) => {
          console.error(`[server] codex turn closed code=${code} signal=${signal}`);
          // If the process died without a terminating event, synthesize one so
          // recv resolves the turn as an error instead of hanging.
          if (!turnTerminated) {
            events.push({ type: "turn.failed", error: { message: `codex exited code=${code} signal=${signal}` } });
          }
          resolve();
        });
      });
      ch.on("error", (err) => {
        events.push({ type: "turn.failed", error: { message: `codex spawn error: ${err.message}` } });
      });
      ch.stdin.write(prompt);
      ch.stdin.end();
    },
    isTerminator(ev) { return !!ev && (ev.type === "turn.completed" || ev.type === "turn.failed"); },
    classify(turnSlice, termEv) {
      if (termEv.type === "turn.failed") {
        const message = (termEv.error && termEv.error.message) || "codex turn failed";
        if (looksRateLimited(message)) {
          return { kind: "rate_limited", rate_limit: { retry_after_seconds: secondsUntilReset(message), message } };
        }
        return { kind: "error", error: message };
      }
      const text = lastCodexAgentMessage(turnSlice);
      const reply = envToReply(extractEnvelope(text));
      if (!reply) return { kind: "error", error: `reply did not match envelope: ${(text || "").slice(0, 500)}` };
      return { kind: "reply", reply };
    },
    // Per-turn process exits are normal; only an unterminated turn is fatal, and
    // that is surfaced via the synthetic turn.failed event above.
    isFatallyExited() { return false; },
    exitInfo() { return null; },
    shutdown() { try { if (turnChild) turnChild.kill("SIGTERM"); } catch (_) {} },
    status() { return { thread_id: threadId }; },
  };
}

const backend = BACKEND === "codex" ? makeCodexBackend() : makeClaudeBackend();
backend.init();

// ---- socket ops -------------------------------------------------------------

async function opSend({ input }) {
  const text = renderUserText(input);
  if (text === null) return { ok: false, error: "input must be { prompt } or { tool_results }" };
  try {
    turnStart = events.length; // a new turn's events accumulate from here
    await backend.send(text, turnCount);
    turnCount += 1;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Index of the event that terminates the current turn, or -1.
function findTerminator() {
  for (let i = turnStart; i < events.length; i += 1) {
    if (backend.isTerminator(events[i])) return i;
  }
  return -1;
}

async function opRecv({ timeout_ms }) {
  const timeout = Number.isFinite(timeout_ms) && timeout_ms > 0 ? timeout_ms : 30000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const hasNew = events.length > consumed;
    if (findTerminator() !== -1 || backend.isFatallyExited()) break;
    if (hasNew && Date.now() - start > 500) break;
    await sleep(100);
  }

  const raw = events.slice(consumed);
  consumed = events.length;

  const idx = findTerminator();
  if (idx !== -1) {
    const termEv = events[idx];
    const turnSlice = events.slice(turnStart, idx + 1);
    turnStart = idx + 1; // next turn parses from a fresh window
    const c = backend.classify(turnSlice, termEv);
    if (c.kind === "rate_limited") return { ok: true, outcome: "rate_limited", rate_limit: c.rate_limit, raw };
    if (c.kind === "error") return { ok: true, outcome: "error", error: c.error, raw };
    return { ok: true, outcome: "reply", reply: c.reply, raw };
  }

  if (backend.isFatallyExited()) {
    const detail = backend.exitInfo() ? JSON.stringify(backend.exitInfo()) : "unknown";
    return { ok: true, outcome: "exited", error: `agent process exited mid-turn: ${detail}`, raw };
  }
  return { ok: true, outcome: "working", raw };
}

function opStatus() {
  return {
    ok: true,
    backend: BACKEND,
    model: MODEL || null,
    events_total: events.length,
    consumed,
    turn_count: turnCount,
    ...backend.status(),
  };
}

let shuttingDown = false;
async function opShutdown() {
  if (shuttingDown) return { ok: true };
  shuttingDown = true;
  backend.shutdown();
  setTimeout(() => process.exit(0), 200).unref();
  return { ok: true };
}

async function dispatch(line) {
  let cmd;
  try { cmd = JSON.parse(line); }
  catch (e) { return { ok: false, error: `bad json: ${e.message}` }; }
  switch (cmd.op) {
    case "send": return await opSend(cmd);
    case "recv": return await opRecv(cmd);
    case "status": return opStatus();
    case "shutdown": return await opShutdown();
    default: return { ok: false, error: `unknown op: ${cmd.op}` };
  }
}

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  socket.on("error", () => {});
  let buf = "";
  socket.on("data", (chunk) => { buf += chunk; });
  socket.on("end", () => {
    const line = buf.trim();
    if (!line) { socket.destroy(); return; }
    dispatch(line)
      .then((res) => { if (!socket.destroyed) socket.end(JSON.stringify(res) + "\n"); })
      .catch((err) => { if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: err.message }) + "\n"); });
  });
});

fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
try { fs.unlinkSync(SOCKET_PATH); } catch (_) {}

server.listen(SOCKET_PATH, () => {
  try { fs.chmodSync(SOCKET_PATH, 0o600); } catch (_) {}
  console.error(`[server] listening on ${SOCKET_PATH} (backend=${BACKEND})`);
});

function shutdownAndExit(signal) {
  console.error(`[server] received ${signal}, shutting down`);
  opShutdown();
  server.close();
  try { fs.unlinkSync(SOCKET_PATH); } catch (_) {}
}
process.on("SIGTERM", () => shutdownAndExit("SIGTERM"));
process.on("SIGINT", () => shutdownAndExit("SIGINT"));
