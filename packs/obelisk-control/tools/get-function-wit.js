// cloud.tenant operation get-function-wit:
//   func(ffqn: string) -> result<string, string>
import { targetBase, targetToken } from "./target.js";

export default async function get_function_wit(ffqn) {
    if (!ffqn) throw "ffqn is required";
    const base = targetBase();
    const resp = await fetch(
        `${base}/v1/functions/wit?ffqn=${encodeURIComponent(ffqn)}`,
        { headers: { accept: "text/plain", authorization: `Bearer ${targetToken()}` } },
    );
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    return await resp.text();
}
