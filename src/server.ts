/**
 * src/server.ts — RepoJudge Express server
 *
 * Architecture: createApp(deps?) for testability.
 * Main guard: starts listening only when run directly.
 * Security: headers set manually (no helmet), rate limiting by hand,
 *           no stack traces ever returned to clients.
 */

import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { z } from "zod";

import { Scorecard } from "./schema.js";

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    // .env file is optional
  }
}

// ============================================================
// ---- MODULE WIRING: swap stubs for real modules here -------
// ---- (one line per import; flip USING_STUBS when swapping) -
// ============================================================
import { buildSnapshot, IngestError } from "./ingest/github.js";
import { runRules }      from "./rules/index.js";
import { judge }         from "./judge/ai.js";
import { mergeScorecard } from "./merge.js";
import { isAIConfigured } from "./judge/provider.js";
// ============================================================
// USING_STUBS: set to false when real modules are wired above.
// While true, every /api/judge response carries:
//   X-RepoJudge-Data-Source: stub
// and /api/health reports { dataSource: "stub" }
const USING_STUBS = false;
// ============================================================

// ---- Types --------------------------------------------------
import type { RepoSnapshot, RuleCheck, AIVerdict } from "./schema.js";

export type Deps = {
  buildSnapshot: (url: string) => Promise<RepoSnapshot>;
  runRules: (snap: RepoSnapshot) => RuleCheck[];
  judge: (
    snap: RepoSnapshot,
    deps?: {
      rules?: RuleCheck[];
      userApiKey?: string;
    }
  ) => Promise<{
    verdicts: AIVerdict[];
    unscored: import("./schema.js").CriterionId[];
    modelInfo?: { name: string; servedBy: string };
  }>;
  mergeScorecard: (
    snap: RepoSnapshot,
    rules: RuleCheck[],
    verdicts: AIVerdict[],
    mode: "rules" | "rules+ai" | "rules+gemma",
    unscored?: import("./schema.js").CriterionId[],
    servedBy?: string | null,
    modelName?: string | null
  ) => import("./schema.js").Scorecard;
};

const defaultDeps: Deps = { buildSnapshot, runRules, judge, mergeScorecard };

// ---- Constants ----------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR   = path.join(PROJECT_ROOT, "public");
const MODEL_CARD_PATH = path.join(PROJECT_ROOT, "MODEL_CARD.md");

// Repo URL from package.json (validated: must start with https://github.com/)
function resolveRepoUrl(): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as {
      repository?: { url?: string } | string;
    };
    let raw: string | undefined;
    if (typeof pkg.repository === "string") raw = pkg.repository;
    else if (typeof pkg.repository === "object") raw = pkg.repository?.url;
    if (!raw) return null;
    // Normalise: strip git+ prefix and .git suffix
    raw = raw.replace(/^git\+/, "").replace(/\.git$/, "");
    if (raw.startsWith("https://github.com/")) return raw;
    return null;
  } catch {
    return null;
  }
}

const REPO_URL = resolveRepoUrl(); // null if not determinable

// ---- Rate limiting (in-memory, injectable) ------------------
export type RateLimitOptions = {
  windowMs: number;   // window size in ms
  maxRequests: number;
};

type RateLimitEntry = { count: number; resetAt: number };

function makeRateLimiter(opts: RateLimitOptions) {
  const store = new Map<string, RateLimitEntry>();
  const MAX_ENTRIES = 10_000;

  // Periodic cleanup — unref'd so it doesn't block process exit
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (entry.resetAt <= now) store.delete(key);
    }
    // Evict oldest entries if map is too large
    if (store.size > MAX_ENTRIES) {
      const excess = store.size - MAX_ENTRIES;
      const keys = store.keys();
      for (let i = 0; i < excess; i++) {
        const next = keys.next();
        if (!next.done) store.delete(next.value);
      }
    }
  }, Math.min(opts.windowMs, 60_000));
  if (cleanupTimer.unref) cleanupTimer.unref();

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const ip = req.ip ?? "unknown";
    const now = Date.now();
    const entry = store.get(ip);

    if (!entry || entry.resetAt <= now) {
      store.set(ip, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }

    if (entry.count < opts.maxRequests) {
      entry.count++;
      next();
      return;
    }

    // Rate limited
    const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader("Retry-After", String(retryAfterSec));
    res.status(429).json({ error: `Too many requests. Please wait ${retryAfterSec} second(s) before retrying.` });
  };
}

// ---- URL validation -----------------------------------------
// GitHub URL: https only, github.com host, /owner/repo path,
// owner/repo match GitHub char sets, no credentials, no port,
// no query/fragment that changes meaning, max 200 chars.
const GITHUB_URL_RE = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100})\/?(?:\.git)?$/;

function validateGithubUrl(raw: string): { ok: true; normalised: string } | { ok: false; error: string } {
  if (raw.length > 200) {
    return { ok: false, error: "URL must be 200 characters or fewer." };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "URL is not valid." };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "Only https:// URLs are accepted." };
  }
  // Exact host check — github.com or www.github.com only
  const host = parsed.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return { ok: false, error: "URL must be a github.com repository (e.g. https://github.com/owner/repo)." };
  }
  if (parsed.port) {
    return { ok: false, error: "URL must not include a port number." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "URL must not contain credentials." };
  }
  if (parsed.search) {
    return { ok: false, error: "URL must not contain a query string." };
  }
  if (parsed.hash) {
    return { ok: false, error: "URL must not contain a fragment." };
  }
  const match = GITHUB_URL_RE.exec(parsed.pathname);
  if (!match) {
    return { ok: false, error: "URL path must be exactly /owner/repo (no extra segments)." };
  }
  const [, owner, repo] = match;
  // Normalise: canonical form without .git or trailing slash
  const normalised = `https://github.com/${owner}/${repo.replace(/\.git$/, "")}`;
  return { ok: true, normalised };
}

// ---- Request body schema ------------------------------------
const JudgeBodySchema = z.object({
  url: z.string(),
  mode: z.enum(["rules", "rules+ai", "rules+gemma"]),
  apiKey: z.string().optional(),
}).strict(); // reject unknown keys

// ---- Error mapping from upstream errors ---------------------
// Person 1's errors may carry { status, publicMessage } — inspect if present.
// Otherwise map to a safe generic 500.
type UpstreamError = Error & { status?: number; publicMessage?: string };

function mapUpstreamError(err: unknown): { statusCode: number; message: string } {
  if (err instanceof IngestError) {
    return { statusCode: err.status, message: err.publicMessage };
  }
  if (err && typeof err === "object") {
    const e = err as UpstreamError;
    if (typeof e.status === "number" && typeof e.publicMessage === "string") {
      // Upstream provided a safe public message — use it
      return { statusCode: e.status, message: e.publicMessage };
    }
  }
  // Generic safe fallback — never expose internal message, stack, or secrets
  return {
    statusCode: 500,
    message: "Something went wrong while evaluating this repository.",
  };
}

// ---- Security headers (set by hand, no helmet) --------------
function setSecurityHeaders(res: Response): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );
}

// ============================================================
// createApp — the exported factory used by tests
// ============================================================
export type CreateAppOptions = {
  deps?: Partial<Deps>;
  rateLimit?: RateLimitOptions;
  /** Overall timeout for the judge pipeline in ms (default: JUDGE_TIMEOUT_MS env or 120000) */
  timeoutMs?: number;
};

export function createApp(options: CreateAppOptions = {}): express.Express {
  const deps: Deps = { ...defaultDeps, ...options.deps };

  const timeoutMs =
    options.timeoutMs ??
    (process.env["JUDGE_TIMEOUT_MS"] ? Number(process.env["JUDGE_TIMEOUT_MS"]) : 120_000);

  const rateLimitOpts: RateLimitOptions = options.rateLimit ?? {
    windowMs: 60_000,
    maxRequests: 10,
  };
  const rateLimiter = makeRateLimiter(rateLimitOpts);

  const app = express();

  // Disable x-powered-by
  app.disable("x-powered-by");

  // Note: "trust proxy" would need configuration when behind a reverse proxy.
  // Currently disabled — req.ip reflects the direct connection.

  // Security headers on every response
  app.use((_req: Request, res: Response, next: NextFunction) => {
    setSecurityHeaders(res);
    next();
  });

  // Static files from public/
  app.use(express.static(PUBLIC_DIR));

  // Parse JSON bodies with size limit; handle malformed JSON with 400
  app.use(
    express.json({ limit: "10kb" })
  );

  // Handle JSON parse errors (express.json throws SyntaxError)
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in (err as object)) {
      res.status(400).json({ error: "Request body is not valid JSON." });
      return;
    }
    next(err);
  });

  // ---- GET /api/health ----------------------------------------
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      dataSource: USING_STUBS ? "stub" : "live",
      time: new Date().toISOString(),
    });
  });

  // ---- GET /api/config ----------------------------------------
  app.get("/api/config", (_req: Request, res: Response) => {
    // repoUrl validated to start with https://github.com/ or null
    const aiAvailable = isAIConfigured(process.env);
    const provider = process.env.AI_PROVIDER || (aiAvailable ? "groq" : null);
    const model = process.env.AI_MODEL || null;
    res.json({
      repoUrl: REPO_URL,
      aiAvailable,
      provider,
      model,
    });
  });

  // ---- GET /model-card ----------------------------------------
  app.get("/model-card", (_req: Request, res: Response) => {
    try {
      const content = fs.readFileSync(MODEL_CARD_PATH, "utf8");
      res.type("text/plain").send(content);
    } catch {
      res.status(404).json({ error: "Model card not found." });
    }
  });

  // ---- POST /api/judge ----------------------------------------
  app.post("/api/judge", rateLimiter, async (req: Request, res: Response) => {
    // 1. Parse and validate request body
    const bodyResult = JudgeBodySchema.safeParse(req.body);
    if (!bodyResult.success) {
      const msg = bodyResult.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      res.status(400).json({ error: `Invalid request: ${msg}` });
      return;
    }

    const { url: rawUrl, mode, apiKey } = bodyResult.data;

    // 2. Validate GitHub URL
    const urlResult = validateGithubUrl(rawUrl);
    if (!urlResult.ok) {
      res.status(400).json({ error: urlResult.error });
      return;
    }
    const url = urlResult.normalised;

    // 3. Run pipeline with timeout
    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("TIMEOUT")), timeoutMs);
      if (timeoutId.unref) timeoutId.unref();
    });

    try {
      const userApiKey = apiKey || (req.headers["x-api-key"] as string | undefined);
      const scorecard = await Promise.race([
        runPipeline(deps, url, mode, userApiKey),
        timeoutPromise,
      ]);
      if (timeoutId) clearTimeout(timeoutId);

      // 4. Validate output with Scorecard schema
      const parseResult = Scorecard.safeParse(scorecard);
      if (!parseResult.success) {
        console.error("[repojudge] Internal result validation failed (schema mismatch)");
        res.status(502).json({ error: "Internal result validation failed." });
        return;
      }

      // 5. Set data-source header
      if (USING_STUBS) {
        res.setHeader("X-RepoJudge-Data-Source", "stub");
      } else {
        res.setHeader("X-RepoJudge-Data-Source", "live");
      }

      res.json(parseResult.data);
    } catch (err: unknown) {
      if (timeoutId) clearTimeout(timeoutId);

      if (err instanceof Error && err.message === "TIMEOUT") {
        res.status(504).json({ error: "The evaluation timed out. Please retry." });
        return;
      }

      const { statusCode, message } = mapUpstreamError(err);
      // Log only name — never message body, stack, secrets
      const name = err instanceof Error ? err.name : "UnknownError";
      console.error(`[repojudge] Upstream error: ${name} -> HTTP ${statusCode}`);
      res.status(statusCode).json({ error: message });
    }
  });

  // ---- JSON 404 for unknown /api/* routes ----------------------
  app.all(/^\/api\/.*/, (_req: Request, res: Response) => {
    res.status(404).json({ error: "API endpoint not found." });
  });

  // ---- Final error-handling middleware -------------------------
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[repojudge] Unhandled error:", err instanceof Error ? err.name : "unknown");
    res.status(500).json({ error: "An unexpected error occurred." });
  });

  return app;
}

// ---- Pipeline helper (not exported) --------------------------
async function runPipeline(
  deps: Deps,
  url: string,
  mode: "rules" | "rules+ai" | "rules+gemma",
  userApiKey?: string
): Promise<import("./schema.js").Scorecard> {
  const snap = await Promise.resolve(deps.buildSnapshot(url));
  const rules = await Promise.resolve(deps.runRules(snap));

  if (mode === "rules+gemma") {
    // Call judge exactly once with snap (for backwards compatibility with existing mock signatures)
    const result = await Promise.resolve(deps.judge(snap));
    const servedBy =
      result.modelInfo?.servedBy ||
      process.env["GEMMA_SERVED_BY"]?.trim() ||
      "Gemini API (hosting endpoint)";
    const modelName =
      result.modelInfo?.name ||
      process.env["GEMMA_MODEL"] ||
      "unknown";
    return Promise.resolve(
      deps.mergeScorecard(
        snap,
        rules,
        result.verdicts,
        mode,
        result.unscored,
        servedBy,
        modelName
      )
    );
  }

  if (mode === "rules+ai") {
    // Call judge with rules and userApiKey
    const result = await Promise.resolve(deps.judge(snap, { rules, userApiKey }));
    const servedBy =
      result.modelInfo?.servedBy ||
      process.env["AI_PROVIDER"]?.toUpperCase() ||
      "AI";
    const modelName =
      result.modelInfo?.name ||
      process.env["AI_MODEL"] ||
      "unknown";
    return Promise.resolve(
      deps.mergeScorecard(
        snap,
        rules,
        result.verdicts,
        mode,
        result.unscored,
        servedBy,
        modelName
      )
    );
  }

  // In rules mode: never call judge
  return Promise.resolve(deps.mergeScorecard(snap, rules, [], "rules"));
}

// ============================================================
// Main guard — listen only when run directly
// Compatible with ESM (import.meta.url) + NodeNext
// ============================================================
const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  const port = process.env["PORT"] ? Number(process.env["PORT"]) : 3000;
  const app = createApp();
  app.listen(port, () => {
    console.log(`[repojudge] Server running on http://localhost:${port}`);
    console.log(`[repojudge] Data source: ${USING_STUBS ? "Using STUBS" : "Using REAL modules"}`);
    console.log(`[repojudge] Repo URL: ${REPO_URL ?? "(not configured)"}`);
  });
}
