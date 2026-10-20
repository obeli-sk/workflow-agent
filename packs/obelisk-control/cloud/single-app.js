// The single-app cloud: without OBELISK_CLOUD_API_TOKEN, the TARGET_OBELISK_*
// server is presented as a cloud holding exactly one app that cannot be
// provisioned, reconfigured or deleted. Its API is the target's own.
import { targetBase, targetToken } from "../tools/target.js";
import { parseToml } from "./toml.js";

// Used when the target's /v1/info names no app.
const FALLBACK_APP_NAME = "target";

export function singleApp() {
    return !process.env["OBELISK_CLOUD_API_TOKEN"] && Boolean(process.env["TARGET_OBELISK_API_URL"]);
}

export async function singleAppName() {
    return (await targetInfo()).appName;
}

// The target's /v1/info: its app name, and whether it answered.
async function targetInfo() {
    let info = null;
    try {
        const resp = await fetch(`${targetBase().replace(/\/+$/, "")}/v1/info`, {
            headers: { accept: "application/json", authorization: `Bearer ${targetToken()}` },
        });
        info = resp.ok ? JSON.parse(await resp.text()) : null;
    } catch {
        info = null;
    }
    const name = info?.app_name;
    return { appName: typeof name === "string" && name !== "" ? name : FALLBACK_APP_NAME, reachable: info !== null };
}

// `app_name` of an app.toml, or null; lenient, since only the name matters here.
export function policyAppName(policy) {
    let name = null;
    try {
        name = policy === null ? null : parseToml(policy).app_name;
    } catch {
        name = null;
    }
    return typeof name === "string" && name !== "" ? name : null;
}

// The app row, shaped like the provisioner's.
export async function singleAppRow() {
    const { appName, reachable } = await targetInfo();
    const webhook = process.env["TARGET_OBELISK_WEBHOOK_URL"];
    return {
        app_name: appName,
        status: reachable ? "running" : "unreachable",
        api_url: process.env["TARGET_OBELISK_API_URL"].replace(/\/+$/, ""),
        webhook_url: webhook ? webhook.replace(/\/+$/, "") : null,
    };
}

// Throws unless `name` is the single app; returns its name.
export async function requireSingleApp(name) {
    const appName = await singleAppName();
    if (name && name !== appName) {
        throw `This cloud has a single app, ${appName}; there is no app ${name}. Use --app ${appName}`;
    }
    return appName;
}

export function refusal(command, appName) {
    return `\`cloud ${command}\` is not available: this cloud has a single fixed app (${appName}) that cannot be created, reconfigured, started, stopped or deleted. Ask the user to change it`;
}
