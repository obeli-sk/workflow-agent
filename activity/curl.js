// obelisk-agent:programs/program.curl:
//   func(stdin: string, args: list<string>)
//     -> result<record { stdout: string, stderr: string, exit-code: u32 }, string>
//
// A deliberately small curl-compatible GET client. The deployment allowlist is
// the security boundary for requests and redirects. Common inspection flags are
// understood (-f -i -L -s -v -I -H -w --max-time --compressed) so callers can
// read status codes and timings, but the method is pinned to GET.

const MAX_REDIRECTS = 10;

// %{var} names expanded by --write-out; unknown ones are left verbatim.
const WRITE_OUT_VARS = new Set([
    "http_code",
    "size_download",
    "content_type",
    "url_effective",
    "num_redirects",
    "time_total",
]);

export default async function curl(stdin, args) {
    void stdin;
    const parsed = parseArgs(Array.isArray(args) ? args.map(String) : []);
    if (parsed.output) return parsed.output;

    let url;
    try {
        url = parseUrl(parsed.url);
    } catch (error) {
        return fail(3, `curl: (3) ${message(error)}\n`);
    }

    const startedAt = Date.now();
    let redirects = 0;
    const trace = [];
    try {
        while (true) {
            if (parsed.verbose) {
                trace.push(`> GET ${url.pathname}${url.search}`);
            }
            const response = await fetch(url.href, {
                method: "GET",
                headers: parsed.headers,
                redirect: "manual",
                signal: timeoutSignal(parsed.maxTimeMs),
            });
            if (isRedirect(response.status) && parsed.followRedirects) {
                if (redirects++ >= MAX_REDIRECTS) {
                    return fail(47, `curl: (47) Maximum (${MAX_REDIRECTS}) redirects followed\n`);
                }
                const location = response.headers.get("location");
                if (!location) return fail(47, "curl: (47) Redirect response has no Location header\n");
                if (parsed.verbose) trace.push(`< HTTP ${response.status} (redirect)`, `* Redirecting to ${location}`);
                void response.body?.cancel();
                try {
                    url = parseUrl(new URL(location, url).href);
                } catch (error) {
                    return fail(47, `curl: (47) ${message(error)}\n`);
                }
                continue;
            }

            const body = await response.text();
            const vars = {
                http_code: response.status,
                size_download: byteLength(body),
                content_type: response.headers.get("content-type") ?? "",
                url_effective: url.href,
                num_redirects: redirects,
                time_total: ((Date.now() - startedAt) / 1000).toFixed(6),
            };
            if (parsed.verbose) {
                trace.push(`< HTTP ${response.status}`);
                for (const [name, value] of response.headers.entries()) trace.push(`< ${name}: ${value}`);
            }

            if (parsed.failOnHttpError && response.status >= 400) {
                const error = fail(22, `curl: (22) The requested URL returned error: ${response.status}\n`);
                // curl still emits the write-out string for failed transfers.
                if (parsed.writeOut !== null) error.stdout = formatWriteOut(parsed.writeOut, vars);
                return withTrace(error, trace, parsed);
            }
            const headers = parsed.includeHeaders ? formatHeaders(response) : "";
            let stdout = headers + (parsed.headOnly ? "" : body);
            if (parsed.writeOut !== null) stdout += formatWriteOut(parsed.writeOut, vars);
            return withTrace({ stdout, stderr: "", exit_code: 0 }, trace, parsed);
        }
    } catch (error) {
        if (isAbort(error)) {
            return fail(28, `curl: (28) Operation timed out after ${parsed.maxTimeMs} ms\n`);
        }
        return fail(6, `curl: (6) ${message(error)}\n`);
    }
}

function parseArgs(args) {
    let url = "";
    let failOnHttpError = false;
    let followRedirects = false;
    let includeHeaders = false;
    let headOnly = false;
    let verbose = false;
    let writeOut = null;
    let maxTimeMs = null;
    const headers = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--help") return { output: ok(help()) };
        if (arg === "--version") return { output: ok("curl (workflow-agent) GET-only\n") };
        if (
            arg === "--get" || arg === "-G" || arg === "--silent" || arg === "-s"
            || arg === "--show-error" || arg === "-S" || arg === "--compressed"
        ) continue;
        if (arg === "--fail" || arg === "-f") {
            failOnHttpError = true;
            continue;
        }
        if (arg === "--location" || arg === "-L") {
            followRedirects = true;
            continue;
        }
        if (arg === "--include" || arg === "-i") {
            includeHeaders = true;
            continue;
        }
        // Emulated: only GET may leave the sandbox, so -I performs a GET whose
        // body is suppressed instead of issuing a real HEAD request.
        if (arg === "--head" || arg === "-I") {
            headOnly = true;
            includeHeaders = true;
            continue;
        }
        if (arg === "--verbose" || arg === "-v") {
            verbose = true;
            continue;
        }
        if (/^-[sSfLivI]+$/.test(arg)) {
            failOnHttpError ||= arg.includes("f");
            followRedirects ||= arg.includes("L");
            includeHeaders ||= arg.includes("i");
            if (arg.includes("I")) {
                headOnly = true;
                includeHeaders = true;
            }
            verbose ||= arg.includes("v");
            continue;
        }
        if (arg === "--write-out" || arg === "-w") {
            writeOut = args[++i];
            if (writeOut === undefined) return { output: usage("option requires an argument: " + arg) };
            continue;
        }
        if (arg.startsWith("--write-out=")) {
            writeOut = arg.slice("--write-out=".length);
            continue;
        }
        // Attached short form: -w'%{http_code}\n'
        if (arg.startsWith("-w") && arg.length > 2) {
            writeOut = arg.slice(2);
            continue;
        }
        if (arg === "--max-time" || arg === "-m") {
            const parsed_ = parseMaxTime(args[++i]);
            if (typeof parsed_ !== "number") return { output: usage("invalid max-time value") };
            maxTimeMs = parsed_;
            continue;
        }
        if (arg.startsWith("--max-time=")) {
            const parsed_ = parseMaxTime(arg.slice("--max-time=".length));
            if (typeof parsed_ !== "number") return { output: usage("invalid max-time value") };
            maxTimeMs = parsed_;
            continue;
        }
        if (arg === "-o" || arg === "--output" || arg.startsWith("--output=")) {
            return { output: usage("-o/--output is not supported: the program has no filesystem") };
        }
        if (arg === "--request" || arg === "-X") {
            const method = args[++i];
            if (!method) return { output: usage("option requires an argument: " + arg) };
            if (method.toUpperCase() !== "GET") return { output: usage("only GET requests are supported") };
            continue;
        }
        if (arg.startsWith("--request=")) {
            if (arg.slice(10).toUpperCase() !== "GET") return { output: usage("only GET requests are supported") };
            continue;
        }
        if (arg === "--header" || arg === "-H") {
            const header = args[++i];
            if (!header) return { output: usage("option requires an argument: " + arg) };
            const colon = header.indexOf(":");
            if (colon <= 0) return { output: usage("invalid header") };
            headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
            continue;
        }
        if (arg === "--url") {
            url = args[++i] || "";
            if (!url) return { output: usage("option requires an argument: --url") };
            continue;
        }
        if (arg.startsWith("--url=")) {
            url = arg.slice(6);
            continue;
        }
        if (arg.startsWith("-")) return { output: usage(`unsupported option: ${arg}`) };
        if (url) return { output: usage("only one URL is supported") };
        url = arg;
    }

    if (!url) return { output: usage("URL is required") };
    return {
        url,
        failOnHttpError,
        followRedirects,
        includeHeaders,
        headOnly,
        verbose,
        writeOut,
        maxTimeMs,
        headers,
    };
}

function parseMaxTime(value) {
    if (value === undefined) return null;
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.round(seconds * 1000);
}

function timeoutSignal(maxTimeMs) {
    if (maxTimeMs === null) return undefined;
    try {
        return AbortSignal.timeout(maxTimeMs);
    } catch {
        // Fall through to the manual controller for engines without .timeout.
    }
    if (typeof setTimeout === "function") {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), maxTimeMs);
        return controller.signal;
    }
    return undefined; // Runtime without timers cannot honor --max-time.
}

function isAbort(error) {
    return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

// Expands the supported %{var}s, backslash escapes (\n \r \t) and %% ; leaves
// anything else (e.g. unknown %{vars}) verbatim, like older curl versions.
function formatWriteOut(format, vars) {
    let out = "";
    for (let i = 0; i < format.length; i++) {
        const ch = format[i];
        if (ch === "\\" && i + 1 < format.length) {
            const next = format[++i];
            out += next === "n" ? "\n" : next === "r" ? "\r" : next === "t" ? "\t" : next;
            continue;
        }
        if (ch === "%" && format[i + 1] === "%") {
            out += "%";
            i++;
            continue;
        }
        if (ch === "%" && format[i + 1] === "{") {
            const end = format.indexOf("}", i + 2);
            if (end !== -1 && WRITE_OUT_VARS.has(format.slice(i + 2, end))) {
                out += String(vars[format.slice(i + 2, end)]);
                i = end;
                continue;
            }
        }
        out += ch;
    }
    return out;
}

function withTrace(result, trace, parsed) {
    if (!parsed.verbose || trace.length === 0) return result;
    return { ...result, stderr: trace.join("\n") + "\n" + result.stderr };
}

function parseUrl(input) {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`);
}

function isRedirect(status) {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function formatHeaders(response) {
    let output = `HTTP ${response.status}\n`;
    for (const [name, value] of response.headers.entries()) output += `${name}: ${value}\n`;
    return output + "\n";
}

function byteLength(text) {
    return typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text).length : text.length;
}

function usage(detail) {
    return fail(2, `curl: ${detail}\nTry 'curl --help' for more information.\n`);
}

function ok(stdout) {
    return { stdout, stderr: "", exit_code: 0 };
}

function fail(exitCode, stderr) {
    return { stdout: "", stderr, exit_code: exitCode };
}

function message(error) {
    return error instanceof Error ? error.message : String(error);
}

function help() {
    return [
        "Usage: curl [options] URL",
        "",
        "GET-only HTTP client. Network policy is configured by the activity host.",
        "",
        "Options:",
        "  --compressed        Accepted for curl compatibility (bodies arrive decoded)",
        "  -f, --fail          Fail with exit code 22 on HTTP status >= 400",
        "  -G, --get           Explicitly select GET",
        "  -H, --header VALUE  Add a request header",
        "  -I, --head          Headers only (emulated with GET; no HEAD request)",
        "  -i, --include       Include response headers",
        "  -L, --location      Follow redirects (only the final response is printed;\n                        trace the hops with -v)",
        "  -m, --max-time SEC  Abort the whole request after SEC seconds (exit 28)",
        "  -s, --silent        Accepted for curl compatibility",
        "  -S, --show-error    Accepted for curl compatibility",
        "  -v, --verbose       Trace the request/response conversation on stderr",
        "  -X, --request GET   Explicitly select GET",
        "  -w, --write-out FMT Print FMT after the body, expanding %{var}:",
        "                        http_code size_download content_type",
        "                        url_effective num_redirects time_total",
        "                      plus \\\\n \\\\r \\\\t and %%; unknown %{vars} stay verbatim",
        "      --url URL       Specify the URL",
        "      --help          Show this help",
        "",
        "Not supported: -o/--output (no filesystem), non-GET methods.",
        "",
    ].join("\n");
}
