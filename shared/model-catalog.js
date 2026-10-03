export function configuredModels() {
    const raw = process.env.AGENT_MODELS;
    if (!raw || !raw.trim()) throw new Error("AGENT_MODELS is not configured");
    let catalog;
    try { catalog = JSON.parse(raw); }
    catch (error) { throw new Error(`AGENT_MODELS is not valid JSON: ${String(error)}`); }
    if (!Array.isArray(catalog)) throw new Error("AGENT_MODELS must be a JSON array");
    return catalog.map((entry, index) => {
        if (!entry || typeof entry.id !== "string" || !entry.id) {
            throw new Error(`AGENT_MODELS[${index}] has no string id`);
        }
        return { ...entry, label: entry.label || entry.id, api_type: entry.api_type || "" };
    });
}

export async function loadModelCatalog() {
    let configured = [];
    let configurationError;
    try { configured = configuredModels(); }
    catch (error) { configurationError = error; }
    const base = process.env.LLM_BASE_URL;
    if (base) {
        try {
            const headers = { accept: "application/json" };
            if (process.env.LLM_API_KEY) headers.authorization = `Bearer ${process.env.LLM_API_KEY}`;
            const response = await fetch(`${base.replace(/\/$/, "")}/v1/models`, { headers });
            if (response.ok) {
                const payload = JSON.parse(await response.text());
                const discovered = Array.isArray(payload.data)
                    ? payload.data.filter((model) => model && typeof model.id === "string" && model.id)
                    : [];
                if (discovered.length) {
                    return discovered.map((model) => {
                        const prior = configured.find((entry) => (entry.wire_model || entry.id) === model.id);
                        return {
                            ...prior,
                            id: prior?.id || model.id,
                            label: model.display_name || prior?.label || model.id,
                            api_type: prior?.api_type || "openai-chat-completions",
                            wire_model: model.id,
                            is_default: !!model.is_default,
                        };
                    }).sort((a, b) => Number(b.is_default) - Number(a.is_default));
                }
            }
        } catch (_) {}
    }
    if (configurationError) throw configurationError;
    return configured;
}

export async function resolveModel(model) {
    const catalog = await loadModelCatalog();
    const id = typeof model === "string" ? model.trim() : "";
    let config = id ? catalog.find((entry) => entry.id === id || entry.wire_model === id) : catalog[0];
    if (!config && id) {
        // backcompat: pre-discovery sessions (Obelisk 0.42.0-rc.12) retain configured model ids.
        try { config = configuredModels().find((entry) => entry.id === id); } catch (_) {}
    }
    if (!config) throw new Error(id ? `model '${id}' is not in the model catalog` : "No models available from discovery or AGENT_MODELS");
    if (!config.api_type) throw new Error(`model '${config.id}' is missing api_type`);
    return config;
}

