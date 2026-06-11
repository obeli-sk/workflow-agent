#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const IMAGE_NAME = process.env.AGENT_IMAGE || "ghcr.io/obeli-sk/obelisk-agent-server:latest";
const START_TIMEOUT_MS = 60000;
const POLL_INTERVAL_MS = 250;
const CONTAINER_SOCKET_DIR = "/sockets";

function parseJsonArg(index, name) {
  const raw = process.argv[index];
  if (raw === undefined) failPermanent(`missing argument: ${name}`);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
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

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

function inspectContainer(name) {
  const r = runDocker(["inspect", name, "--format", "{{json .State}}"], { allowFailure: true });
  if (r.status !== 0) {
    if (isMissingContainer(r)) return null;
    return { inspectError: r.stderr.trim() || r.stdout.trim() };
  }
  try { return JSON.parse(r.stdout.trim()); }
  catch (e) { return { inspectError: `invalid inspect output: ${e.message}` }; }
}

function getContainerLogs(name) {
  const r = runDocker(["logs", name], { allowFailure: true });
  if (r.status !== 0 && isMissingContainer(r)) return "container no longer exists";
  return (r.stdout + r.stderr).trim() || "no container logs";
}

function waitForSocket(containerName, socketPath) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) {
      console.error(`Agent socket ready: ${socketPath}`);
      return;
    }
    const state = inspectContainer(containerName);
    if (state && (state.inspectError || state.Running === false)) {
      const details = state.inspectError
        ? state.inspectError
        : `running=${state.Running} status=${state.Status} exitCode=${state.ExitCode} error=${state.Error || ""}`.trim();
      const logs = getContainerLogs(containerName);
      fail(`agent container did not create socket ${socketPath}: ${details}\ncontainer logs:\n${logs}`);
    }
    sleep(POLL_INTERVAL_MS);
  }
  const logs = getContainerLogs(containerName);
  fail(`timed out waiting for socket ${socketPath}\ncontainer logs:\n${logs}`);
}

async function main() {
  const containerName = parseJsonArg(2, "container-name");
  const socketPath = parseJsonArg(3, "socket");
  const systemPrompt = parseJsonArg(4, "system-prompt");
  if (!containerName) failPermanent("container-name must not be empty");
  if (!socketPath) failPermanent("socket must not be empty");
  if (!systemPrompt) failPermanent("system-prompt must not be empty");

  // Each backend keeps its auth in a host config dir that we bind-mount into
  // the container. The entrypoint then points the backend CLI at the mount.
  const backend = process.env.AGENT_BACKEND || "claude";
  const AUTH = {
    claude: { envVar: "AGENT_HOST_CLAUDE_DIR", defaultDir: `${process.env.HOME}/.claude`, mount: "/host-claude", hint: "run 'claude' once on the host to log in" },
    codex: { envVar: "AGENT_HOST_CODEX_DIR", defaultDir: `${process.env.HOME}/.codex`, mount: "/host-codex", hint: "run 'codex login' once on the host" },
  }[backend];
  if (!AUTH) failPermanent(`unknown AGENT_BACKEND: ${backend}`);

  const hostAuthDir = process.env[AUTH.envVar] || AUTH.defaultDir;
  if (!hostAuthDir) failPermanent(`${AUTH.envVar} must be set to the host's ${backend} config dir`);
  if (!fs.existsSync(hostAuthDir)) {
    failPermanent(`${AUTH.envVar}=${hostAuthDir} does not exist - ${AUTH.hint}`);
  }

  const socketDir = path.dirname(socketPath);
  const socketBase = path.basename(socketPath);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  if (uid === null || gid === null) failPermanent("cannot determine current uid/gid");

  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(socketDir, 0o700);
  try { fs.unlinkSync(socketPath); } catch (_) {}
  const promptPath = `${socketPath}.system-prompt.md`;
  fs.writeFileSync(promptPath, systemPrompt, { encoding: "utf8", mode: 0o600 });

  const cleanup = runDocker(["rm", "-f", containerName], { allowFailure: true });
  if (cleanup.status !== 0 && !isMissingContainer(cleanup)) {
    fail(`docker rm -f failed: ${cleanup.stderr.trim() || cleanup.stdout.trim()}`);
  }

  const containerSocket = `${CONTAINER_SOCKET_DIR}/${socketBase}`;
  const containerPrompt = `${containerSocket}.system-prompt.md`;
  // Mount the host's auth dir read-write (so token refresh / sessions persist)
  // at the backend's mount point. The entrypoint hand-picks which files the CLI
  // actually sees.
  const args = [
    "run",
    "--detach",
    "--name", containerName,
    "--user", `${uid}:${gid}`,
    "--mount", `type=bind,src=${socketDir},dst=${CONTAINER_SOCKET_DIR}`,
    "--mount", `type=bind,src=${hostAuthDir},dst=${AUTH.mount}`,
    "-e", `${AUTH.envVar}=${AUTH.mount}`,
    "-e", `AGENT_BACKEND=${backend}`,
    "-e", `AGENT_MODEL=${process.env.AGENT_MODEL || ""}`,
    "-e", `AGENT_EXTRA_ARGS=${process.env.AGENT_EXTRA_ARGS || ""}`,
    "-e", `AGENT_SYSTEM_PROMPT_PATH=${containerPrompt}`,
    IMAGE_NAME,
    containerSocket,
  ];

  console.error(`Starting ${backend} agent container ${containerName} from ${IMAGE_NAME}`);
  const result = runDocker(args);

  waitForSocket(containerName, socketPath);

  writeOk({
    container: containerName,
    image: IMAGE_NAME,
    socket: socketPath,
    id: result.stdout.trim(),
  });
}

main().catch((error) => fail(error.message));
