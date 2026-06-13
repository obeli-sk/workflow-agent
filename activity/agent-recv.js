#!/usr/bin/env node

// Adapter over the agent-server socket. It stays alive for the whole agent
// turn, polling the container internally and streaming every native event to
// stderr. This gives Obelisk one durable recv execution per turn instead of
// one child execution per poll.
//
// Return type (deployment.toml):
//   result<variant { working, reply(record {
//            reply: variant {
//              final(string),
//              error(string),
//              tool-calls(list<record { name: string, arguments-json: string }>),
//            },
//            presentation: string,
//            narration: string,
//          }) },
//          variant {
//            permanent-rate-limited(record { retry-after-seconds: u32, message: string }),
//            permanent-malformed-reply(string),
//            permanent-agent-exited(string),
//            permanent-error(string),
//            transient-error(string),
//            execution-failed,
//          }>
//
// Exec-activity result protocol: exit 0 + stdout JSON is the ok value; exit 1 +
// stdout JSON is the err value. Variant cases JSON-encode as {"case_name": payload}
// (no-payload case = bare "case_name"); cases containing "permanent" are not
// retried by Obelisk.

import net from "node:net";

function findMatchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === "\"") { inString = !inString; continue; }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function stripActionEnvelopes(text) {
  let output = "";
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== "{") {
      output += text[cursor];
      cursor += 1;
      continue;
    }
    const end = findMatchingBrace(text, cursor);
    if (end === -1) {
      output += text.slice(cursor);
      break;
    }
    const slice = text.slice(cursor, end + 1);
    let isEnvelope = false;
    try {
      const value = JSON.parse(slice);
      isEnvelope = value && typeof value === "object"
        && (Array.isArray(value.tool_calls) || typeof value.final === "string"
          || typeof value.error === "string");
    } catch (_) {}
    if (!isEnvelope) output += slice;
    cursor = end + 1;
  }
  return output.replace(/```(?:json)?\s*```/g, "").trim();
}

// Older agent-server images know only final/tool_calls and therefore classify
// a clean {"error":"..."} envelope as final prose. Normalize that shape here
// so the typed workflow protocol can be upgraded before every runner image is.
function normalizeReply(reply) {
  if (!reply || typeof reply !== "object" || typeof reply.final !== "string") {
    return reply;
  }
  let body = reply.final.trim();
  const fence = body.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence) body = fence[1].trim();
  try {
    const value = JSON.parse(body);
    if (value && typeof value === "object" && typeof value.error === "string"
      && Object.keys(value).length === 1) {
      return { error: value.error };
    }
  } catch (_) {}
  return reply;
}

function parseJsonArg(index, name) {
  const raw = process.argv[index];
  if (raw === undefined) failPermanent(`missing argument: ${name}`);
  try { return JSON.parse(raw); }
  catch (e) { failPermanent(`invalid JSON argument for ${name}: ${e.message}`); }
}

function writeOk(value) { process.stdout.write(JSON.stringify(value)); }

function emitErr(variant, log) {
  console.error(log);
  process.stdout.write(JSON.stringify(variant));
  process.exit(1);
}

// transient-error: Obelisk retries per max_retries (socket hiccups).
function fail(message) {
  emitErr({ transient_error: message }, message);
}

// permanent-error: bad inputs / protocol violations that will not succeed on retry.
function failPermanent(message) {
  emitErr({ permanent_error: message }, `permanent: ${message}`);
}

function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath, () => {
      socket.write(JSON.stringify(payload));
      socket.end();
    });
    let buf = "";
    socket.on("data", (chunk) => { buf += chunk; });
    socket.on("close", () => {
      try { resolve(JSON.parse(buf.trim())); }
      catch (e) { reject(new Error(`bad socket response: ${buf}`)); }
    });
    socket.on("error", reject);
  });
}

async function main() {
  const socketPath = parseJsonArg(2, "socket");
  const timeoutMs = parseJsonArg(3, "timeout-ms");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    failPermanent("timeout-ms must be a non-negative number");
  }

  let finalAgentMessage = "";
  while (true) {
    const response = await request(socketPath, { op: "recv", timeout_ms: timeoutMs });
    if (!response.ok) fail(response.error || "recv failed");

    // Persist native events as they arrive so the UI can show live progress.
    if (Array.isArray(response.raw)) {
      for (const ev of response.raw) {
        console.error(`[raw] ${JSON.stringify(ev)}`);
        if (ev?.type === "item.completed" && ev.item?.type === "agent_message"
          && typeof ev.item.text === "string") {
          finalAgentMessage = ev.item.text;
        }
      }
    }

    switch (response.outcome) {
      case "working":
        continue;
      case "reply":
        // turn-outcome::reply(record { reply, narration }); server.js shaped
        // reply as { final } | { error } |
        // { tool_calls: [{ name, arguments_json }] } and
        // narration as the model's prose/thinking for this turn.
        return writeOk({
          reply: {
            reply: normalizeReply(response.reply),
            presentation: Array.isArray(response.reply?.tool_calls)
              ? stripActionEnvelopes(finalAgentMessage)
              : "",
            narration: response.narration || "",
          },
        });
      case "rate_limited": {
        const rl = response.rate_limit || {};
        return emitErr(
          { permanent_rate_limited: { retry_after_seconds: rl.retry_after_seconds, message: rl.message } },
          `rate limited: ${rl.message} (retry after ${rl.retry_after_seconds}s)`,
        );
      }
      case "exited":
        return emitErr({ permanent_agent_exited: response.error || "agent exited" }, response.error || "agent exited");
      case "malformed":
        // Reply didn't parse as the envelope. Permanent (no activity retry: the
        // buffered turn text is fixed), but recoverable by the workflow, which
        // re-prompts the agent to re-emit a valid envelope.
        return emitErr({ permanent_malformed_reply: response.error || "reply did not match envelope" }, response.error || "malformed reply");
      case "error":
        return emitErr({ permanent_error: response.error || "reply error" }, response.error || "reply error");
      default:
        return fail(`unknown recv outcome: ${response.outcome}`);
    }
  }
}

main().catch((error) => fail(error.message));
