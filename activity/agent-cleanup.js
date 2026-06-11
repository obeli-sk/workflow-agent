#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import { spawnSync } from "node:child_process";

function now() { return new Date().toISOString(); }
function log(message) { console.error(`[${now()}] ${message}`); }

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

function failPermanent(message) {
  console.error(`permanent: ${message}`);
  process.stdout.write(JSON.stringify(message));
  process.exit(1);
}

function isMissingContainer(result) {
  const text = `${result.stderr || ""}\n${result.stdout || ""}`;
  return text.includes("No such container");
}

function runDocker(args, { allowFailure = false } = {}) {
  const result = spawnSync("docker", args, { encoding: "utf-8" });
  if (result.error) {
    if (result.error.code === "ENOENT") failPermanent("docker executable not found in PATH");
    fail(`docker ${args.join(" ")} failed: ${result.error.message}`);
  }
  if (result.status !== 0 && !allowFailure) {
    fail(`docker ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result;
}

function bestEffortShutdown(socketPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(socketPath)) return resolve();
    const socket = net.createConnection(socketPath, () => {
      socket.write(JSON.stringify({ op: "shutdown" }));
      socket.end();
    });
    let buf = "";
    socket.on("data", (chunk) => { buf += chunk; });
    socket.on("close", () => resolve());
    socket.on("error", () => resolve());
    setTimeout(() => { try { socket.destroy(); } catch (_) {} resolve(); }, 2000).unref();
  });
}

async function main() {
  const containerName = parseJsonArg(2, "container-name");
  const socketPath = parseJsonArg(3, "socket");
  if (!containerName) failPermanent("container-name must not be empty");
  if (!socketPath) failPermanent("socket must not be empty");

  log(`cleanup start container=${containerName} socket=${socketPath}`);

  try {
    log(`shutdown begin socket=${socketPath}`);
    await bestEffortShutdown(socketPath);
    log(`shutdown end socket=${socketPath}`);
  } catch (e) {
    log(`shutdown failed socket=${socketPath} error=${e.message}`);
  }

  log(`docker rm begin container=${containerName}`);
  const result = runDocker(["rm", "-f", containerName], { allowFailure: true });
  log(`docker rm end container=${containerName} status=${result.status}`);
  if (result.status !== 0 && !isMissingContainer(result)) {
    fail(`docker rm -f ${containerName} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  try {
    fs.unlinkSync(socketPath);
    log(`socket unlinked socket=${socketPath}`);
  } catch (_) {
    log(`socket unlink skipped socket=${socketPath}`);
  }
  try {
    fs.unlinkSync(`${socketPath}.system-prompt.md`);
    log(`system prompt unlinked socket=${socketPath}`);
  } catch (_) {
    log(`system prompt unlink skipped socket=${socketPath}`);
  }

  writeOk(null);
}

main().catch((error) => fail(error.message));
