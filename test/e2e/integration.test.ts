import { describe, expect, it } from "vitest";
import { judge, type AIClient as GemmaClient } from "../../src/judge/ai.js";
import { mergeScorecard } from "../../src/merge.js";
import { runRules } from "../../src/rules/index.js";
import { Scorecard } from "../../src/schema.js";
import { bareSnapshot, goodSnapshot, injectionSnapshot } from "./snapshots.js";

describe("RepoJudge Integration Pipeline", () => {
  describe("Rules mode (deterministic)", () => {
    it("runs runRules and mergeScorecard for all snapshots, verifying schema and total score bounds", () => {
      const snapshots = [goodSnapshot, bareSnapshot, injectionSnapshot];

      for (const snap of snapshots) {
        const rules = runRules(snap);
        const card = mergeScorecard(snap, rules, [], "rules");

        // Parses with Scorecard zod schema
        expect(() => Scorecard.parse(card)).not.toThrow();
        expect(card.mode).toBe("rules");
        expect(card.verdicts).toEqual([]);
        expect(card.unscored).toEqual([]);
        expect(card.model).toBeNull();

        // Total between 0 and 30
        expect(typeof card.total).toBe("number");
        expect(card.total).toBeGreaterThanOrEqual(0);
        expect(card.total).toBeLessThanOrEqual(30);
      }
    });

    it("verifies that the good fixture beats the bare fixture in total score", () => {
      const goodRules = runRules(goodSnapshot);
      const goodCard = mergeScorecard(goodSnapshot, goodRules, [], "rules");

      const bareRules = runRules(bareSnapshot);
      const bareCard = mergeScorecard(bareSnapshot, bareRules, [], "rules");

      expect(goodCard.total).not.toBeNull();
      expect(bareCard.total).not.toBeNull();
      expect(goodCard.total!).toBeGreaterThan(bareCard.total!);
    });

    it("asserts that prompt-injection text never appears in rule evidence", () => {
      const injectionRules = runRules(injectionSnapshot);
      for (const rule of injectionRules) {
        expect(rule.evidence.toLowerCase()).not.toContain("ignore previous instructions");
      }
    });
  });

  describe("Rules + Gemma mode with mocked Gemma client", () => {
    it("feeds judge() output into mergeScorecard: total is null when any criterion is unscored", async () => {
      const rules = runRules(goodSnapshot);

      // Mock GemmaClient that returns verdicts for only 5 of 6 criteria (missing "submission")
      const mockClient: GemmaClient = {
        async generate() {
          return JSON.stringify([
            {
              criterion: "clear_problem",
              score: 4,
              reasoning: "Problem and solution are clearly stated.",
              evidence: ["README.md"],
              suggestion: "Good problem definition.",
            },
            {
              criterion: "substantial_work",
              score: 4,
              reasoning: "Substantial commits and test suites.",
              evidence: ["src/rules/", "test/"],
              suggestion: "Comprehensive work.",
            },
            {
              criterion: "easy_to_verify",
              score: 5,
              reasoning: "Easy to verify with full test suite and CI.",
              evidence: [".github/workflows/ci.yml"],
              suggestion: "Straightforward verification.",
            },
            {
              criterion: "demo_explanation",
              score: 4,
              reasoning: "Clear setup and demo sections.",
              evidence: ["README.md#demo"],
              suggestion: "Video demo is helpful.",
            },
            {
              criterion: "collaboration",
              score: 5,
              reasoning: "Even commit distribution across team members.",
              evidence: ["git shortlog"],
              suggestion: "Good teamwork.",
            },
          ]);
        },
      };

      const judgeResult = await judge(goodSnapshot, {
        client: mockClient,
        env: {
          GEMMA_MODEL: "gemma-4-it",
          GEMINI_API_KEY: "dummy-key-for-mock",
        },
      });

      expect(judgeResult.verdicts).toHaveLength(5);
      expect(judgeResult.unscored).toContain("submission");

      const card = mergeScorecard(
        goodSnapshot,
        rules,
        judgeResult.verdicts,
        "rules+gemma",
        judgeResult.unscored,
        "Gemini API"
      );

      // Scorecard must validate
      expect(() => Scorecard.parse(card)).not.toThrow();
      expect(card.mode).toBe("rules+gemma");

      // Total must be null because "submission" is unscored
      expect(card.total).toBeNull();
      expect(card.unscored).toContain("submission");
      expect(card.model).not.toBeNull();
      expect(card.model?.openWeight).toBe(true);
    });
  });
});
