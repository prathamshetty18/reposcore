import { Octokit } from "@octokit/rest";
import { RepoSnapshot } from "../schema.js";

export class IngestError extends Error {
  readonly status: number;
  readonly publicMessage: string;

  constructor(message: string, status: number) {
    super(message);
    this.name = "IngestError";
    this.status = status;
    this.publicMessage = message;
    Object.setPrototypeOf(this, IngestError.prototype);
  }
}

export function parseGithubUrl(rawUrl: string): {
  owner: string;
  name: string;
  canonicalUrl: string;
} {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new IngestError("Invalid GitHub repository URL", 400);
  }

  let parsed: URL;
  try {
    const withProto = /^https?:\/\//i.test(rawUrl.trim())
      ? rawUrl.trim()
      : `https://${rawUrl.trim()}`;
    parsed = new URL(withProto);
  } catch {
    throw new IngestError("Invalid GitHub repository URL", 400);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname !== "www.github.com") {
    throw new IngestError(
      "URL must be a github.com repository (e.g. https://github.com/owner/repo).",
      400
    );
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new IngestError(
      "Invalid GitHub repository URL: missing owner or repository name.",
      400
    );
  }

  const owner = segments[0];
  const name = segments[1].replace(/\.git$/i, "");
  if (!owner || !name) {
    throw new IngestError(
      "Invalid GitHub repository URL: missing owner or repository name.",
      400
    );
  }

  const canonicalUrl = `https://github.com/${owner}/${name}`;
  return { owner, name, canonicalUrl };
}

function handleOctokitError(err: unknown, token?: string): never {
  let message = err instanceof Error ? err.message : String(err);
  if (token && token.trim().length > 0) {
    message = message.replaceAll(token, "[REDACTED]");
  }

  const status =
    typeof (err as { status?: number })?.status === "number"
      ? (err as { status?: number }).status!
      : 500;

  if (
    status === 404 ||
    (status === 403 && message.toLowerCase().includes("not found"))
  ) {
    throw new IngestError("Repository not found or private.", 404);
  }

  const headers = (err as { response?: { headers?: Record<string, string> } })
    ?.response?.headers;
  const isRateLimit =
    status === 429 ||
    (status === 403 &&
      (headers?.["x-ratelimit-remaining"] === "0" ||
        message.toLowerCase().includes("rate limit") ||
        message.toLowerCase().includes("secondary rate limit")));

  if (isRateLimit) {
    const resetHeader = headers?.["x-ratelimit-reset"];
    const resetTime = resetHeader
      ? new Date(Number(resetHeader) * 1000).toISOString()
      : "later";
    throw new IngestError(
      `GitHub API rate limit exceeded. Resets at ${resetTime}.`,
      429
    );
  }

  if (
    status === 404 ||
    status === 403 ||
    message.toLowerCase().includes("not found")
  ) {
    throw new IngestError("Repository not found or private.", 404);
  }

  if (
    status === 409 ||
    message.toLowerCase().includes("git repository is empty")
  ) {
    throw new IngestError("Repository is empty.", 422);
  }

  throw new IngestError(
    `GitHub API error: ${message}`,
    status >= 400 && status < 600 ? status : 500
  );
}

export interface BuildSnapshotOptions {
  octokit?: Octokit;
  token?: string;
}

export async function buildSnapshot(
  url: string,
  options?: BuildSnapshotOptions
): Promise<RepoSnapshot> {
  const { owner, name, canonicalUrl } = parseGithubUrl(url);

  const token = options?.token ?? process.env["GITHUB_TOKEN"];
  const octokit =
    options?.octokit ??
    new Octokit({
      auth: token && token.trim().length > 0 ? token.trim() : undefined,
    });

  // 1. Fetch Repository Metadata
  let repoData: {
    private: boolean;
    license: { spdx_id?: string | null } | null;
    default_branch: string;
    size: number;
  };

  try {
    const repoRes = await octokit.repos.get({ owner, repo: name });
    repoData = repoRes.data as typeof repoData;
  } catch (err) {
    handleOctokitError(err, token);
  }

  if (repoData.private) {
    throw new IngestError("Repository not found or private.", 404);
  }

  const isPublic = !repoData.private;
  const spdxId = repoData.license?.spdx_id;
  const license =
    spdxId && spdxId !== "NOASSERTION" ? spdxId : null;
  const defaultBranch = repoData.default_branch || "main";

  // 2. Fetch README
  let readme: string | null = null;
  try {
    const readmeRes = await octokit.repos.getReadme({ owner, repo: name });
    if (readmeRes.data && "content" in readmeRes.data && readmeRes.data.content) {
      const decoded = Buffer.from(
        readmeRes.data.content,
        "base64"
      ).toString("utf-8");
      readme = decoded.slice(0, 12000);
    }
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    if (status !== 404) {
      // Non-404 errors during optional readme fetch can be checked for rate limit
      const headers = (
        err as { response?: { headers?: Record<string, string> } }
      )?.response?.headers;
      if (
        status === 429 ||
        (status === 403 && headers?.["x-ratelimit-remaining"] === "0")
      ) {
        handleOctokitError(err, token);
      }
    }
    readme = null;
  }

  // 3. Fetch File Tree (recursive on default branch, capped at 500)
  let fileTree: string[] = [];
  let commitSha: string | null = null;
  try {
    const treeRes = await octokit.git.getTree({
      owner,
      repo: name,
      tree_sha: defaultBranch,
      recursive: "1",
    });

    if (treeRes.data && typeof (treeRes.data as { sha?: string }).sha === "string") {
      commitSha = (treeRes.data as { sha?: string }).sha ?? null;
    }

    if (treeRes.data && Array.isArray(treeRes.data.tree)) {
      fileTree = treeRes.data.tree
        .filter(
          (item) => item.type === "blob" && typeof item.path === "string"
        )
        .map((item) => item.path as string)
        .slice(0, 500);
    }
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    const msg = (err as Error)?.message?.toLowerCase() ?? "";
    if (status === 409 || msg.includes("git repository is empty")) {
      throw new IngestError("Repository is empty.", 422);
    }
    handleOctokitError(err, token);
  }

  // 4. Fetch Contributors & Commit Count (max 5 pages)
  const contributors: Array<{ login: string; commits: number }> = [];
  const MAX_PAGES = 5;

  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await octokit.repos.listContributors({
        owner,
        repo: name,
        per_page: 100,
        page,
      });

      if (!res.data || !Array.isArray(res.data) || res.data.length === 0) {
        break;
      }

      for (const c of res.data) {
        contributors.push({
          login: c.login ?? `contributor-${c.id ?? contributors.length + 1}`,
          commits: typeof c.contributions === "number" ? c.contributions : 0,
        });
      }

      if (res.data.length < 100) {
        break;
      }
    }
  } catch (err: unknown) {
    const status = (err as { status?: number })?.status;
    if (status === 204) {
      // 204 No Content can be returned for empty repos
    } else {
      handleOctokitError(err, token);
    }
  }

  const commitCount = contributors.reduce((sum, c) => sum + c.commits, 0);

  // If repo has size 0 or no commits and no files, mark as empty
  if (repoData.size === 0 || (commitCount === 0 && fileTree.length === 0)) {
    throw new IngestError("Repository is empty.", 422);
  }

  // 5. Derived Flags
  // hasCI: any path starts with .github/workflows/
  const hasCI = fileTree.some((p) => p.startsWith(".github/workflows/"));

  // hasTests: path contains a test, tests or __tests__ directory, or filename matches *.test.* or *_test.* or *.spec.*
  const hasTests = fileTree.some((p) => {
    const parts = p.split("/");
    const dirParts = parts.slice(0, -1);
    const inTestDir = dirParts.some((dir) => {
      const lower = dir.toLowerCase();
      return lower === "test" || lower === "tests" || lower === "__tests__";
    });
    if (inTestDir) return true;

    const filename = parts[parts.length - 1]?.toLowerCase() ?? "";
    return (
      filename.includes(".test.") ||
      filename.includes("_test.") ||
      filename.includes(".spec.") ||
      /(\.test|_test|\.spec)\.[^.]+$/i.test(filename)
    );
  });

  // hasCodeOfConduct: CODE_OF_CONDUCT.md exists in tree, or README mentions "code of conduct"
  const cocPathInTree = fileTree.find((p) => {
    const filename = p.split("/").pop()?.toLowerCase();
    return (
      filename === "code_of_conduct.md" ||
      filename === "code-of-conduct.md" ||
      filename === "code_of_conduct" ||
      filename === "code-of-conduct"
    );
  });
  const lowerReadme = readme?.toLowerCase() ?? "";
  const hasCodeOfConduct =
    Boolean(cocPathInTree) || lowerReadme.includes("code of conduct");

  // linksMlhCoc: README or CODE_OF_CONDUCT.md text contains "mlh" and "code-of-conduct"
  let linksMlhCoc =
    lowerReadme.includes("mlh") && lowerReadme.includes("code-of-conduct");

  if (!linksMlhCoc && cocPathInTree) {
    try {
      const cocRes = await octokit.repos.getContent({
        owner,
        repo: name,
        path: cocPathInTree,
      });
      if (
        cocRes.data &&
        "content" in cocRes.data &&
        typeof cocRes.data.content === "string"
      ) {
        const cocText = Buffer.from(cocRes.data.content, "base64")
          .toString("utf-8")
          .toLowerCase();
        if (cocText.includes("mlh") && cocText.includes("code-of-conduct")) {
          linksMlhCoc = true;
        }
      }
    } catch {
      // Ignore failures fetching optional code of conduct file
    }
  }

  const fetchedAt = new Date().toISOString();

  const snapshot: RepoSnapshot = {
    url: canonicalUrl,
    owner,
    name,
    isPublic,
    license,
    readme,
    fileTree,
    commitCount,
    commitSha: commitSha ?? null,
    contributors,
    hasCI,
    hasTests,
    hasCodeOfConduct,
    linksMlhCoc,
    fetchedAt,
  };

  return RepoSnapshot.parse(snapshot);
}
