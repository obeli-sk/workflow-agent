#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const CATALOG_URL = "https://exe.dev/llm-gateway-models.json";
const OUTPUTS = [
    {
        path: fileURLToPath(new URL("../models.exe-integration.json", import.meta.url)),
        pathPrefix: "",
    },
    {
        path: fileURLToPath(new URL("../models.exe-gateway.json", import.meta.url)),
        pathPrefix: "/gateway/llm",
    },
];
const API_TYPES = new Map([
    ["anthropic", "anthropic-messages"],
    ["openai", "openai-responses"],
    ["fireworks", "openai-chat-completions"],
    ["xai", "openai-chat-completions"],
]);

function friendlyId(provider, wireModel) {
    if (provider === "anthropic") return wireModel.replace(/-(\d+)-(\d+)$/, "-$1.$2");
    if (provider === "fireworks") {
        const short = wireModel.replace(/^accounts\/fireworks\/models\//, "");
        return `${short.replace(/(\d)p(?=\d)/g, "$1.")}-fireworks`;
    }
    return wireModel;
}

function providerPath(path, pathPrefix) {
    return `${pathPrefix}/${path.replace(/\/v1$/, "")}`;
}

function generate(catalog, pathPrefix) {
    if (catalog?.schemaVersion !== 1 || !Array.isArray(catalog.providers)) {
        throw new Error("unsupported exe.dev model catalog schema");
    }

    const result = [];
    const ids = new Set();
    for (const provider of catalog.providers) {
        const apiType = API_TYPES.get(provider.id);
        if (!apiType) throw new Error(`unsupported provider '${provider.id}'`);
        if (typeof provider.path !== "string" || !Array.isArray(provider.models)) {
            throw new Error(`invalid provider '${provider.id}'`);
        }

        for (const model of provider.models) {
            if ((model.type ?? "chat") !== "chat") continue;
            if (typeof model.id !== "string" || !model.id) {
                throw new Error(`invalid model in provider '${provider.id}'`);
            }

            const id = friendlyId(provider.id, model.id);
            if (ids.has(id)) throw new Error(`duplicate generated model id '${id}'`);
            ids.add(id);

            const entry = {
                id,
                label: id,
                api_type: apiType,
                path: providerPath(provider.path, pathPrefix),
                wire_model: model.id,
            };
            if (provider.id === "anthropic") entry.max_tokens = 8192;
            result.push(entry);
        }
    }
    return `${JSON.stringify(result, null, 2)}\n`;
}

const response = await fetch(CATALOG_URL);
if (!response.ok) throw new Error(`cannot fetch ${CATALOG_URL}: HTTP ${response.status}`);
const catalog = await response.json();

for (const output of OUTPUTS) {
    const generated = generate(catalog, output.pathPrefix);
    if (process.argv.includes("--check")) {
        const current = await readFile(output.path, "utf8").catch(() => "");
        if (current !== generated) {
            console.error(`${output.path} is out of date`);
            process.exitCode = 1;
        }
    } else {
        await writeFile(output.path, generated);
        console.log(`updated ${output.path}`);
    }
}
