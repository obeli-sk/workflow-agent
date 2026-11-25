// HTTP response helpers and request-query parsing shared by the webhook routes.

export function activityJson(label, text) {
    try { return JSON.parse(text); }
    catch (e) { throw new Error(`${label}: non-JSON activity result: ${e.message}`); }
}

export function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
    });
}

export function jsonError(status, message) {
    return jsonResponse({ error: message }, status);
}

export function parseQuery(rawUrl) {
    const query = Object.create(null);
    const queryStart = rawUrl.indexOf("?");
    if (queryStart < 0) return query;

    const fragmentStart = rawUrl.indexOf("#", queryStart);
    const queryString = rawUrl.substring(
        queryStart + 1,
        fragmentStart < 0 ? rawUrl.length : fragmentStart,
    );
    for (const part of queryString.split("&")) {
        if (!part) continue;
        const separator = part.indexOf("=");
        const rawKey = separator < 0 ? part : part.substring(0, separator);
        const rawValue = separator < 0 ? "" : part.substring(separator + 1);
        const key = decodeQueryComponent(rawKey);
        if (!(key in query)) query[key] = decodeQueryComponent(rawValue);
    }
    return query;
}

function decodeQueryComponent(value) {
    return decodeURIComponent(value.replace(/\+/g, " "));
}

export function nonNegativeInteger(value) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
