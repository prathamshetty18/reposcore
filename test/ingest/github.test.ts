import { describe, it, expect, vi } from "vitest";
import { Octokit } from "@octokit/rest";
import { buildSnapshot, IngestError, parseGithubUrl } from "../../src/ingest/github.js";
import { RepoSnapshot } from "../../src/schema.js";

function createMockOctokit(overrides: {
  repo?: Partial<any>;
  readme?: { content?: string } | Error;
  tree?: { tree?: Array<{ path?: string; type?: string }> } | Error;
  contributors?: Array<Array<{ login?: string; contributions?: number; id?: number }>> | Error;
  cocContent?: { content?: string } | Error;
} = {}) {
  const getRepo = vi.fn().mockImplementation(async () => {
    if (overrides.repo instanceof Error) throw overrides.repo;
    return {
      data: {
        private: false,
        license: { spdx_id: "MIT" },
        default_branch: "main",
        size: 100,
        ...overrides.repo,
      },
    };
  });

  const getReadme = vi.fn().mockImplementation(async () => {
    if (overrides.readme instanceof Error) throw overrides.readme;
    if (overrides.readme?.content) {
      return {
        data: {
          content: Buffer.from(overrides.readme.content).toString("base64"),
        },
      };
    }
    return {
      data: {
        content: Buffer.from("# Mock\nCode of conduct and mlh policies at https://mlh/code-of-conduct").toString("base64"),
      },
    };
  });

  const getTree = vi.fn().mockImplementation(async () => {
    if (overrides.tree instanceof Error) throw overrides.tree;
    return {
      data: {
        tree: overrides.tree?.tree ?? [
          { path: ".github/workflows/ci.yml", type: "blob" },
          { path: "src/index.ts", type: "blob" },
          { path: "test/index.test.ts", type: "blob" },
          { path: "CODE_OF_CONDUCT.md", type: "blob" },
        ],
      },
    };
  });

  let contributorCallCount = 0;
  const listContributors = vi.fn().mockImplementation(async () => {
    if (overrides.contributors instanceof Error) throw overrides.contributors;
    if (Array.isArray(overrides.contributors)) {
      const pageData = overrides.contributors[contributorCallCount] ?? [];
      contributorCallCount++;
      return { data: pageData };
    }
    return {
      data: [
        { login: "alice", contributions: 25 },
        { login: "bob", contributions: 15 },
      ],
    };
  });

  const getContent = vi.fn().mockImplementation(async () => {
    if (overrides.cocContent instanceof Error) throw overrides.cocContent;
    if (overrides.cocContent?.content) {
      return {
        data: {
          content: Buffer.from(overrides.cocContent.content).toString("base64"),
        },
      };
    }
    return {
      data: {
        content: Buffer.from("MLH Code of Conduct: https://mlh.io/code-of-conduct").toString("base64"),
      },
    };
  });

  return {
    repos: {
      get: getRepo,
      getReadme,
      listContributors,
      getContent,
    },
    git: {
      getTree,
    },
  } as unknown as Octokit;
}

describe("GitHub Ingest Module", () => {
  describe("URL Parsing (parseGithubUrl)", () => {
    it("parses standard github url", () => {
      const res = parseGithubUrl("https://github.com/octocat/Hello-World");
      expect(res.owner).toBe("octocat");
      expect(res.name).toBe("Hello-World");
      expect(res.canonicalUrl).toBe("https://github.com/octocat/Hello-World");
    });

    it("handles trailing slash", () => {
      const res = parseGithubUrl("https://github.com/octocat/Hello-World/");
      expect(res.owner).toBe("octocat");
      expect(res.name).toBe("Hello-World");
    });

    it("handles .git suffix", () => {
      const res = parseGithubUrl("https://github.com/octocat/Hello-World.git");
      expect(res.owner).toBe("octocat");
      expect(res.name).toBe("Hello-World");
      expect(res.canonicalUrl).toBe("https://github.com/octocat/Hello-World");
    });

    it("handles extra paths like /tree/main", () => {
      const res = parseGithubUrl("https://github.com/octocat/Hello-World/tree/main");
      expect(res.owner).toBe("octocat");
      expect(res.name).toBe("Hello-World");
      expect(res.canonicalUrl).toBe("https://github.com/octocat/Hello-World");
    });

    it("rejects non-github URLs with status 400 IngestError", () => {
      expect(() => parseGithubUrl("https://gitlab.com/octocat/Hello-World")).toThrow(IngestError);
      try {
        parseGithubUrl("https://gitlab.com/octocat/Hello-World");
      } catch (err: any) {
        expect(err.status).toBe(400);
        expect(err.publicMessage).toContain("github.com");
      }
    });

    it("rejects invalid URLs missing owner or repo", () => {
      expect(() => parseGithubUrl("https://github.com/only-owner")).toThrow(IngestError);
      expect(() => parseGithubUrl("not-even-a-url")).toThrow(IngestError);
    });
  });

  describe("Error Cases", () => {
    it("handles 404 (repo not found or private)", async () => {
      const notFoundErr = new Error("Not Found") as any;
      notFoundErr.status = 404;
      const mockOctokit = createMockOctokit({ repo: notFoundErr });

      await expect(buildSnapshot("https://github.com/owner/repo", { octokit: mockOctokit }))
        .rejects.toThrow("Repository not found or private.");
    });

    it("handles 429 rate limit with reset time in message", async () => {
      const rateLimitErr = new Error("API rate limit exceeded") as any;
      rateLimitErr.status = 429;
      rateLimitErr.response = {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1776427200",
        },
      };
      const mockOctokit = createMockOctokit({ repo: rateLimitErr });

      await expect(buildSnapshot("https://github.com/owner/repo", { octokit: mockOctokit }))
        .rejects.toThrow(/rate limit exceeded.*Resets at/);
    });

    it("handles 422 empty repo via 409 git tree error", async () => {
      const emptyErr = new Error("Git Repository is empty") as any;
      emptyErr.status = 409;
      const mockOctokit = createMockOctokit({ tree: emptyErr });

      await expect(buildSnapshot("https://github.com/owner/repo", { octokit: mockOctokit }))
        .rejects.toThrow("Repository is empty.");
    });

    it("handles 422 empty repo via size 0", async () => {
      const mockOctokit = createMockOctokit({ repo: { size: 0 } });

      await expect(buildSnapshot("https://github.com/owner/repo", { octokit: mockOctokit }))
        .rejects.toThrow("Repository is empty.");
    });

    it("never leaks GITHUB_TOKEN in error messages", async () => {
      const secretToken = "ghp_super_secret_github_token_xyz123";
      const leakingErr = new Error(`Failed with authorization header token ${secretToken}`) as any;
      leakingErr.status = 500;
      const mockOctokit = createMockOctokit({ repo: leakingErr });

      try {
        await buildSnapshot("https://github.com/owner/repo", { octokit: mockOctokit, token: secretToken });
        expect.unreachable();
      } catch (err: any) {
        expect(err.message).not.toContain(secretToken);
        expect(err.message).toContain("[REDACTED]");
      }
    });
  });

  describe("README handling & truncation", () => {
    it("truncates README to 12000 characters", async () => {
      const longReadme = "A".repeat(15000);
      const mockOctokit = createMockOctokit({ readme: { content: longReadme } });

      const snap = await buildSnapshot("https://github.com/owner/repo", { octokit: mockOctokit });
      expect(snap.readme).toHaveLength(12000);
      expect(snap.readme).toBe("A".repeat(12000));
    });

    it("returns null when README returns 404", async () => {
      const notFoundErr = new Error("Not Found") as any;
      notFoundErr.status = 404;
      const mockOctokit = createMockOctokit({ readme: notFoundErr });

      const snap = await buildSnapshot("https://github.com/owner/repo", { octokit: mockOctokit });
      expect(snap.readme).toBeNull();
    });
  });

  describe("FileTree handling & truncation", () => {
    it("caps fileTree at 500 items and filters out non-blob entries", async () => {
      const largeTree = Array.from({ length: 600 }, (_, i) => ({
        path: `file-${i}.ts`,
        type: i % 10 === 0 ? "tree" : "blob",
      }));
      const mockOctokit = createMockOctokit({ tree: { tree: largeTree } });

      const snap = await buildSnapshot("https://github.com/owner/repo", { octokit: mockOctokit });
      expect(snap.fileTree.length).toBeLessThanOrEqual(500);
      expect(snap.fileTree.every((p) => typeof p === "string")).toBe(true);
    });
  });

  describe("Derived Flags (true and false conditions)", () => {
    it("hasCI: true when .github/workflows/ is present, false otherwise", async () => {
      const withCi = createMockOctokit({
        tree: { tree: [{ path: ".github/workflows/main.yml", type: "blob" }] },
      });
      const snap1 = await buildSnapshot("https://github.com/owner/repo", { octokit: withCi });
      expect(snap1.hasCI).toBe(true);

      const withoutCi = createMockOctokit({
        tree: { tree: [{ path: "src/app.ts", type: "blob" }] },
      });
      const snap2 = await buildSnapshot("https://github.com/owner/repo", { octokit: withoutCi });
      expect(snap2.hasCI).toBe(false);
    });

    it("hasTests: detects test directory and test filenames", async () => {
      // test directory
      const inTestDir = createMockOctokit({
        tree: { tree: [{ path: "tests/suite.js", type: "blob" }] },
      });
      const s1 = await buildSnapshot("https://github.com/owner/repo", { octokit: inTestDir });
      expect(s1.hasTests).toBe(true);

      // filename pattern *.test.*
      const testFile = createMockOctokit({
        tree: { tree: [{ path: "src/calc.test.ts", type: "blob" }] },
      });
      const s2 = await buildSnapshot("https://github.com/owner/repo", { octokit: testFile });
      expect(s2.hasTests).toBe(true);

      // filename pattern *_test.*
      const pyTest = createMockOctokit({
        tree: { tree: [{ path: "calc_test.py", type: "blob" }] },
      });
      const s3 = await buildSnapshot("https://github.com/owner/repo", { octokit: pyTest });
      expect(s3.hasTests).toBe(true);

      // filename pattern *.spec.*
      const specFile = createMockOctokit({
        tree: { tree: [{ path: "src/calc.spec.js", type: "blob" }] },
      });
      const s4 = await buildSnapshot("https://github.com/owner/repo", { octokit: specFile });
      expect(s4.hasTests).toBe(true);

      // negative case
      const noTests = createMockOctokit({
        tree: { tree: [{ path: "src/main.ts", type: "blob" }] },
      });
      const s5 = await buildSnapshot("https://github.com/owner/repo", { octokit: noTests });
      expect(s5.hasTests).toBe(false);
    });

    it("hasCodeOfConduct: detects CODE_OF_CONDUCT.md or readme mention", async () => {
      // file in tree
      const cocTree = createMockOctokit({
        tree: { tree: [{ path: "CODE_OF_CONDUCT.md", type: "blob" }] },
        readme: { content: "Clean docs without the phrase." },
      });
      const s1 = await buildSnapshot("https://github.com/owner/repo", { octokit: cocTree });
      expect(s1.hasCodeOfConduct).toBe(true);

      // mention in readme
      const cocReadme = createMockOctokit({
        tree: { tree: [{ path: "src/index.ts", type: "blob" }] },
        readme: { content: "We enforce our code of conduct strictly." },
      });
      const s2 = await buildSnapshot("https://github.com/owner/repo", { octokit: cocReadme });
      expect(s2.hasCodeOfConduct).toBe(true);

      // neither
      const cocNone = createMockOctokit({
        tree: { tree: [{ path: "src/index.ts", type: "blob" }] },
        readme: { content: "Just an app." },
      });
      const s3 = await buildSnapshot("https://github.com/owner/repo", { octokit: cocNone });
      expect(s3.hasCodeOfConduct).toBe(false);
    });

    it("linksMlhCoc: detects MLH link in README or CODE_OF_CONDUCT.md", async () => {
      // In README
      const mlhReadme = createMockOctokit({
        readme: { content: "Follow mlh guidelines at mlh.io/code-of-conduct" },
        tree: { tree: [{ path: "src/index.ts", type: "blob" }] },
      });
      const s1 = await buildSnapshot("https://github.com/owner/repo", { octokit: mlhReadme });
      expect(s1.linksMlhCoc).toBe(true);

      // In CODE_OF_CONDUCT.md
      const mlhCocFile = createMockOctokit({
        readme: { content: "No links here." },
        tree: { tree: [{ path: "CODE_OF_CONDUCT.md", type: "blob" }] },
        cocContent: { content: "See the mlh rules: mlh.io/code-of-conduct" },
      });
      const s2 = await buildSnapshot("https://github.com/owner/repo", { octokit: mlhCocFile });
      expect(s2.linksMlhCoc).toBe(true);

      // Negative case
      const noMlh = createMockOctokit({
        readme: { content: "Standard contributor code of conduct." },
        tree: { tree: [{ path: "src/index.ts", type: "blob" }] },
      });
      const s3 = await buildSnapshot("https://github.com/owner/repo", { octokit: noMlh });
      expect(s3.linksMlhCoc).toBe(false);
    });
  });

  describe("Contributors Pagination & License Mapping", () => {
    it("paginates contributors up to max 5 pages and sums commits", async () => {
      const page1 = Array.from({ length: 100 }, (_, i) => ({ login: `user-p1-${i}`, contributions: 2 }));
      const page2 = Array.from({ length: 100 }, (_, i) => ({ login: `user-p2-${i}`, contributions: 2 }));
      const page3 = Array.from({ length: 50 }, (_, i) => ({ login: `user-p3-${i}`, contributions: 2 }));

      const mockOctokit = createMockOctokit({
        contributors: [page1, page2, page3],
      });

      const snap = await buildSnapshot("https://github.com/owner/repo", { octokit: mockOctokit });
      expect(snap.contributors).toHaveLength(250);
      expect(snap.commitCount).toBe(500);
    });

    it("stops pagination after 5 pages even if 5th page has 100 items", async () => {
      const pages = Array.from({ length: 7 }, (_, p) =>
        Array.from({ length: 100 }, (_, i) => ({ login: `user-p${p}-${i}`, contributions: 1 }))
      );

      const mockOctokit = createMockOctokit({
        contributors: pages,
      });

      const snap = await buildSnapshot("https://github.com/owner/repo", { octokit: mockOctokit });
      expect(snap.contributors).toHaveLength(500); // 5 pages * 100
      expect(snap.commitCount).toBe(500);
    });

    it("treats NOASSERTION license as null", async () => {
      const mockOctokit = createMockOctokit({
        repo: { license: { spdx_id: "NOASSERTION" } },
      });

      const snap = await buildSnapshot("https://github.com/owner/repo", { octokit: mockOctokit });
      expect(snap.license).toBeNull();
    });

    it("validates returned snapshot with RepoSnapshot schema", async () => {
      const mockOctokit = createMockOctokit();
      const snap = await buildSnapshot("https://github.com/owner/repo", { octokit: mockOctokit });
      expect(() => RepoSnapshot.parse(snap)).not.toThrow();
    });
  });
});
