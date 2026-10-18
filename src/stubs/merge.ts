/**
 * src/stubs/merge.ts
 *
 * Stub for src/merge.ts (shared module).
 * Merges RuleCheck[], GemmaVerdict[], and unscored into a Scorecard.
 * - In "rules" mode: total is computed from passed rules count,
 *   model is null (no model was used).
 * - In "rules+gemma" mode: total is null if any criterion is unscored,
 *   otherwise sum of scores. model is set to stub label.
 * NEVER reads GEMMA_MODEL. Never fabricates a live model name.
 *
 * Real module signature expected:
 *   export function mergeScorecard(
 *     snap: RepoSnapshot,
 *     rules: RuleCheck[],
 *     verdicts: GemmaVerdict[],
 *     mode: "rules" | "rules+gemma"
 *   ): Scorecard
 */

import {
  Scorecard,
  RepoSnapshot,
  RuleCheck,
  GemmaVerdict,
  CriterionId,
} from "../schema.js";

const ALL_CRITERIA: CriterionId[] = [
  "clear_problem",
  "substantial_work",
  "easy_to_verify",
  "demo_explanation",
  "collaboration",
  "submission",
];

export function mergeScorecard(
  snap: RepoSnapshot,
  rules: RuleCheck[],
  verdicts: GemmaVerdict[],
  mode: "rules" | "rules+gemma"
): Scorecard {
  // Determine unscored criteria
  const scoredCriteria = new Set(verdicts.map((v) => v.criterion));
  const unscored: CriterionId[] =
    mode === "rules+gemma"
      ? ALL_CRITERIA.filter((c) => !scoredCriteria.has(c))
      : ALL_CRITERIA; // all unscored in rules mode (no verdicts)

  // Compute total
  // In rules mode: count passed rules (no denominator invented)
  // In rules+gemma mode: sum of scores if all criteria scored, else null
  let total: number | null;
  if (mode === "rules") {
    // Total = number of passing rules (clearly labelled, not a score out of N)
    total = rules.filter((r) => r.pass).length;
  } else {
    // Total null if any criterion unscored
    if (unscored.length > 0) {
      total = null;
    } else {
      total = verdicts.reduce((sum, v) => sum + v.score, 0);
    }
  }

  // Model info: stub uses a clearly-labelled demo name
  // NEVER reads GEMMA_MODEL. NEVER uses "gemini-" or any real model id.
  const model =
    mode === "rules+gemma"
      ? {
          name: "gemma-stub (demo data, not a live model)",
          servedBy: "stub",
          openWeight: true as const,
        }
      : null;

  const card: Scorecard = {
    repo: snap.url,
    mode,
    rules,
    verdicts: mode === "rules+gemma" ? verdicts : [],
    unscored: mode === "rules+gemma" ? unscored : [],
    total,
    model,
    customRules: [],
    generatedAt: new Date().toISOString(),
  };

  return Scorecard.parse(card);
}
