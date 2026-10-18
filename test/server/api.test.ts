/**
 * test/server/api.test.ts
 *
 * Full API test suite covering:
 * - Health & config endpoints
 * - Strict body and URL validation
 * - Orchestration of Rules Only vs Rules + Gemma modes
 * - Upstream error mapping and secret hiding
 * - Internal schema validation failure (502)
 * - Evaluation timeout (504)
 * - Rate limiting (429 with Retry-After)
 * - Security headers & missing model-card handling
 *
 * Uses Node's built-in fetch against createApp(...).listen(0) on ephemeral ports.
 * No supertest. All dependencies mockable via Deps injection.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { Server } from "http";
import fs from "fs";
import { createApp, type Deps } from "../../src/server.js";
import { Scorecard, type RepoSnapshot, type RuleCheck, type GemmaVerdict } from "../../src/schema.js";

function startTestServer(options: Parameters<typeof createApp>[0] = {}): Promise<{
  server: Server;
  url: string;
}> {
  return new Promise((resolve, reject) => {
    const app = createApp(options);
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

const mockSnapshot: RepoSnapshot = {
  url: "https://github.com/mock-owner/mock-repo",
  owner: "mock-owner",
  name: "mock-repo",
  isPublic: true,
  license: "MIT",
  readme: "# Mock\n\nA great test repository with clear docs.",
  fileTree: ["README.md", "LICENSE", "package.json"],
  commitCount: 20,
  contributors: [{ login: "coder", commits: 20 }],
  hasCI: true,
  hasTests: true,
  hasCodeOfConduct: true,
  linksMlhCoc: false,
  fetchedAt: "2026-10-17T10:00:00.000Z",
};

const mockRules: RuleCheck[] = [
  { id: "has_readme", criterion: "clear_problem", pass: true, evidence: "README found" },
  { id: "has_commits", criterion: "substantial_work", pass: true, evidence: "20 commits" },
  { id: "has_license", criterion: "easy_to_verify", pass: true, evidence: "MIT" },
  { id: "has_ci", criterion: "demo_explanation", pass: true, evidence: "CI found" },
  { id: "has_coc", criterion: "collaboration", pass: true, evidence: "CoC found" },
  { id: "has_tree", criterion: "submission", pass: true, evidence: "Files found" },
];

const mockVerdicts: GemmaVerdict[] = [
  {
    criterion: "clear_problem",
    score: 4,
    reasoning: "Good problem statement",
    evidence: ["README present"],
    suggestion: "Add problem heading",
  },
];

describe("RepoJudge Server API", () => {
  let activeServers: Server[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of activeServers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
    activeServers = [];
  });

  // ---- GET /api/health ----------------------------------------
  it("GET /api/health returns 200, { status: 'ok' }, dataSource, and no secrets", async () => {
    const { server, url } = await startTestServer();
    activeServers.push(server);

    const res = await fetch(`${url}/api/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(["stub", "live"]).toContain(body.dataSource);
    expect(typeof body.time).toBe("string");

    // Ensure no unexpected secret keys leaked
    expect(Object.keys(body).sort()).toEqual(["dataSource", "status", "time"]);
  });

  // ---- Security headers ---------------------------------------
  it("sets required security headers on all responses", async () => {
    const { server, url } = await startTestServer();
    activeServers.push(server);

    const res = await fetch(`${url}/api/health`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(res.headers.get("x-powered-by")).toBeNull();
  });

  // ---- GET /api/config ----------------------------------------
  it("GET /api/config returns repoUrl starting with https://github.com/ or null", async () => {
    const { server, url } = await startTestServer();
    activeServers.push(server);

    const res = await fetch(`${url}/api/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { repoUrl: string | null };
    if (body.repoUrl !== null) {
      expect(body.repoUrl.startsWith("https://github.com/")).toBe(true);
    }
  });

  // ---- GET /model-card ----------------------------------------
  it("GET /model-card handles missing file gracefully with 404 { error: string }", async () => {
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    const { server, url } = await startTestServer();
    activeServers.push(server);

    const res = await fetch(`${url}/model-card`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("error");
    expect(Object.keys(body)).toEqual(["error"]);
  });

  // ---- Unknown API route 404 ----------------------------------
  it("unknown /api/* routes return 404 { error: string }", async () => {
    const { server, url } = await startTestServer();
    activeServers.push(server);

    const res = await fetch(`${url}/api/nonexistent`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: "API endpoint not found." });
  });

  // ---- Invalid Request Bodies ---------------------------------
  describe("POST /api/judge - Body validation", () => {
    it("returns 400 { error } on non-JSON body", async () => {
      const { server, url } = await startTestServer();
      activeServers.push(server);

      const res = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json-at-all",
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["error"]);
      expect(typeof body.error).toBe("string");
    });

    it("returns 400 { error } when url is missing", async () => {
      const { server, url } = await startTestServer();
      activeServers.push(server);

      const res = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "rules" }), // missing url
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["error"]);
    });

    it("succeeds when mode is omitted (single-input flow auto-detects AI or rules)", async () => {
      const buildSnapshot = vi.fn().mockResolvedValue(mockSnapshot);
      const runRules = vi.fn().mockReturnValue(mockRules);
      const judge = vi.fn().mockResolvedValue({ verdicts: mockVerdicts, unscored: [] });
      const mergeScorecard = vi.fn().mockReturnValue({
        repo: "mock-owner/mock-repo",
        mode: "rules+ai",
        rules: mockRules,
        verdicts: mockVerdicts,
        unscored: [],
        total: 5,
        rulesTotal: 5,
        model: { name: "test-model", servedBy: "test" },
        generatedAt: "2026-10-17T10:00:00.000Z",
      });

      const { server, url } = await startTestServer({
        deps: { buildSnapshot, runRules, judge, mergeScorecard },
      });
      activeServers.push(server);

      const res = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/mock-owner/mock-repo" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.repo).toBe("mock-owner/mock-repo");
    });

    it("returns 400 { error } when unknown keys are sent (strict schema)", async () => {
      const { server, url } = await startTestServer();
      activeServers.push(server);

      const res = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://github.com/owner/repo",
          mode: "rules",
          extraJunk: true,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["error"]);
    });

    it("returns 400 { error } when mode is invalid", async () => {
      const { server, url } = await startTestServer();
      activeServers.push(server);

      const res = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://github.com/owner/repo",
          mode: "gpt-4",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["error"]);
    });
  });

  // ---- URL Validation -----------------------------------------
  describe("POST /api/judge - URL validation", () => {
    const invalidUrls = [
      ["http scheme", "http://github.com/owner/repo"],
      ["non-github host", "https://gitlab.com/owner/repo"],
      ["lookalike host", "https://github.com.evil.com/owner/repo"],
      ["extra path segment", "https://github.com/owner/repo/extra"],
      ["credentials in URL", "https://user:pass@github.com/owner/repo"],
      ["port in URL", "https://github.com:8080/owner/repo"],
      ["javascript scheme", "javascript:alert(1)"],
      ["query string", "https://github.com/owner/repo?token=secret"],
      ["fragment", "https://github.com/owner/repo#frag"],
      ["too long (>200 chars)", `https://github.com/owner/${"a".repeat(210)}`],
    ];

    for (const [desc, badUrl] of invalidUrls) {
      it(`rejects invalid URL (${desc}) with 400 and never calls buildSnapshot`, async () => {
        const buildSnapshot = vi.fn();
        const { server, url } = await startTestServer({
          deps: { buildSnapshot },
        });
        activeServers.push(server);

        const res = await fetch(`${url}/api/judge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: badUrl, mode: "rules" }),
        });

        expect(res.status).toBe(400);
        const body = (await res.json()) as Record<string, unknown>;
        expect(Object.keys(body)).toEqual(["error"]);
        expect(buildSnapshot).not.toHaveBeenCalled();
      });
    }

    it("normalizes trailing slash and .git in URL correctly", async () => {
      const buildSnapshot = vi.fn().mockResolvedValue(mockSnapshot);
      const runRules = vi.fn().mockReturnValue(mockRules);
      const mergeScorecard = vi.fn().mockReturnValue({
        repo: "https://github.com/owner/repo",
        mode: "rules",
        rules: mockRules,
        verdicts: [],
        unscored: [],
        total: 6,
        model: null,
        generatedAt: "2026-10-17T10:00:00.000Z",
      });

      const { server, url } = await startTestServer({
        deps: { buildSnapshot, runRules, mergeScorecard },
      });
      activeServers.push(server);

      const res = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/owner/repo.git/", mode: "rules" }),
      });

      expect(res.status).toBe(200);
      expect(buildSnapshot).toHaveBeenCalledWith("https://github.com/owner/repo");
    });
  });

  // ---- Mode Orchestration -------------------------------------
  describe("POST /api/judge - Orchestration & Mode correctness", () => {
    it("in Rules Only mode: judge mock is called 0 times, merge receives empty verdicts, response parses with Scorecard", async () => {
      const buildSnapshot = vi.fn().mockResolvedValue(mockSnapshot);
      const runRules = vi.fn().mockReturnValue(mockRules);
      const judgeMock = vi.fn();
      const mergeScorecard = vi.fn().mockImplementation((snap, rules, verdicts, mode) => ({
        repo: snap.url,
        mode,
        rules,
        verdicts,
        unscored: [],
        total: rules.filter((r: RuleCheck) => r.pass).length,
        model: null,
        generatedAt: new Date().toISOString(),
      }));

      const { server, url } = await startTestServer({
        deps: {
          buildSnapshot,
          runRules,
          judge: judgeMock,
          mergeScorecard,
        },
      });
      activeServers.push(server);

      const res = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/owner/repo", mode: "rules" }),
      });

      expect(res.status).toBe(200);
      expect(judgeMock).not.toHaveBeenCalled();
      expect(mergeScorecard).toHaveBeenCalledWith(
        mockSnapshot,
        mockRules,
        [], // empty verdicts in rules mode
        "rules"
      );

      const body = await res.json();
      const parsed = Scorecard.safeParse(body);
      expect(parsed.success).toBe(true);
      expect(body.mode).toBe("rules");
      expect(body.model).toBeNull();
    });

    it("in Rules + Gemma mode: judge is called exactly once, response validates with Scorecard", async () => {
      const buildSnapshot = vi.fn().mockResolvedValue(mockSnapshot);
      const runRules = vi.fn().mockReturnValue(mockRules);
      const judgeMock = vi.fn().mockResolvedValue({
        verdicts: mockVerdicts,
        unscored: ["submission"],
      });
      const mergeScorecard = vi.fn().mockImplementation((snap, rules, verdicts, mode) => ({
        repo: snap.url,
        mode,
        rules,
        verdicts,
        unscored: ["submission"],
        total: null,
        model: { name: "gemma-test", servedBy: "test-provider", openWeight: true },
        generatedAt: new Date().toISOString(),
      }));

      const { server, url } = await startTestServer({
        deps: {
          buildSnapshot,
          runRules,
          judge: judgeMock,
          mergeScorecard,
        },
      });
      activeServers.push(server);

      const res = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/owner/repo", mode: "rules+gemma" }),
      });

      expect(res.status).toBe(200);
      expect(judgeMock).toHaveBeenCalledTimes(1);
      expect(judgeMock).toHaveBeenCalledWith(mockSnapshot);

      const body = await res.json();
      const parsed = Scorecard.safeParse(body);
      expect(parsed.success).toBe(true);
      expect(body.mode).toBe("rules+gemma");
      expect(body.total).toBeNull();
      expect(body.unscored).toEqual(["submission"]);
    });

    it("accepts customRules in request body, executes them, and passes results to mergeScorecard", async () => {
      const buildSnapshot = vi.fn().mockResolvedValue(mockSnapshot);
      const runRules = vi.fn().mockReturnValue(mockRules);
      const mergeScorecard = vi.fn().mockImplementation((snap, rules, verdicts, mode, unscored, servedBy, modelName, customRules) => ({
        repo: `${snap.owner}/${snap.name}`,
        mode,
        rules,
        customRules: customRules ?? [],
        verdicts: [],
        unscored: [],
        total: 20,
        model: null,
        generatedAt: new Date().toISOString(),
      }));

      const { server, url } = await startTestServer({
        deps: { buildSnapshot, runRules, mergeScorecard },
      });
      activeServers.push(server);

      const customRule = {
        id: "check-license-file",
        name: "License Exists",
        check: "file_exists",
        params: { path: "LICENSE" },
        severity: "high",
        weight: 2,
      };

      const res = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://github.com/owner/repo",
          mode: "rules",
          customRules: [customRule],
        }),
      });

      expect(res.status).toBe(200);
      expect(mergeScorecard).toHaveBeenCalled();
      const body = await res.json();
      expect(body.customRules).toHaveLength(1);
      expect(body.customRules[0].id).toBe("check-license-file");
      expect(body.customRules[0].pass).toBe(true);
    });
  });

  // ---- Error Mapping & Secrets Hiding -------------------------
  describe("POST /api/judge - Upstream error handling", () => {
    it("never leaks secrets or stack traces on raw Error, returns generic 500", async () => {
      const buildSnapshot = vi.fn().mockRejectedValue(
        new Error("Secret github_pat_11AAAAAA failed with stack trace at /internal/secrets.ts:42")
      );

      const { server, url } = await startTestServer({
        deps: { buildSnapshot },
      });
      activeServers.push(server);

      const res = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/owner/repo", mode: "rules" }),
      });

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body).toEqual({
        error: "Something went wrong while evaluating this repository.",
      });
      expect(JSON.stringify(body)).not.toContain("github_pat");
      expect(JSON.stringify(body)).not.toContain("internal");
    });

    it("respects safe publicMessage and status from upstream errors", async () => {
      const customErr = new Error("internal details") as Error & {
        status?: number;
        publicMessage?: string;
      };
      customErr.status = 404;
      customErr.publicMessage = "Repository was not found or is private.";

      const buildSnapshot = vi.fn().mockRejectedValue(customErr);

      const { server, url } = await startTestServer({
        deps: { buildSnapshot },
      });
      activeServers.push(server);

      const res = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/owner/repo", mode: "rules" }),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ error: "Repository was not found or is private." });
    });

    it("returns 504 { error } when evaluation times out", async () => {
      const buildSnapshot = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(resolve, 500))
      );

      const { server, url } = await startTestServer({
        deps: { buildSnapshot },
        timeoutMs: 50, // fast timeout for test
      });
      activeServers.push(server);

      const res = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/owner/repo", mode: "rules" }),
      });

      expect(res.status).toBe(504);
      const body = await res.json();
      expect(body).toEqual({ error: "The evaluation timed out. Please retry." });
    });

    it("returns 502 { error } when final scorecard fails schema validation", async () => {
      const buildSnapshot = vi.fn().mockResolvedValue(mockSnapshot);
      const runRules = vi.fn().mockReturnValue(mockRules);
      // Malformed scorecard (violates schema: total is a string instead of number|null)
      const mergeScorecard = vi.fn().mockReturnValue({
        repo: "https://github.com/owner/repo",
        mode: "rules",
        rules: mockRules,
        verdicts: [],
        unscored: [],
        total: "invalid-string-score" as unknown as number,
        model: null,
        generatedAt: "2026-10-17T10:00:00.000Z",
      });

      const { server, url } = await startTestServer({
        deps: { buildSnapshot, runRules, mergeScorecard },
      });
      activeServers.push(server);

      const res = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/owner/repo", mode: "rules" }),
      });

      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body).toEqual({ error: "Internal result validation failed." });
    });
  });

  // ---- Rate Limiting & Caching -------------------------------
  describe("POST /api/judge - Rate Limiting & Caching", () => {
    it("returns 429 with Retry-After header and { error } when rate limit is exceeded on cache misses", async () => {
      const buildSnapshot = vi.fn().mockImplementation((url: string) => {
        const parts = url.replace("https://github.com/", "").split("/");
        return { ...mockSnapshot, owner: parts[0], name: parts[1] };
      });
      const runRules = vi.fn().mockReturnValue(mockRules);
      const mergeScorecard = vi.fn().mockImplementation((snap: RepoSnapshot) => ({
        repo: `${snap.owner}/${snap.name}`,
        mode: "rules",
        rules: mockRules,
        verdicts: [],
        unscored: [],
        total: 6,
        rulesTotal: 6,
        model: null,
        generatedAt: "2026-10-17T10:00:00.000Z",
      }));

      // Inject tiny rate limit: 2 requests per window
      const { server, url } = await startTestServer({
        deps: { buildSnapshot, runRules, mergeScorecard },
        rateLimit: { windowMs: 10_000, maxRequests: 2 },
      });
      activeServers.push(server);

      // Request 1: ok (miss)
      const r1 = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/owner/repo-1" }),
      });
      expect(r1.status).toBe(200);
      expect(r1.headers.get("x-repojudge-cache")).toBe("MISS");

      // Request 2: ok (miss)
      const r2 = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/owner/repo-2" }),
      });
      expect(r2.status).toBe(200);
      expect(r2.headers.get("x-repojudge-cache")).toBe("MISS");

      // Request 3: rate limited
      const r3 = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/owner/repo-3" }),
      });
      expect(r3.status).toBe(429);
      expect(r3.headers.get("retry-after")).toBeTruthy();

      const body = (await r3.json()) as { error: string };
      expect(body.error).toContain("Too many requests");
    });

    it("cache hits do NOT count toward rate limit", async () => {
      const buildSnapshot = vi.fn().mockResolvedValue(mockSnapshot);
      const runRules = vi.fn().mockReturnValue(mockRules);
      const mergeScorecard = vi.fn().mockReturnValue({
        repo: "mock-owner/mock-repo",
        mode: "rules",
        rules: mockRules,
        verdicts: [],
        unscored: [],
        total: 6,
        rulesTotal: 6,
        model: null,
        generatedAt: "2026-10-17T10:00:00.000Z",
      });

      // Max requests = 1
      const { server, url } = await startTestServer({
        deps: { buildSnapshot, runRules, mergeScorecard },
        rateLimit: { windowMs: 10_000, maxRequests: 1 },
      });
      activeServers.push(server);

      // 1. Initial request: MISS (consumes the 1 token)
      const r1 = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/mock-owner/mock-repo" }),
      });
      expect(r1.status).toBe(200);
      expect(r1.headers.get("x-repojudge-cache")).toBe("MISS");

      // 2. Repeat requests to the same URL are HITs and succeed despite token exhaustion
      for (let i = 0; i < 3; i++) {
        const rHit = await fetch(`${url}/api/judge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: "https://github.com/mock-owner/mock-repo" }),
        });
        expect(rHit.status).toBe(200);
        expect(rHit.headers.get("x-repojudge-cache")).toBe("HIT");
      }

      // 3. New URL is a MISS and gets rate limited
      const rNew = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://github.com/mock-owner/other-repo" }),
      });
      expect(rNew.status).toBe(429);
    });

    it("respects X-Forwarded-For with trust proxy enabled", async () => {
      const buildSnapshot = vi.fn().mockImplementation((url: string) => {
        const parts = url.replace("https://github.com/", "").split("/");
        return { ...mockSnapshot, owner: parts[0], name: parts[1] };
      });
      const runRules = vi.fn().mockReturnValue(mockRules);
      const mergeScorecard = vi.fn().mockImplementation((snap: RepoSnapshot) => ({
        repo: `${snap.owner}/${snap.name}`,
        mode: "rules",
        rules: mockRules,
        verdicts: [],
        unscored: [],
        total: 6,
        rulesTotal: 6,
        model: null,
        generatedAt: "2026-10-17T10:00:00.000Z",
      }));

      // Rate limit: 1 request per IP
      const { server, url } = await startTestServer({
        deps: { buildSnapshot, runRules, mergeScorecard },
        rateLimit: { windowMs: 10_000, maxRequests: 1 },
      });
      activeServers.push(server);

      // Client A makes request
      const rA1 = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.10",
        },
        body: JSON.stringify({ url: "https://github.com/owner/repo-a" }),
      });
      expect(rA1.status).toBe(200);

      // Client A makes second request -> rate limited
      const rA2 = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.10",
        },
        body: JSON.stringify({ url: "https://github.com/owner/repo-a2" }),
      });
      expect(rA2.status).toBe(429);

      // Client B from different IP makes request -> succeeds!
      const rB1 = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.20",
        },
        body: JSON.stringify({ url: "https://github.com/owner/repo-b" }),
      });
      expect(rB1.status).toBe(200);
    });

    it("non-blocking AI: returns 200 with rule results and aiFailed: true when judge throws", async () => {
      const buildSnapshot = vi.fn().mockResolvedValue(mockSnapshot);
      const runRules = vi.fn().mockReturnValue(mockRules);
      const judge = vi.fn().mockRejectedValue(new Error("AI Provider Rate Limit (429)"));

      const { server, url } = await startTestServer({
        deps: { buildSnapshot, runRules, judge },
      });
      activeServers.push(server);

      const res = await fetch(`${url}/api/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://github.com/mock-owner/mock-repo-ai-fail",
          mode: "rules+ai",
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.rulesTotal).toBeDefined();
      expect(body.aiFailed).toBe(true);
      expect(body.unscored.length).toBe(6);
    });
  });
});
