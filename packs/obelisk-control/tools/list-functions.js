// obelisk-agent:tools/webapi.list-functions:
//   func(ffqn-prefix: string, length: u32)
//     -> result<list<record { ffqn: string,
//          parameter-types: list<record { name: string, wit-type: string }>,
//          return-type: string,
//          extension: option<enum { submit, await-next, schedule, stub, get }>,
//          wit: string }>,
//        variant { permanent-error(string), transient-error(string), execution-failed }>
// Returns each matching function's metadata plus its full WIT (interface with the
// single function and every type it references).
export default async function list_functions(ffqnPrefix, length) {
    try { return await list_functions_impl(ffqnPrefix, length); }
    catch (error) { throw classifyActivityError(error); }
}

async function list_functions_impl(ffqnPrefix, length) {
    const base = process.env["TARGET_OBELISK_API_URL"];
    if (!base) throw "TARGET_OBELISK_API_URL is not configured";
    const resp = await fetch(`${base}/v1/components?exports=true&submittable=true&extensions=true`, {
        headers: { accept: "application/json", authorization: `Bearer ${process.env["TARGET_OBELISK_TOKEN"]}` },
    });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;

    const components = await resp.json();
    if (!Array.isArray(components)) throw "invalid components response";
    const prefix = String(ffqnPrefix || "");
    const limit = length > 0 ? length : 100;
    const selected = components
        .flatMap((component) => component?.exports ?? [])
        .filter((item) => item && typeof item.ffqn === "string" && item.ffqn.startsWith(prefix))
        .slice(0, limit);

    const withWit = await Promise.all(selected.map(async (item) => ({
        ffqn: item.ffqn,
        parameter_types: item.parameter_types,
        return_type: item.return_type,
        extension: item.extension ?? null,
        wit: await fetchWit(base, item.ffqn),
    })));
    return withWit;
}

function classifyActivityError(error) {
    if (error?.permanent_error || error?.transient_error) return error;
    const message = error instanceof Error ? error.message : String(error);
    const status = Number(/\bHTTP (\d+)/.exec(message)?.[1]);
    const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
    return permanent || (!status && !(error instanceof Error))
        ? { permanent_error: message } : { transient_error: message };
}

// Fetch the function's full WIT: the interface printed with only this function
// plus every type it references, so the signature stays self-contained.
async function fetchWit(base, ffqn) {
    try {
        const resp = await fetch(
            `${base}/v1/functions/wit?ffqn=${encodeURIComponent(ffqn)}`,
            { headers: { accept: "text/plain", authorization: `Bearer ${process.env["TARGET_OBELISK_TOKEN"]}` } },
        );
        if (!resp.ok) return `<wit unavailable: HTTP ${resp.status}>`;
        return (await resp.text()).trim();
    } catch (e) {
        return `<wit unavailable: ${String(e)}>`;
    }
}
