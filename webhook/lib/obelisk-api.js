// Obelisk access for the webhook: read-only REST fetches plus the native
// mutation host calls.
//
// The UI polls statuses, responses and logs every few seconds; routing every
// read through a child activity (one execution per call) flooded the server with
// thousands of short executions. A webhook can speak to the Obelisk REST API
// directly, so these GETs run as plain fetches. Mutations (pause/unpause/cancel/
// stub) stay as durable native `webapi` calls.

import * as webapi from "obelisk-agent:tools/webapi";
import { activityJson } from "./http.js";

const API_BASE = (process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005").replace(/\/$/, "");
const OBELISK_API_TOKEN = process.env["OBELISK__API__TOKEN"];
if (!OBELISK_API_TOKEN) throw new Error("OBELISK__API__TOKEN is required");

async function apiGet(label, path, accept = "application/json") {
    let resp;
    try {
        resp = await fetch(`${API_BASE}${path}`, {
            headers: { accept, authorization: `Bearer ${OBELISK_API_TOKEN}` },
        });
    } catch (e) {
        throw new Error(`${label}: ${String(e)}`);
    }
    const text = await resp.text();
    if (!resp.ok) throw new Error(`${label}: HTTP ${resp.status}: ${text}`);
    return text;
}

async function apiGetJson(label, path) {
    return activityJson(label, await apiGet(label, path));
}

export async function listExecutions(
    ffqnPrefix,
    executionIdPrefix,
    showDerived,
    hideFinished,
    length,
) {
    const params = [];
    if (ffqnPrefix) params.push(`ffqn_prefix=${encodeURIComponent(ffqnPrefix)}`);
    if (executionIdPrefix) params.push(`execution_id_prefix=${encodeURIComponent(executionIdPrefix)}`);
    if (showDerived) params.push("show_derived=true");
    if (hideFinished) params.push("hide_finished=true");
    params.push(`length=${encodeURIComponent(String(length || 20))}`);
    return apiGetJson("list-executions", `/v1/executions?${params.join("&")}`);
}

export async function getExecutionStatus(id) {
    return apiGetJson(`get-execution ${id}`, `/v1/executions/${encodeURIComponent(id)}/status`);
}

export async function getExecutionRecord(id) {
    return apiGetJson(`get-execution-record ${id}`, `/v1/executions/${encodeURIComponent(id)}`);
}

export async function getExecutionEvents(id, cursorKind, cursor, includingCursor, length) {
    const kind = cursorKind === "version_from" ? "version_from" : "version";
    const version = Number.isFinite(cursor) && cursor > 0 ? Math.trunc(cursor) : 0;
    const params = [
        `${kind}=${encodeURIComponent(String(version))}`,
        `including_cursor=${includingCursor ? "true" : "false"}`,
        `length=${encodeURIComponent(String(length || 200))}`,
    ];
    return apiGetJson(`get-events ${id}`, `/v1/executions/${encodeURIComponent(id)}/events?${params.join("&")}`);
}

export async function getExecutionResponses(id, cursor, includingCursor, length) {
    const current = Number.isFinite(cursor) && cursor > 0 ? Math.trunc(cursor) : 0;
    const params = [
        `cursor=${encodeURIComponent(String(current))}`,
        `including_cursor=${includingCursor ? "true" : "false"}`,
        `length=${encodeURIComponent(String(length || 200))}`,
    ];
    return apiGetJson(`get-responses ${id}`, `/v1/executions/${encodeURIComponent(id)}/responses?${params.join("&")}`);
}

export async function getLatestExecutionResponses(id, length) {
    return apiGetJson(
        `get-latest-responses ${id}`,
        `/v1/executions/${encodeURIComponent(id)}/responses?direction=older&length=${encodeURIComponent(String(length || 50))}`,
    );
}

export async function getExecutionLogs(id, showDerived, cursor, includingCursor, length) {
    const params = [
        `show_derived=${showDerived ? "true" : "false"}`,
        "show_logs=true",
        "show_streams=true",
    ];
    if (cursor) params.push(`cursor=${encodeURIComponent(cursor)}`);
    params.push("direction=newer");
    if (includingCursor) params.push("including_cursor=true");
    params.push(`length=${encodeURIComponent(String(length || 200))}`);
    return apiGetJson(`get-logs ${id}`, `/v1/executions/${encodeURIComponent(id)}/logs?${params.join("&")}`);
}

export async function getDeployment(id) {
    return apiGetJson(`get-deployment ${id}`, `/v1/deployments/${encodeURIComponent(id)}`);
}

export async function currentDeploymentId() {
    return apiGetJson("current-deployment-id", "/v1/deployment-id");
}

export async function readBlob(digest) {
    return apiGet(`read-blob ${digest}`, `/v1/files/${encodeURIComponent(digest)}`, "text/plain");
}

export function pauseObeliskExecution(id) {
    return webapi.pauseExecution(id);
}

export function unpauseObeliskExecution(id) {
    return webapi.unpauseExecution(id);
}

export function cancelObeliskExecution(id) {
    return webapi.cancelExecution(id);
}

export function stubObeliskExecution(id, result) {
    return webapi.stubExecution(id, JSON.stringify(result));
}
