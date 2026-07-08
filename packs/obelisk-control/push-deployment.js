import * as webapi from 'obelisk-agent:tools/webapi';
import * as ghRepo from 'agent-herder:github/repo';

const OWNER = 'obeli-sk';
const REPO = 'workflow-agent';
const BASE_BRANCH = 'main';

export default function pushDeployment(branchName, prTitle, prBody) {
    if (!branchName) throw 'branch-name is required';
    if (!prTitle) throw 'pr-title is required';
    const body = (typeof prBody === 'string' && prBody) ? prBody : '';

    const deploymentId = decodeIdResponse(webapi.currentDeploymentId());
    if (typeof deploymentId !== 'string' || !deploymentId) {
        throw 'current deployment id was not a non-empty string';
    }
    console.log(`Exporting deployment ${deploymentId} to ${OWNER}/${REPO}@${branchName}`);

    const deploymentToml = fetchManifest(deploymentId);
    if (!deploymentToml) throw `deployment ${deploymentId} returned empty deployment_toml`;

    const sources = collectSources(deploymentToml);
    console.log(`Found ${sources.length} owned source file(s).`);

    const sourceBodies = [];
    for (let i = 0; i < sources.length; i++) {
        const [location, digest] = sources[i];
        sourceBodies.push([location, webapi.deploymentReadBlob(digest)]);
    }

    let head = ghRepo.createBranch(OWNER, REPO, BASE_BRANCH, branchName);
    console.log(`Created branch ${branchName} at ${head}`);

    head = ghRepo.pushFile(OWNER, REPO, branchName, head, 'deployment.toml', deploymentToml, 'Export deployment.toml', `From Obelisk deployment ${deploymentId}.`);
    console.log(`Committed deployment.toml -> ${head}`);

    for (let i = 0; i < sourceBodies.length; i++) {
        const [location, text] = sourceBodies[i];
        head = ghRepo.pushFile(OWNER, REPO, branchName, head, location, text, `Export ${location}`, `From Obelisk deployment ${deploymentId}.`);
        console.log(`Committed ${location} -> ${head}`);
    }

    const prUrl = ghRepo.createPr(OWNER, REPO, branchName, BASE_BRANCH, prTitle, body || `Exported Obelisk deployment ${deploymentId} (${sourceBodies.length + 1} files).`);
    console.log(`Opened PR: ${prUrl}`);
    return prUrl;
}

function decodeIdResponse(raw) {
    if (typeof raw !== 'string') return raw;
    const trimmed = raw.trim();
    if (trimmed.charCodeAt(0) === 34) {
        try { return JSON.parse(trimmed); } catch (_) { }
    }
    if (trimmed.startsWith('{')) {
        try {
            const obj = JSON.parse(trimmed);
            if (typeof obj === 'string') return obj;
            if (obj && typeof obj.deployment_id === 'string') return obj.deployment_id;
            if (obj && typeof obj.id === 'string') return obj.id;
        } catch (_) { }
    }
    return trimmed;
}

function fetchManifest(deploymentId) {
    let toml = '';
    let offset = 0;
    for (let guard = 0; guard < 256; guard++) {
        const raw = webapi.getDeployment(deploymentId, null, offset, null, null);
        let record;
        try { record = JSON.parse(raw); }
        catch (e) { throw `get-deployment returned non-JSON: ${e.message}`; }
        toml += typeof record.deployment_toml === 'string' ? record.deployment_toml : '';
        const nextOffset = (record.manifest_window || {}).next_offset;
        if (nextOffset == null) return toml;
        if (typeof nextOffset !== 'number' || nextOffset <= offset) {
            throw `manifest paging stalled at offset ${offset} (next=${nextOffset})`;
        }
        offset = nextOffset;
    }
    throw 'manifest paging did not terminate';
}

function collectSources(toml) {
    const seen = new Set();
    const out = [];
    let wanted = false;
    let inSubtable = false;
    let location = null;
    let digest = null;
    const flush = () => {
        if (wanted && location && digest && !location.startsWith('oci://') && !seen.has(location)) {
            seen.add(location);
            out.push([location, digest]);
        }
        wanted = false;
        inSubtable = false;
        location = null;
        digest = null;
    };
    for (const line of toml.split('\n')) {
        const t = line.trim();
        if (t.startsWith('[[')) {
            flush();
            wanted = t === '[[activity_js]]' || t === '[[activity_exec]]' || t === '[[workflow_js]]' || t === '[[webhook_endpoint_js]]';
            continue;
        }
        if (t.startsWith('[')) { inSubtable = true; continue; }
        if (!wanted || inSubtable) continue;
        const loc = tomlString(t, 'location');
        if (loc !== null) location = loc;
        const dig = tomlString(t, 'content_digest');
        if (dig !== null) digest = dig;
    }
    flush();
    return out;
}

function tomlString(line, key) {
    if (!line.startsWith(key)) return null;
    const rest = line.slice(key.length).trim();
    if (!rest.startsWith('=')) return null;
    const value = rest.slice(1).trim();
    if (value.length < 2 || value.charCodeAt(0) !== 34 || value.charCodeAt(value.length - 1) !== 34) return null;
    return value.slice(1, -1);
}
