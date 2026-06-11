#!/usr/bin/env node

// Adapter over the agent-server socket. It stays alive for the whole agent
// turn, polling the container internally and streaming every native event to
// stderr. This gives Obelisk one durable recv execution per turn instead of
// one child execution per poll.
//
// Return type (deployment.toml):
//   result<variant { working, reply(variant {
//            final(string),
//            tool-calls(list<record { name: string, arguments-json: string }>),
//          }) },
//          variant {
//            permanent-rate-limited(record { retry-after-seconds: u32, message: string }),
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

  while (true) {
    const response = await request(socketPath, { op: "recv", timeout_ms: timeoutMs });
    if (!response.ok) fail(response.error || "recv failed");

    // Persist native events as they arrive so the UI can show live progress.
    if (Array.isArray(response.raw)) {
      for (const ev of response.raw) console.error(`[raw] ${JSON.stringify(ev)}`);
    }

    switch (response.outcome) {
      case "working":
        continue;
      case "reply":
        // turn-outcome::reply(agent-reply); server.js already shaped reply as
        // { final } | { tool_calls: [{ name, arguments_json }] }
        return writeOk({ reply: response.reply });
      case "rate_limited": {
        const rl = response.rate_limit || {};
        return emitErr(
          { permanent_rate_limited: { retry_after_seconds: rl.retry_after_seconds, message: rl.message } },
          `rate limited: ${rl.message} (retry after ${rl.retry_after_seconds}s)`,
        );
      }
      case "exited":
        return emitErr({ permanent_agent_exited: response.error || "agent exited" }, response.error || "agent exited");
      case "error":
        return emitErr({ permanent_error: response.error || "reply error" }, response.error || "reply error");
      default:
        return fail(`unknown recv outcome: ${response.outcome}`);
    }
  }
}

main().catch((error) => fail(error.message));
