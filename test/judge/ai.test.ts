import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  judge,
  extractJsonObject,
  clearAICache,
  DEFAULT_TIMEOUT_MS,
  type AIClient,
} from "../../src/judge/ai.js";
import {
  resolveAIConfig,
  isAIConfigured,
  createChatCompletionClient,
  PROVIDER_PRESETS,
} from "../../src/judge/provider.js";
import { mergeScorecard } from "../../src/merge.js";
import { RepoSnapshot, CriterionId, RuleCheck } from "../../src/schema.js";

function makeSnapshot(overrides: Partial<RepoSnapshot> = {}): RepoSnapshot {
  return RepoSnapshot.parse({
    url: "https://github.com/test-owner/test-repo",
    owner: "test-owner",
    name: "test-repo",
    isPublic: true,
    license: "MIT",
    readme: "# Test Repo\nA fine repository for testing.",
    fileTree: ["src/index.ts", "README.md", "LICENSE"],
    commitCount: 15,
    commitSha: "c0ffee1234567890abcdef",
    contributors: [{ login: "alice", commits: 15 }],
    hasCI: true,
    hasTests: true,
    hasCodeOfConduct: true,
    linksMlhCoc: true,
    fetchedAt: new Date().toISOString(),
    ...overrides,
  });
}

const mockRules: RuleCheck[] = [
  { id: "r1", criterion: "clear_problem", pass: true, evidence: "README found" },
  { id: "r2", criterion: "substantial_work", pass: true, evidence: "15 commits" },
  { id: "r3", criterion: "easy_to_verify", pass: true, evidence: "MIT license" },
  { id: "r4", criterion: "demo_explanation", pass: true, evidence: "README details" },
  { id: "r5", criterion: "collaboration", pass: true, evidence: "Contributors found" },
  { id: "r6", criterion: "submission", pass: true, evidence: "Code of conduct found" },
];

function validAIOutput() {
  return JSON.stringify({
    clear_problem: { score: 4, reason: "Clear problem explanation in README." },
    substantial_work: { score: 4, reason: "15 commits with good structure." },
    easy_to_verify: { score: 5, reason: "Standard MIT license and clean setup." },
    demo_explanation: { score: 4, reason: "Demo walkthrough provided." },
    collaboration: { score: 4, reason: "Team contributions evident." },
    submission: { score: 5, reason: "Complete submission requirements met." },
  });
}

describe("AI Provider & Judge Layer", () => {
  beforeEach(() => {
    clearAICache();
    vi.restoreAllMocks();
  });

  // ---- 1. Provider Config & Presets ----------------------------
  describe("Provider resolution and presets", () => {
    it("resolves groq preset correctly", () => {
      const cfg = resolveAIConfig({
        AI_PROVIDER: "groq",
        AI_API_KEY: "gsk_test123",
      });
      expect(cfg.provider).toBe("groq");
      expect(cfg.baseUrl).toBe(PROVIDER_PRESETS.groq.baseUrl);
      expect(cfg.model).toBe(PROVIDER_PRESETS.groq.defaultModel);
      expect(cfg.apiKey).toBe("gsk_test123");
    });

    it("resolves openrouter preset correctly", () => {
      const cfg = resolveAIConfig({
        AI_PROVIDER: "openrouter",
        AI_API_KEY: "sk-or-test123",
      });
      expect(cfg.provider).toBe("openrouter");
      expect(cfg.baseUrl).toBe(PROVIDER_PRESETS.openrouter.baseUrl);
      expect(cfg.model).toBe(PROVIDER_PRESETS.openrouter.defaultModel);
    });

    it("resolves ollama preset without requiring an API key", () => {
      const cfg = resolveAIConfig({
        AI_PROVIDER: "ollama",
      });
      expect(cfg.provider).toBe("ollama");
      expect(cfg.baseUrl).toBe(PROVIDER_PRESETS.ollama.baseUrl);
      expect(cfg.apiKey).toBeUndefined();
    });

    it("throws when non-ollama remote provider is missing API key", () => {
      expect(() =>
        resolveAIConfig({
          AI_PROVIDER: "groq",
          AI_API_KEY: "",
        })
      ).toThrow(/AI_API_KEY is required/);
    });

    it("isAIConfigured returns true for ollama, or when API key is present", () => {
      expect(isAIConfigured({ AI_PROVIDER: "ollama" })).toBe(true);
      expect(isAIConfigured({ AI_PROVIDER: "groq", AI_API_KEY: "gsk_123" })).toBe(true);
      expect(isAIConfigured({ AI_PROVIDER: "groq", AI_API_KEY: "" })).toBe(false);
      expect(isAIConfigured({}, "user_provided_key")).toBe(true);
    });
  });

  // ---- 2. Invalid JSON Retry ----------------------------------
  describe("Invalid JSON retry handling", () => {
    it("extractJsonObject parses pure JSON and markdown-wrapped JSON", () => {
      expect(extractJsonObject('{"clear_problem":{"score":4,"reason":"ok"}}')).toEqual({
        clear_problem: { score: 4, reason: "ok" },
      });
      expect(
        extractJsonObject('```json\n{"clear_problem":{"score":4,"reason":"ok"}}\n```')
      ).toEqual({
        clear_problem: { score: 4, reason: "ok" },
      });
      expect(extractJsonObject("not json at all")).toBeNull();
    });

    it("retries up to 3 times on invalid JSON, succeeding when a subsequent attempt is valid", async () => {
      const completeMock = vi
        .fn()
        .mockResolvedValueOnce("INVALID NOT JSON OUTPUT")
        .mockResolvedValueOnce("```bad json text```")
        .mockResolvedValueOnce(validAIOutput());

      const client: AIClient = { complete: completeMock };
      const snap = makeSnapshot();

      const result = await judge(snap, {
        client,
        rules: mockRules,
        config: {
          provider: "groq",
          baseUrl: "https://api.groq.com/openai/v1",
          model: "llama-3.3-70b-versatile",
          apiKey: "test",
        },
      });

      expect(completeMock).toHaveBeenCalledTimes(3);
      expect(result.verdicts).toHaveLength(6);
      expect(result.unscored).toHaveLength(0);
      expect(result.verdicts[0].score).toBe(4);
    });

    it("marks criteria 'not scored' when all 3 attempts produce invalid JSON", async () => {
      const completeMock = vi
        .fn()
        .mockResolvedValue("Sorry, I cannot return JSON right now.");

      const client: AIClient = { complete: completeMock };
      const snap = makeSnapshot();

      const result = await judge(snap, {
        client,
        rules: mockRules,
        config: {
          provider: "groq",
          baseUrl: "https://api.groq.com/openai/v1",
          model: "llama-3.3-70b-versatile",
          apiKey: "test",
        },
      });

      expect(completeMock).toHaveBeenCalledTimes(3);
      expect(result.verdicts).toHaveLength(0);
      expect(result.unscored).toEqual(CriterionId.options);
    });
  });

  // ---- 3. Timeout Handling -------------------------------------
  describe("15-second timeout handling", () => {
    it("defaults timeout to 15000 ms", () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(15000);
    });

    it("aborts and marks criteria not scored on timeout without guessing numbers", async () => {
      const completeMock = vi.fn().mockImplementation(
        (_messages, opts?: { signal?: AbortSignal }) =>
          new Promise((_, reject) => {
            if (opts?.signal) {
              opts.signal.addEventListener("abort", () => {
                const abortErr = new Error("Operation aborted");
                abortErr.name = "AbortError";
                reject(abortErr);
              });
            }
          })
      );

      const client: AIClient = { complete: completeMock };
      const snap = makeSnapshot();

      const result = await judge(snap, {
        client,
        rules: mockRules,
        timeoutMs: 50, // fast timeout for test
        config: {
          provider: "groq",
          baseUrl: "https://api.groq.com/openai/v1",
          model: "llama-3.3-70b-versatile",
          apiKey: "test",
        },
      });

      // All criteria must be unscored; never guess a number
      expect(result.verdicts).toHaveLength(0);
      expect(result.unscored).toEqual(CriterionId.options);
    });
  });

  // ---- 4. 429 Rate Limit Handling ------------------------------
  describe("429 Rate limit handling", () => {
    it("marks criteria not scored on 429 error and never guesses numbers", async () => {
      const rateLimitError = new Error("AI provider error (429): Rate limit reached");
      (rateLimitError as any).status = 429;

      const completeMock = vi.fn().mockRejectedValue(rateLimitError);
      const client: AIClient = { complete: completeMock };
      const snap = makeSnapshot();

      const result = await judge(snap, {
        client,
        rules: mockRules,
        config: {
          provider: "groq",
          baseUrl: "https://api.groq.com/openai/v1",
          model: "llama-3.3-70b-versatile",
          apiKey: "test",
        },
      });

      expect(completeMock).toHaveBeenCalledTimes(1);
      expect(result.verdicts).toHaveLength(0);
      expect(result.unscored).toEqual(CriterionId.options);
    });
  });

  // ---- 5. Caching per URL + commit SHA --------------------------
  describe("Caching AI results per URL + commit SHA", () => {
    it("caches verdicts for the same URL + commit SHA and skips repeat AI calls", async () => {
      const completeMock = vi.fn().mockResolvedValue(validAIOutput());
      const client: AIClient = { complete: completeMock };
      const snap = makeSnapshot({ commitSha: "sha-abc-123" });

      const cfg = {
        provider: "groq" as const,
        baseUrl: "https://api.groq.com/openai/v1",
        model: "llama-3.3-70b-versatile",
        apiKey: "test",
      };

      // Call 1: makes network call
      const res1 = await judge(snap, { client, rules: mockRules, config: cfg });
      expect(completeMock).toHaveBeenCalledTimes(1);
      expect(res1.verdicts).toHaveLength(6);

      // Call 2 with identical url and commitSha: hits cache
      const res2 = await judge(snap, { client, rules: mockRules, config: cfg });
      expect(completeMock).toHaveBeenCalledTimes(1); // not incremented
      expect(res2).toEqual(res1);

      // Call 3 with different commitSha: makes new network call
      const snap2 = makeSnapshot({ commitSha: "sha-different-456" });
      const res3 = await judge(snap2, { client, rules: mockRules, config: cfg });
      expect(completeMock).toHaveBeenCalledTimes(2);
      expect(res3.verdicts).toHaveLength(6);
    });
  });

  // ---- 6. Merge step with "not scored" criteria ----------------
  describe("Merge step with unscored criteria", () => {
    it("returns rule results and marks criteria unscored with total null if AI fails", () => {
      const snap = makeSnapshot();
      const allUnscored = CriterionId.options;

      const card = mergeScorecard(
        snap,
        mockRules,
        [], // no AI verdicts
        "rules+ai",
        allUnscored,
        "GROQ",
        "llama-3.3-70b-versatile"
      );

      expect(card.mode).toBe("rules+ai");
      expect(card.rules).toHaveLength(mockRules.length);
      expect(card.verdicts).toEqual([]);
      expect(card.unscored).toEqual(allUnscored);
      expect(card.total).toBeNull();
      expect(card.model?.servedBy).toBe("GROQ");
      expect(card.model?.name).toBe("llama-3.3-70b-versatile");
    });

    it("calculates numeric total out of 30 when all criteria are scored in rules+ai mode", () => {
      const snap = makeSnapshot();
      const verdicts = CriterionId.options.map((criterion) => ({
        criterion,
        score: 4,
        reasoning: "Solid work.",
        evidence: [],
        suggestion: "",
      }));

      const card = mergeScorecard(
        snap,
        mockRules,
        verdicts,
        "rules+ai",
        [],
        "GROQ",
        "llama-3.3-70b-versatile"
      );

      expect(card.mode).toBe("rules+ai");
      expect(card.unscored).toEqual([]);
      expect(typeof card.total).toBe("number");
      expect(card.total).toBeGreaterThan(0);
      expect(card.total).toBeLessThanOrEqual(30);
    });
  });

  // ---- 7. Rules only mode with no key ---------------------------
  describe("Rules only mode with zero AI key", () => {
    it("operates completely without AI_API_KEY, producing 0-30 total and empty verdicts", () => {
      const snap = makeSnapshot();
      const card = mergeScorecard(snap, mockRules, [], "rules");

      expect(card.mode).toBe("rules");
      expect(card.model).toBeNull();
      expect(card.verdicts).toEqual([]);
      expect(card.unscored).toEqual([]);
      expect(typeof card.total).toBe("number");
      expect(card.total).toBeGreaterThan(0);
      expect(card.total).toBeLessThanOrEqual(30);
    });
  });
});
