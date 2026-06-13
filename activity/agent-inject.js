#!/usr/bin/env node

// Queue an operator message into one concrete workflow execution's container.
// Each workflow derives a unique socket from its execution ID, so concurrent
// containers remain isolated. server.js merges queued messages into the agent's
// next user turn. This activity is called by workflow.agent-loop after it
// consumes the durable session.injection stub; the UI never calls it directly.
//
// Return type (deployment.toml): result<u32, string> - ok = queue depth.
//
// Exec-activity result protocol: exit 0 + stdout JSON is the ok value; exit 1 +
// stdout JSON is the err value.

import net from "node:net";

function sessionSocketPath(executionId) {
  const sessionId = String(executionId).replace(/[^A-Za-z0-9_.-]/g, "-");
  return `/tmp/obelisk-agent/${sessionId}.sock`;
}

function parseJsonArg(index, name) {
  const raw = process.argv[index];
  if (raw === undefined) failPermanent(`missing argument: ${name}`);
  try { return JSON.parse(raw); }
  catch (e) { failPermanent(`invalid JSON argument for ${name}: ${e.message}`); }
}

function writeOk(value) { process.stdout.write(JSON.stringify(value)); }

function fail(message) {
  console.error(message);
  process.stdout.write(JSON.stringify(message));
  process.exit(1);
}

function failPermanent(message) { fail(message); }

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
  const executionId = parseJsonArg(2, "execution-id");
  const text = parseJsonArg(3, "text");
  if (typeof executionId !== "string" || !executionId.trim()) {
    failPermanent("execution-id must be a non-empty string");
  }
  if (typeof text !== "string" || !text.trim()) failPermanent("text must be a non-empty string");

  const socketPath = sessionSocketPath(executionId);
  const response = await request(socketPath, { op: "inject", text });
  if (!response.ok) fail(response.error || "inject failed");
  writeOk((response.queued | 0) || 0);
}

main().catch((error) => fail(error.message));
