// The configurable model catalog (deployment.toml AGENT_MODELS). The UI renders
// these in the model dropdown; the selected id is passed to the workflow as the
// `backend`/model hint, and the llm activity routes it to the right wire API.
export function loadModels() {
    const raw = process.env["AGENT_MODELS"];
    let catalog = [];
    if (raw) { try { catalog = JSON.parse(raw); } catch (_) { catalog = []; } }
    const models = Array.isArray(catalog)
        ? catalog.filter((m) => m && m.id).map((m) => ({ id: m.id, label: m.label || m.id, api_type: m.api_type || "" }))
        : [];
    return { models };
}
