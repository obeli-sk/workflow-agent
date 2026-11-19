class UsageError extends Error {}

export default async function browser(stdin, args) {
    try {
        if (!args.length || args.includes("--help") || args.includes("-h")) return output(help());
        const request = parse(stdin, args);
        const base = process.env["BROWSER_URL"]?.trim();
        if (!base) return output("", 1, "browser: disabled; configure cloud.integrations.browser and BROWSER_URL\n");
        const headers = {};
        if (request.body !== undefined) headers["content-type"] = "application/json";
        if (request.key) headers["idempotency-key"] = request.key;
        const response = await fetch(base.replace(/\/$/, "") + request.path, {
            method: request.method,
            headers,
            body: request.body === undefined ? undefined : JSON.stringify(request.body),
            redirect: "error",
        });
        const text = await response.text();
        if (!response.ok) return output("", 1, `browser: HTTP ${response.status}: ${text}\n`);
        const body = JSON.parse(text);
        if (request.create) {
            if (typeof body.id !== "string" || !body.id) throw new Error("session creation returned no id");
            return output(body.id + "\n");
        }
        const failed = body.results?.some((step) => step.error != null);
        return output(JSON.stringify(body, null, 2) + "\n", failed ? 1 : 0, failed ? "browser: step batch failed; inspect results\n" : "");
    } catch (error) {
        return output("", error instanceof UsageError ? 2 : 1, `browser: ${error.message ?? error}\n`);
    }
}

function parse(stdin, args) {
    if (args[0] === "session") {
        const [, command, ...rest] = args;
        if (command === "create") {
            const body = {};
            if (rest.length) {
                if (rest.length !== 2 || rest[0] !== "--ttl" || !/^[1-9][0-9]*$/.test(rest[1]) || Number(rest[1]) > 0xffffffff) {
                    throw new UsageError("usage: browser session create [--ttl SECONDS]");
                }
                body.ttl_s = Number(rest[1]);
            }
            return { method: "POST", path: "/v1/sessions", body, create: true };
        }
        if ((command === "status" || command === "close") && rest.length === 1) {
            return { method: command === "status" ? "GET" : "DELETE", path: sessionPath(rest[0]) };
        }
        throw new UsageError("usage: browser session create|status|close (see browser --help)");
    }
    if (args[0] === "steps") {
        if (args.length !== 2 && !(args.length === 4 && args[2] === "--idempotency-key" && args[3].trim())) {
            throw new UsageError("usage: browser steps ID [--idempotency-key KEY] < batch.json");
        }
        const path = sessionPath(args[1]) + "/steps";
        let body;
        try {
            body = JSON.parse(stdin);
        } catch {
            throw new UsageError("steps requires a JSON object on stdin: {\"steps\":[...]}");
        }
        if (!body || !Array.isArray(body.steps) || Object.keys(body).some((key) => key !== "steps")) {
            throw new UsageError("steps requires a JSON object containing only a steps array");
        }
        return {
            method: "POST", path, body,
            key: args[3] ?? `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
        };
    }
    throw new UsageError("unknown command; see browser --help");
}

function sessionPath(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new UsageError("invalid session id");
    return `/v1/sessions/${id}`;
}

function output(stdout, exit_code = 0, stderr = "") {
    return { stdout, stderr, exit_code };
}

function help() {
    return `Usage:
  browser session create [--ttl SECONDS]   Print only the new session id
  browser session status ID                Print JSON status, including expires_at
  browser session close ID                 End the session and print JSON
  browser steps ID [--idempotency-key KEY]  Read {"steps":[...]} from stdin; print JSON

Example:
  session=$(browser session create --ttl 600)
  browser steps "$session" <<'JSON'
  {"steps":[{"op":"goto","url":"https://app.example.com"},{"op":"content","format":"markdown"}]}
  JSON
  browser session close "$session"

Step ops:
  goto {url}, click {locator}, fill {locator,value,sensitive?},
  press {key,locator?}, select {locator,values}, check {locator,checked?},
  wait_for {locator?,state?,url?}, text {locator}, attribute {locator,name},
  count {locator}, content {format:"html"|"markdown"}, evaluate {expression}.
  Each step needs "op". Actions and waits accept timeout_ms.
  Locators: {css}, {role,name?}, {text}, {label}, {placeholder}, {test_id};
  add exact:true or nth:0 to refine a locator. At most 100 steps per batch.

Requires the optional browser integration. Page destinations, including redirects
and assets, must be allowed by its allowed_host entries. Lightpanda has no screenshots.
Sessions can expire or end on restart or OOM; inspect status and create a new one
when needed. Do not automatically repeat actions after an ambiguous failure.
Batches stop on the first failed step and exit nonzero, preserving their results
and denied_hosts/denied_requests in stdout. Requests are not retried automatically. Batch keys
are cached only while the session lives (the last 16 keys); reuse a key only for
the same batch. Use sensitive:true for secret fills to redact later results.
`;
}
