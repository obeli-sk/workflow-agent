#!/usr/bin/env node

// Adapter over the agent-server socket: queue an operator message into a running
// session's container. server.js merges queued messages into the agent's next
// user turn, so an operator can steer or interrupt a running agent. Delivery
// happens at the next send boundary (not truly mid-LLM-response).
//
// Return type (deployment.toml): result<u32, string> - ok = queue depth.
//
// Exec-activity result protocol: exit 0 + stdout JSON is the ok value; exit 1 +
// stdout JSON is the err value.

import net from "node:net";

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
  const socketPath = parseJsonArg(2, "socket");
  const text = parseJsonArg(3, "text");
  if (typeof text !== "string" || !text.trim()) failPermanent("text must be a non-empty string");

  const response = await request(socketPath, { op: "inject", text });
  if (!response.ok) fail(response.error || "inject failed");
  writeOk((response.queued | 0) || 0);
}

main().catch((error) => fail(error.message));
