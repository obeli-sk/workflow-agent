// agent-herder:github/repo.push-file:
//   func(owner: string, repo: string, branch: string, expected-head-oid: string,
//        path: string, content: string, headline: string, body: string)
//     -> result<string, string>
// One file -> one commit via GitHub's createCommitOnBranch GraphQL mutation
// (GitHub signs the commit on the server side). Returns the new commit OID so
// the workflow can chain it into the next call.
export default async function pushFile(
    owner, repo, branch, expectedHeadOid, path, content, headline, body,
) {
    if (!owner) throw "owner is required";
    if (!repo) throw "repo is required";
    if (!branch) throw "branch is required";
    if (!expectedHeadOid) throw "expected-head-oid is required";
    if (!path) throw "path is required";
    if (typeof content !== "string") throw "content must be a string";
    if (!headline) throw "headline is required";

    const token = process.env["AGENT_HERDER_GITHUB_TOKEN"];
    if (!token) throw "AGENT_HERDER_GITHUB_TOKEN is not set";

    const contentBase64 = utf8ToBase64(content);

    const query = `mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit { oid url }
      }
    }`;
    const variables = {
        input: {
            branch: {
                repositoryNameWithOwner: `${owner}/${repo}`,
                branchName: branch,
            },
            message: { headline, body: body || "" },
            expectedHeadOid,
            fileChanges: {
                additions: [{ path, contents: contentBase64 }],
            },
        },
    };

    const resp = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
            accept: "application/vnd.github+json",
            "content-type": "application/json",
            authorization: `Bearer ${token}`,
            "user-agent": "obelisk-agent-herder",
        },
        body: JSON.stringify({ query, variables }),
    });
    if (!resp.ok) throw `HTTP ${resp.status}: ${await resp.text()}`;
    const respJson = await resp.json();
    if (respJson.errors) throw `GraphQL error: ${JSON.stringify(respJson.errors)}`;
    const oid = respJson
        && respJson.data
        && respJson.data.createCommitOnBranch
        && respJson.data.createCommitOnBranch.commit
        && respJson.data.createCommitOnBranch.commit.oid;
    if (!oid) throw `createCommitOnBranch returned no commit oid: ${JSON.stringify(respJson)}`;
    return oid;
}

// UTF-8 -> base64 without Buffer (not available in the JS activity runtime).
function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
}
