// cloud.tenant operation get-result-json:
//   func(execution-id: string) -> result<string, string>
import { targetBase, targetToken } from "./target.js";

export default async function get_result_json(executionId) {
    if (!executionId) throw "execution-id is required";
    const base = targetBase();
    const resp = await fetch(
        `${base}/v1/executions/${encodeURIComponent(executionId)}?follow=true`,
        { headers: { accept: "application/json", authorization: `Bearer ${targetToken()}` } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
