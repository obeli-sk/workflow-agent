// The picker and LLM client use the same discovered catalog and configured fallback.
import { loadModelCatalog } from "../../shared/model-catalog.js";

export async function loadModels() {
    let catalog;
    try { catalog = await loadModelCatalog(); } catch (_) { catalog = []; }
    const models = catalog.map((m) => ({ id: m.id, label: m.label || m.id, api_type: m.api_type || "" }));
    return { models };
}
