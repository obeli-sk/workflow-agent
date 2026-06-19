// agent-herder:github/repo.create-branch:
//   func(owner: string, repo: string, base-branch: string, new-branch: string)
//     -> result<string, string>
// Resolves the SHA of `base-branch`, then creates refs/heads/<new-branch> at
// that SHA. Returns the new branch's head commit OID (initially == base SHA),
// which the caller threads into the first push-file commit.
export default async function createBranch(owner, repo, baseBranch, newBranch) {
    if (!owner) throw "owner is required";
    if (!repo) throw "repo is required";
    if (!baseBranch) throw "base-branch is required";
    if (!newBranch) throw "new-branch is required";

    const token = process.env["AGENT_HERDER_GITHUB_TOKEN"];
    if (!token) throw "AGENT_HERDER_GITHUB_TOKEN is not set";

    const apiBase = "https://api.github.com";
    const headers = {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "obelisk-agent-herder",
    };

    const baseSha = await readBranchSha(apiBase, headers, owner, repo, baseBranch, "base");

    const createResp = await fetch(
        `${apiBase}/repos/${owner}/${repo}/git/refs`,
        {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({
                ref: `refs/heads/${newBranch}`,
                sha: baseSha,
            }),
        },
    );
    if (createResp.ok) return baseSha;

    const text = await createResp.text();
    if (createResp.status === 422) {
        console.log(`Branch ${newBranch} already exists; using its current head.`);
        return await readBranchSha(apiBase, headers, owner, repo, newBranch, "existing branch");
    }

    throw `failed to create branch ${newBranch}: HTTP ${createResp.status}: ${text}`;
}

async function readBranchSha(apiBase, headers, owner, repo, branch, label) {
    const resp = await fetch(
        `${apiBase}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
        { headers },
    );
    if (!resp.ok) {
        throw `failed to read ${label} ref ${branch}: HTTP ${resp.status}: ${await resp.text()}`;
    }
    const json = await resp.json();
    const sha = json && json.object && json.object.sha;
    if (!sha) throw `${label} ref response missing object.sha: ${JSON.stringify(json)}`;
    return sha;
}
