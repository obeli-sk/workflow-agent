#!/usr/bin/env node

import net from "node:net";

async function readParams() {
  if (process.argv.length > 2) {
    return [
      parseJsonArg(2, "socket"),
      parseJsonArg(3, "input"),
      parseJsonArg(4, "operator-messages"),
    ];
  }
  const raw = await readStdin();
  if (!raw.trim()) failPermanent("missing stdin params envelope");
  let envelope;
  try { envelope = JSON.parse(raw); }
  catch (e) { failPermanent(`invalid JSON stdin params envelope: ${e.message}`); }
  if (!envelope || !Array.isArray(envelope.params)) {
    failPermanent('stdin params envelope must be {"params":[...]}');
  }
  if (envelope.params.length !== 3) {
    failPermanent(`expected 3 params, got ${envelope.params.length}`);
  }
  return envelope.params;
}

function parseJsonArg(index, name) {
  const raw = process.argv[index];
  if (raw === undefined) failPermanent(`missing argument: ${name}`);
  try { return JSON.parse(raw); }
  catch (e) { failPermanent(`invalid JSON argument for ${name}: ${e.message}`); }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

function writeOk(value) { process.stdout.write(JSON.stringify(value)); }

function fail(message) {
  console.error(message);
  process.stdout.write(JSON.stringify(message));
  process.exit(1);
}

function failPermanent(message) {
  console.error(`permanent: ${message}`);
  process.stdout.write(JSON.stringify(message));
  process.exit(1);
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
  const [socketPath, input, operatorMessages] = await readParams();
  if (typeof socketPath !== "string" || !socketPath) {
    failPermanent("socket must be a non-empty string");
  }
  // input is the common agent-input variant: { prompt } | { tool_results }.
  const valid = input && typeof input === "object" &&
    (typeof input.prompt === "string" || Array.isArray(input.tool_results));
  if (!valid) failPermanent("input must be { prompt } or { tool_results }");
  if (!Array.isArray(operatorMessages) ||
      operatorMessages.some((text) => typeof text !== "string" || !text.trim())) {
    failPermanent("operator-messages must contain only non-empty strings");
  }

  const response = await request(socketPath, {
    op: "send",
    input,
    operator_messages: operatorMessages.map((text) => text.trim()),
  });
  if (!response.ok) fail(response.error || "send failed");
  writeOk(null);
}

main().catch((error) => fail(error.message));
