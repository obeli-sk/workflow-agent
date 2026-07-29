// obelisk-agent:programs/program.curl:
//   func(stdin: string, args: list<string>)
//     -> result<record { stdout: string, stderr: string, exit-code: u32 }, string>
//
// A deliberately small curl-compatible GET client. The deployment allowlist is
// the security boundary for requests and redirects.

const MAX_REDIRECTS = 10;

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

    try {
        let redirects = 0;
        while (true) {
            const response = await fetch(url.href, {
                method: "GET",
                headers: parsed.headers,
                redirect: "manual",
            });
            if (isRedirect(response.status) && parsed.followRedirects) {
                if (redirects++ >= MAX_REDIRECTS) {
                    return fail(47, `curl: (47) Maximum (${MAX_REDIRECTS}) redirects followed\n`);
                }
                const location = response.headers.get("location");
                if (!location) return fail(47, "curl: (47) Redirect response has no Location header\n");
                try {
                    url = parseUrl(new URL(location, url).href);
                } catch (error) {
                    return fail(47, `curl: (47) ${message(error)}\n`);
                }
                continue;
            }

            const body = await response.text();
            if (parsed.failOnHttpError && response.status >= 400) {
                return fail(22, `curl: (22) The requested URL returned error: ${response.status}\n`);
            }
            const headers = parsed.includeHeaders ? formatHeaders(response) : "";
            return { stdout: headers + body, stderr: "", exit_code: 0 };
        }
    } catch (error) {
        return fail(6, `curl: (6) ${message(error)}\n`);
    }
}

function parseArgs(args) {
    let url = "";
    let failOnHttpError = false;
    let followRedirects = false;
    let includeHeaders = false;
    const headers = {};

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--help") return { output: ok(help()) };
        if (arg === "--version") return { output: ok("curl (workflow-agent) GET-only\n") };
        if (arg === "--get" || arg === "-G" || arg === "--silent" || arg === "-s" || arg === "--show-error" || arg === "-S") continue;
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
        if (/^-[sSfLi]+$/.test(arg)) {
            failOnHttpError ||= arg.includes("f");
            followRedirects ||= arg.includes("L");
            includeHeaders ||= arg.includes("i");
            continue;
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
    return { url, failOnHttpError, followRedirects, includeHeaders, headers };
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
        "  -f, --fail          Fail on HTTP status >= 400",
        "  -G, --get           Explicitly select GET",
        "  -H, --header VALUE  Add a request header",
        "  -i, --include       Include response headers",
        "  -L, --location      Follow redirects that stay on https://obeli.sk",
        "  -s, --silent        Accepted for curl compatibility",
        "  -S, --show-error    Accepted for curl compatibility",
        "  -X, --request GET   Explicitly select GET",
        "      --url URL       Specify the URL",
        "      --help          Show this help",
        "",
    ].join("\n");
}
