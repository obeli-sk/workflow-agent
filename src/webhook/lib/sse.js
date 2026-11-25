// Incremental server-sent events parser for upstream Obelisk follow streams.

// Feed decoded text; returns complete blocks as {event, data} or {comment}
// and keeps the unterminated tail for the next call.
export function createSseParser() {
    let buffer = "";
    return (text) => {
        buffer += text.replace(/\r\n?/g, "\n");
        const blocks = [];
        let end = buffer.indexOf("\n\n");
        while (end >= 0) {
            const block = parseBlock(buffer.substring(0, end));
            if (block) blocks.push(block);
            buffer = buffer.substring(end + 2);
            end = buffer.indexOf("\n\n");
        }
        return blocks;
    };
}

function parseBlock(raw) {
    let event = "message";
    const data = [];
    let comment = null;
    for (const line of raw.split("\n")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.substring(0, colon);
        let value = colon < 0 ? "" : line.substring(colon + 1);
        if (value.startsWith(" ")) value = value.substring(1);
        if (field === "") comment = value;
        else if (field === "event") event = value;
        else if (field === "data") data.push(value);
    }
    if (data.length) return { event, data: data.join("\n") };
    return comment === null ? null : { comment };
}

// Read an SSE body to its end, calling onBlock for every parsed block.
export async function pumpSse(reader, onBlock) {
    const decoder = new TextDecoder();
    const parse = createSseParser();
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
        for (const block of parse(decoder.decode(next.value, { stream: true }))) onBlock(block);
    }
}
