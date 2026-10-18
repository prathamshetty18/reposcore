/**
 * src/judge/ai.ts — Provider-agnostic AI Judge with retry, validation, timeout, and caching
 */

import {
  CriterionId,
  AIVerdict,
  type RepoSnapshot,
  type RuleCheck,
} from "../schema.js";
import {
  CRITERIA,
  buildSystemPrompt,
  buildUserPrompt,
} from "./prompt.js";
import {
  resolveAIConfig,
  createChatCompletionClient,
  type AIProviderConfig,
  type ChatCompletionClient,
  type ChatMessage,
} from "./provider.js";
import { detectInjection } from "./sanitize.js";

export const DEFAULT_TIMEOUT_MS = 15000;
export const MAX_ATTEMPTS = 3;

export interface AIClient {
  complete?(messages: ChatMessage[], options?: { signal?: AbortSignal }): Promise<string>;
  generate?(args: { model?: string; system: string; user: string; signal: AbortSignal }): Promise<string>;
}

export interface CacheEntry {
  verdicts: AIVerdict[];
  unscored: CriterionId[];
  modelInfo?: { name: string; servedBy: string };
}

const aiCache = new Map<string, CacheEntry>();

export function getAICacheKey(url: string, commitSha?: string | null): string {
  const normUrl = url.toLowerCase().trim().replace(/\/+$/, "").replace(/\.git$/, "");
  const sha = (commitSha || "head").trim();
  return `${normUrl}@${sha}`;
}

export function clearAICache(): void {
  aiCache.clear();
}

export function extractJsonObject(raw: string): Record<string, unknown> | null {
  if (typeof raw !== "string") {
    return null;
  }

  const cleaned = raw.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const objStart = cleaned.indexOf("{");
  const objEnd = cleaned.lastIndexOf("}");
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");

  if (objStart !== -1 && objEnd !== -1 && objStart < objEnd) {
    try {
      const parsed = JSON.parse(cleaned.slice(objStart, objEnd + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fallback to array parsing
    }
  }

  if (arrayStart !== -1 && arrayEnd !== -1 && arrayStart < arrayEnd) {
    try {
      const parsed = JSON.parse(cleaned.slice(arrayStart, arrayEnd + 1));
      if (Array.isArray(parsed)) {
        const mapped: Record<string, unknown> = {};
        for (const item of parsed) {
          if (item && typeof item === "object" && "criterion" in item) {
            mapped[(item as Record<string, unknown>).criterion as string] = {
              score: (item as Record<string, unknown>).score,
              reason:
                (item as Record<string, unknown>).reason ??
                (item as Record<string, unknown>).reasoning ??
                "",
            };
          }
        }
        return mapped;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function parseCriterionScore(obj: unknown): { score: number; reason: string } | null {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return null;
  }
  const item = obj as Record<string, unknown>;

  let score: number;
  if (typeof item.score === "number" && !Number.isNaN(item.score)) {
    score = Math.round(item.score);
  } else if (typeof item.score === "string" && item.score.trim() !== "") {
    const parsedNum = Number(item.score.trim());
    if (Number.isNaN(parsedNum)) {
      return null;
    }
    score = Math.round(parsedNum);
  } else {
    return null;
  }

  if (score < 0 || score > 5) {
    return null;
  }

  let reason = "";
  if (typeof item.reason === "string") {
    reason = item.reason.slice(0, 600);
  } else if (typeof item.reasoning === "string") {
    reason = item.reasoning.slice(0, 600);
  }

  return { score, reason };
}

export function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === "object") {
    const errorObj = err as Record<string, unknown>;
    if (
      errorObj.status === 429 ||
      errorObj.code === 429 ||
      errorObj.statusCode === 429
    ) {
      return true;
    }
  }
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("429") || msg.toLowerCase().includes("rate limit") || msg.includes("RESOURCE_EXHAUSTED");
}

export interface JudgeDeps {
  rules?: RuleCheck[];
  client?: AIClient;
  config?: AIProviderConfig;
  env?: NodeJS.ProcessEnv;
  userApiKey?: string;
  timeoutMs?: number;
  skipCache?: boolean;
  fetchFn?: typeof fetch;
}

export async function judge(
  snap: RepoSnapshot,
  deps?: JudgeDeps
): Promise<{
  verdicts: AIVerdict[];
  unscored: CriterionId[];
  modelInfo?: { name: string; servedBy: string };
}> {
  const env = deps?.env ?? process.env;
  const timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Check cache first
  const cacheKey = getAICacheKey(snap.url, snap.commitSha);
  if (!deps?.skipCache && aiCache.has(cacheKey)) {
    return aiCache.get(cacheKey)!;
  }

  let cfg: AIProviderConfig | null = null;
  try {
    cfg = deps?.config ?? resolveAIConfig(env, deps?.userApiKey);
  } catch {
    // If provider is not configured or throws, mark all criteria not scored
    return {
      verdicts: [],
      unscored: [...CRITERIA],
    };
  }

  const modelInfo = {
    name: cfg.model,
    servedBy: cfg.provider.toUpperCase(),
  };

  const client: AIClient =
    deps?.client ??
    createChatCompletionClient(cfg, deps?.fetchFn ?? globalThis.fetch);

  const system = buildSystemPrompt();
  const user = buildUserPrompt(snap, deps?.rules ?? []);

  const scoredByCriterion = new Map<CriterionId, { score: number; reason: string }>();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const missing = CRITERIA.filter((c) => !scoredByCriterion.has(c));
    if (missing.length === 0) {
      break;
    }

    let rawOutput: string | null = null;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (client.complete) {
        rawOutput = await client.complete(
          [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          { signal: controller.signal }
        );
      } else if (client.generate) {
        rawOutput = await client.generate({
          model: cfg.model,
          system,
          user,
          signal: controller.signal,
        });
      }
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      console.error("[ai] error:", err instanceof Error ? err.message : err);
      // On 429, timeout or fatal failure, break retry loop and mark remaining unscored
      if (isRateLimitError(err) || (err instanceof Error && err.name === "AbortError")) {
        break;
      }
      // On other network/provider errors, retry up to MAX_ATTEMPTS
      continue;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!rawOutput) {
      continue;
    }

    const parsedObj = extractJsonObject(rawOutput);
    if (!parsedObj) {
      console.error("[ai] failed to parse JSON from output:", rawOutput.slice(0, 200));
      // Invalid JSON: retry up to MAX_ATTEMPTS
      continue;
    }

    for (const criterion of missing) {
      const parsedItem = parseCriterionScore(parsedObj[criterion]);
      if (parsedItem) {
        scoredByCriterion.set(criterion, parsedItem);
      }
    }
  }

  const isReadmeInjected = detectInjection(snap.readme ?? "");
  const isFileTreeInjected = detectInjection(snap.fileTree.join("\n"));
  const injected = isReadmeInjected || isFileTreeInjected;

  const finalVerdicts: AIVerdict[] = [];
  const unscored: CriterionId[] = [];

  for (const criterion of CRITERIA) {
    const item = scoredByCriterion.get(criterion);
    if (item) {
      let score = item.score;
      let reasoning = item.reason;

      if (injected) {
        score = Math.min(score, 2);
        reasoning = `${reasoning} [Repo text contained instruction-like content; score capped.]`.slice(
          0,
          600
        );
      }

      finalVerdicts.push({
        criterion,
        score,
        reasoning,
        evidence: [],
        suggestion: "",
      });
    } else {
      // Unscored: never guess a number
      unscored.push(criterion);
    }
  }

  const result = {
    verdicts: finalVerdicts,
    unscored,
    modelInfo,
  };

  // Cache if at least one criterion was scored or evaluation ran
  aiCache.set(cacheKey, result);

  return result;
}
