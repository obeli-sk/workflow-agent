import * as webapi from "obelisk-agent:tools/webapi";
import * as ghRepo from "agent-herder:github/repo";

const OWNER = "obeli-sk";
const REPO = "agent-herder";
const BASE_BRANCH = "main";

export default function pushDeployment(branchName, prTitle, prBody) {
    if (!branchName) throw "branch-name is required";
    if (!prTitle) throw "pr-title is required";
    const body = (typeof prBody === "string" && prBody) ? prBody : "";

    // 1. Discover the live deployment. The webapi activity returns JSON text.
    const deploymentId = parseJsonString(webapi.currentDeploymentId(), "current deployment id");
    console.log(`Exporting deployment ${deploymentId} to ${OWNER}/${REPO}@${branchName}`);

    // 2. Pull the manifest TOML.
    const depMetaJson = webapi.getDeployment(deploymentId, null, null, null, null);
    const depMeta = JSON.parse(depMetaJson);
    const deploymentToml = depMeta.deployment_toml;
    if (typeof deploymentToml !== "string" || !deploymentToml) {
        throw `deployment ${deploymentId} returned no deployment_toml`;
    }

    // 3. Parse (location, selector) tuples for every owned source.
    const sources = collectSources(deploymentToml);
    console.log(`Found ${sources.length} owned source file(s).`);

    // 4. Fetch each source body up front. webapi.getComponentSource paginates.
    const sourceBodies = [];
    for (let i = 0; i < sources.length; i++) {
        const [location, selector] = sources[i];
        const text = readSource(deploymentId, selector);
        sourceBodies.push([location, text]);
    }

    // 5. Create the branch.
    let head = ghRepo.createBranch(OWNER, REPO, BASE_BRANCH, branchName);
    console.log(`Created branch ${branchName} at ${head}`);

    // 6. First commit: deployment.toml.
    head = ghRepo.pushFile(
        OWNER, REPO, branchName, head,
        "deployment.toml",
        deploymentToml,
        `Export deployment.toml`,
        `From Obelisk deployment ${deploymentId}.`,
    );
    console.log(`Committed deployment.toml -> ${head}`);

    // 7. One commit per source file, chaining the head OID.
    for (let i = 0; i < sourceBodies.length; i++) {
        const [location, text] = sourceBodies[i];
        head = ghRepo.pushFile(
            OWNER, REPO, branchName, head,
            location,
            text,
            `Export ${location}`,
            `From Obelisk deployment ${deploymentId}.`,
        );
        console.log(`Committed ${location} -> ${head}`);
    }

    // 8. Open the PR.
    const prUrl = ghRepo.createPr(
        OWNER, REPO, branchName, BASE_BRANCH, prTitle,
        body || `Exported Obelisk deployment ${deploymentId} (${sourceBodies.length + 1} files).`,
    );
    console.log(`Opened PR: ${prUrl}`);
    return prUrl;
}

// Walk the manifest and pull out (location, selector) for every owned source.
// selector prefers ffqn (globally unique), falling back to name (webhook
// endpoints have no ffqn). Dedupes by location because multiple components may
// share a file (claude.start and codex.start both point at agent-start.js).
function collectSources(toml) {
    const seen = new Set();
    const out = [];
    const blockRe = /\[\[(activity_js|activity_exec|workflow_js|webhook_endpoint_js)\]\]([\s\S]*?)(?=\n\[\[|$)/g;
    let m;
    while ((m = blockRe.exec(toml)) !== null) {
        const block = m[2];
        const locM = block.match(/^\s*location\s*=\s*"([^"]+)"/m);
        if (!locM) continue;
        const location = locM[1];
        if (seen.has(location)) continue;
        const ffqnM = block.match(/^\s*ffqn\s*=\s*"([^"]+)"/m);
        const nameM = block.match(/^\s*name\s*=\s*"([^"]+)"/m);
        const selector = (ffqnM && ffqnM[1]) || (nameM && nameM[1]);
        if (!selector) continue;
        seen.add(location);
        out.push([location, selector]);
    }
    return out;
}

function readSource(deploymentId, selector) {
    const CHUNK = 65536;
    let offset = 0;
    let body = "";
    for (;;) {
        const pageJson = webapi.getComponentSource(deploymentId, selector, offset, CHUNK);
        const page = JSON.parse(pageJson);
        body += page.raw_body || "";
        if (page.next_offset === null || page.next_offset === undefined) break;
        offset = page.next_offset;
    }
    return body;
}

function parseJsonString(value, label) {
    if (typeof value !== "string") {
        throw `${label} was not returned as a string`;
    }
    const parsed = JSON.parse(value);
    if (typeof parsed !== "string" || !parsed) {
        throw `${label} was not a non-empty JSON string`;
    }
    return parsed;
}
