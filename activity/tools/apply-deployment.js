#!/usr/bin/env node

// Schedule the actual hot redeploy out of process. A synchronous /switch call
// from an activity deadlocks because the switch closes and joins the executor
// that is currently running that activity. The workflow treats this as a
// terminal tool, cleans up its agent session, and exits before this detached
// process begins the switch.

import { spawn } from "node:child_process";

function parseJsonArg(index, name) {
  const raw = process.argv[index];
  if (raw === undefined) fail(`missing argument: ${name}`);
  try { return JSON.parse(raw); }
  catch (e) { fail(`invalid JSON argument for ${name}: ${e.message}`); }
}

function fail(message) {
  console.error(message);
  process.stdout.write(JSON.stringify(message));
  process.exit(1);
}

const deploymentId = parseJsonArg(2, "deployment-id");
if (typeof deploymentId !== "string" || !deploymentId) fail("deployment-id is required");

const base = process.env.OBELISK_API_URL || "http://127.0.0.1:5005";
const script = `
const [base, deploymentId] = process.argv.slice(1);
setTimeout(async () => {
  try {
    const response = await fetch(
      base + "/v1/deployments/" + encodeURIComponent(deploymentId) + "/switch",
      {
        method: "PUT",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ hot_redeploy: true }),
      },
    );
    if (!response.ok) process.exitCode = 1;
  } catch (_) {
    process.exitCode = 1;
  }
}, 5000);
`;

const child = spawn(process.execPath, ["-e", script, base, deploymentId], {
  detached: true,
  stdio: "ignore",
});
child.unref();
process.stdout.write(JSON.stringify("switch_scheduled"));
