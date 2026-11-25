// The injection stub's durable finish time is when Obelisk accepted the input.
export default async function input_accepted_at(executionId) {
    if (!executionId) throw "execution-id is required";
    const base = process.env["OBELISK_API_URL"];
    if (!base) throw "OBELISK_API_URL is not configured";
    const response = await fetch(
        `${base.replace(/\/$/, "")}/v1/executions/${encodeURIComponent(executionId)}/status`,
        { headers: { accept: "application/json", authorization: `Bearer ${process.env["OBELISK_API_TOKEN"]}` } },
    );
    if (!response.ok) throw `HTTP ${response.status}: ${await response.text()}`;
    const status = await response.json();
    const finishedAt = status?.pending_state?.finished_at;
    // The activity runtime's Date parser only accepts millisecond precision,
    // while Obelisk serializes timestamps with nanosecond precision.
    const parseableFinishedAt = typeof finishedAt === "string"
        ? finishedAt.replace(/(\.\d{3})\d+(Z|[+-]\d\d:\d\d)$/, "$1$2")
        : finishedAt;
    const milliseconds = Date.parse(parseableFinishedAt);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw `execution ${executionId} has no valid finished_at timestamp`;
    }
    return milliseconds;
}
