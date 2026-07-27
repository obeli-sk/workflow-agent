import { defineCommand } from "../../../../just-bash/packages/just-bash/src/custom-commands.ts";
import { decodeBytesToUtf8 } from "../../../../just-bash/packages/just-bash/src/encoding.ts";

const DEPLOYMENT_ROOT = "/workspace/deployment";

export const descriptor = {
    name: "obelisk-control",
    systemPrompt: `The session has a persistent virtual filesystem rooted at /workspace.
Use the obelisk command for external Obelisk operations and ordinary shell
commands for inspecting and editing files. The active deployment is mounted at
/workspace/deployment/current. Editing these files is local until an explicit
obelisk deployment submit or apply command.`,
};

export function commands() {
    return [defineCommand("obelisk", executeObelisk)];
}

export async function mount(fs) {
    await refreshDeploymentMount(fs, false);
}

async function executeObelisk(args, ctx) {
    try {
        const [group = "", action = "", ...rest] = args;
        if (!group || group === "--help" || group === "help") {
            return ok(help());
        }

        if (group === "functions" && action === "list") {
            return jsonCall("obelisk-agent:tools/webapi.list-functions", [
                option(rest, "--prefix", ""),
                integerOption(rest, "--length", 100),
            ]);
        }
        if (group === "functions" && action === "wit") {
            return jsonCall("obelisk-agent:tools/webapi.get-function-wit", [
                required(rest[0], "ffqn"),
            ]);
        }
        if (group === "executions" && action === "list") {
            return jsonCall("obelisk-agent:tools/webapi.list-executions", [
                option(rest, "--ffqn-prefix", ""),
                option(rest, "--id-prefix", ""),
                flag(rest, "--show-derived"),
                flag(rest, "--hide-finished"),
                "",
                "",
                "",
                "",
                false,
                integerOption(rest, "--length", 20),
            ]);
        }
        if (group === "executions" && action === "get") {
            return jsonCall("obelisk-agent:tools/webapi.get-execution", [
                required(rest[0], "execution id"),
            ]);
        }
        if (group === "executions" && action === "logs") {
            return jsonCall("obelisk-agent:tools/webapi.get-logs", [
                required(rest[0], "execution id"),
                true,
                true,
                true,
                [],
                [],
                "",
                "",
                false,
                integerOption(rest, "--length", 200),
            ]);
        }
        if (group === "executions" && action === "result") {
            return jsonCall("obelisk-agent:tools/webapi.get-result-json", [
                required(rest[0], "execution id"),
            ]);
        }
        if (group === "call") {
            const ffqn = required(action, "ffqn");
            const paramsJson = rest[0] || decodeBytesToUtf8(ctx.stdin) || "[]";
            return jsonCall("obelisk-control:tools/native.call", [
                ffqn,
                paramsJson,
            ]);
        }
        if (group === "deployment") {
            return executeDeployment(action, rest, ctx);
        }
        return fail(`obelisk: unknown command '${args.join(" ")}'\n${help()}`);
    } catch (error) {
        return fail(`obelisk: ${message(error)}\n`);
    }
}

async function executeDeployment(action, args, ctx) {
    if (action === "current") {
        return jsonCall("obelisk-agent:tools/webapi.current-deployment-id", []);
    }
    if (action === "refresh") {
        const refreshed = await refreshDeploymentMount(ctx.fs, true);
        return ok(`${JSON.stringify(refreshed)}\n`);
    }
    if (action === "check") {
        const dir = resolveDeploymentDir(ctx, args[0]);
        const manifest = await ctx.fs.readFile(`${dir}/deployment.toml`);
        const sources = await deploymentSources(ctx.fs, dir, manifest);
        return ok(`${JSON.stringify({
            directory: dir,
            manifest_bytes: manifest.length,
            owned_sources: sources.map((entry) => entry.path),
        }, null, 2)}\n`);
    }
    if (action === "submit") {
        const dir = resolveDeploymentDir(ctx, args[0]);
        const manifest = await ctx.fs.readFile(`${dir}/deployment.toml`);
        const sources = await deploymentSources(ctx.fs, dir, manifest);
        const deploymentId = basename(dir) === "current" ? "" : basename(dir);
        return jsonCall("obelisk-agent:tools/webapi.deployment-submit", [
            manifest,
            JSON.stringify(sources),
            option(args, "--description", "Submitted from workflow-agent VFS"),
            flag(args, "--allow-missing-runtime-config"),
            deploymentId,
        ]);
    }
    if (action === "switch") {
        return jsonCall("obelisk-agent:tools/webapi.deployment-switch", [
            required(args[0], "deployment id"),
            flag(args, "--allow-missing-runtime-config"),
        ]);
    }
    if (action === "apply") {
        return jsonCall("obelisk-agent:tools/webapi.apply-deployment", [
            required(args[0], "deployment id"),
        ]);
    }
    return fail(`obelisk deployment: unknown action '${action}'\n`);
}

async function refreshDeploymentMount(fs, replace) {
    const currentRaw = obelisk.call(
        "obelisk-agent:tools/webapi.current-deployment-id",
        [],
    );
    const deploymentId = decodeString(currentRaw);
    if (!deploymentId) return { deployment_id: null, files: 0 };

    const checkoutRaw = obelisk.call(
        "obelisk-agent:tools/webapi.deployment-checkout",
        [deploymentId],
    );
    const checkout = decodeJson(checkoutRaw);
    const manifest = checkout.deployment_toml;
    if (typeof manifest !== "string") {
        throw new Error("deployment checkout returned no deployment_toml");
    }

    const dir = `${DEPLOYMENT_ROOT}/${deploymentId}`;
    await fs.mkdir(dir, { recursive: true });
    const manifestPath = `${dir}/deployment.toml`;
    if (replace || !(await fs.exists(manifestPath))) {
        await fs.writeFile(manifestPath, manifest);
    }

    let files = 1;
    for (const ref of ownedScriptRefs(manifest)) {
        const path = `${dir}/${ref.location}`;
        if (!replace && await fs.exists(path)) continue;
        const content = obelisk.call(
            "obelisk-agent:tools/webapi.deployment-read-blob",
            [ref.digest],
        );
        await fs.writeFile(path, String(content));
        files += 1;
    }

    const current = `${DEPLOYMENT_ROOT}/current`;
    if (await fs.exists(current)) await fs.rm(current, { recursive: true, force: true });
    await fs.symlink(dir, current);
    return { deployment_id: deploymentId, files };
}

async function deploymentSources(fs, dir, manifest) {
    const files = [];
    for (const ref of ownedScriptRefs(manifest)) {
        const path = `${dir}/${ref.location}`;
        if (!await fs.exists(path)) continue;
        files.push({ path: ref.location, content: await fs.readFile(path) });
    }
    return files;
}

function ownedScriptRefs(toml) {
    const refs = [];
    let location = null;
    let digest = null;
    let inMain = false;
    const flush = () => {
        if (location && digest && !location.startsWith("oci://")) {
            refs.push({ location, digest });
        }
        location = null;
        digest = null;
    };
    for (const line of String(toml).split("\n")) {
        const text = line.trim();
        if (text.startsWith("[[") && !text.includes(".")) {
            flush();
            inMain = true;
            continue;
        }
        if (text.startsWith("[")) {
            inMain = false;
            continue;
        }
        if (!inMain) continue;
        location = tomlValue(text, "location") ?? location;
        digest = tomlValue(text, "content_digest") ?? digest;
    }
    flush();
    return refs;
}

function tomlValue(line, key) {
    if (!line.startsWith(key)) return null;
    const separator = line.indexOf("=");
    if (separator < 0) return null;
    const value = line.slice(separator + 1).trim();
    return value.startsWith('"') && value.endsWith('"')
        ? value.slice(1, -1)
        : null;
}

function resolveDeploymentDir(ctx, value) {
    return ctx.fs.resolvePath(ctx.cwd, value || ".");
}

function jsonCall(ffqn, params) {
    const value = obelisk.call(ffqn, params);
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return ok(text.endsWith("\n") ? text : `${text}\n`);
}

function decodeString(value) {
    if (typeof value !== "string") return String(value ?? "");
    try {
        const decoded = JSON.parse(value);
        return typeof decoded === "string" ? decoded : String(decoded?.deployment_id || "");
    } catch (_) {
        return value.trim();
    }
}

function decodeJson(value) {
    if (value && typeof value === "object") return value;
    return JSON.parse(String(value));
}

function required(value, label) {
    if (!value) throw new Error(`${label} is required`);
    return value;
}

function option(args, name, fallback) {
    const index = args.indexOf(name);
    return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

function integerOption(args, name, fallback) {
    const parsed = Number(option(args, name, fallback));
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function flag(args, name) {
    return args.includes(name);
}

function basename(path) {
    const parts = String(path).replace(/\/+$/, "").split("/");
    return parts[parts.length - 1] || "";
}

function ok(stdout) {
    return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr) {
    return { stdout: "", stderr, exitCode: 2 };
}

function message(error) {
    if (error instanceof obelisk.ChildExecutionError) {
        if (error.value !== undefined) {
            return typeof error.value === "string"
                ? error.value
                : JSON.stringify(error.value);
        }
        return error.message;
    }
    return String(error);
}

function help() {
    return `Usage: obelisk <command>

Commands:
  functions list [--prefix PREFIX] [--length N]
  functions wit FFQN
  executions list [--ffqn-prefix PREFIX] [--length N]
  executions get ID
  executions logs ID [--length N]
  executions result ID
  call FFQN [PARAMS_JSON]
  deployment current
  deployment refresh
  deployment check [DIRECTORY]
  deployment submit [DIRECTORY] [--description TEXT]
  deployment switch ID
  deployment apply ID
`;
}
