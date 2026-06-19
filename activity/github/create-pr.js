// agent-herder:github/repo.create-pr:
//   func(owner: string, repo: string, head-branch: string, base-branch: string,
//        title: string, body: string) -> result<string, string>
// Opens a PR via the REST API and returns its html_url.
export default async function createPr(
    owner, repo, headBranch, baseBranch, title, body,
) {
    if (!owner) throw "owner is required";
    if (!repo) throw "repo is required";
    if (!headBranch) throw "head-branch is required";
    if (!baseBranch) throw "base-branch is required";
    if (!title) throw "title is required";

    const token = process.env["AGENT_HERDER_GITHUB_TOKEN"];
    if (!token) throw "AGENT_HERDER_GITHUB_TOKEN is not set";

    const headers = {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
        "user-agent": "obelisk-agent-herder",
    };

    const resp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls`,
        {
            method: "POST",
            headers,
            body: JSON.stringify({
                title,
                head: headBranch,
                base: baseBranch,
                body: body || "",
            }),
        },
    );
    if (resp.ok) {
        const json = await resp.json();
        return json.html_url || JSON.stringify(json);
    }

    const text = await resp.text();
    if (resp.status === 422) {
        const existing = await findOpenPr(headers, owner, repo, headBranch, baseBranch);
        if (existing) return existing;
    }

    throw `failed to create PR: HTTP ${resp.status}: ${text}`;
}

async function findOpenPr(headers, owner, repo, headBranch, baseBranch) {
    const url = new URL(`https://api.github.com/repos/${owner}/${repo}/pulls`);
    url.searchParams.set("state", "open");
    url.searchParams.set("head", `${owner}:${headBranch}`);
    url.searchParams.set("base", baseBranch);

    const resp = await fetch(url.toString(), { headers });
    if (!resp.ok) return null;

    const prs = await resp.json();
    if (!Array.isArray(prs) || prs.length === 0) return null;
    return prs[0].html_url || JSON.stringify(prs[0]);
}
