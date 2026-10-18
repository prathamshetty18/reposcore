import {
  CriterionId,
  AIVerdict,
  RepoSnapshot,
  RuleCheck,
  Scorecard,
} from "./schema.js";

const ALL_CRITERIA: CriterionId[] = CriterionId.options;

export function rulesScore(rules: RuleCheck[]): Record<CriterionId, number> {
  const result: Partial<Record<CriterionId, number>> = {};

  for (const criterion of ALL_CRITERIA) {
    const matching = rules.filter((r) => r.criterion === criterion);
    if (matching.length === 0) {
      continue;
    }
    const passed = matching.filter((r) => r.pass).length;
    const score = Math.round(((passed / matching.length) * 5) * 10) / 10;
    result[criterion] = score;
  }

  return result as Record<CriterionId, number>;
}

export function mergeScorecard(
  snap: RepoSnapshot,
  rules: RuleCheck[],
  verdicts: AIVerdict[],
  mode: "rules" | "rules+ai" | "rules+gemma",
  unscored?: CriterionId[],
  servedBy?: string | null,
  modelName?: string | null,
  customRules?: import("./schema.js").CustomRuleResult[]
): Scorecard {
  const repo = `${snap.owner}/${snap.name}`;
  const generatedAt = new Date().toISOString();
  const rScores = rulesScore(rules);

  let rSum = 0;
  for (const criterion of ALL_CRITERIA) {
    rSum += rScores[criterion] ?? 0;
  }
  const rulesTotal = Math.round(rSum * 10) / 10;

  if (mode === "rules") {
    const scorecard: Scorecard = {
      repo,
      mode: "rules",
      rules,
      customRules: customRules ?? [],
      verdicts: [],
      unscored: [],
      total: rulesTotal,
      rulesTotal,
      model: null,
      generatedAt,
    };

    return Scorecard.parse(scorecard);
  }

  // mode === "rules+ai" or "rules+gemma"
  if (verdicts.length > 0 && !servedBy) {
    throw new Error(
      `servedBy required in ${mode} mode when verdicts exist`
    );
  }

  const verdictMap = new Map<CriterionId, AIVerdict>();
  for (const verdict of verdicts) {
    verdictMap.set(verdict.criterion, verdict);
  }

  const missingVerdicts = ALL_CRITERIA.filter((c) => !verdictMap.has(c));
  const mergedUnscoredSet = new Set<CriterionId>([
    ...(unscored ?? []),
    ...missingVerdicts,
  ]);
  const finalUnscored: CriterionId[] = ALL_CRITERIA.filter((c) =>
    mergedUnscoredSet.has(c)
  );

  let total: number | null = null;
  if (finalUnscored.length === 0) {
    let sum = 0;
    for (const criterion of ALL_CRITERIA) {
      const aiScore = verdictMap.get(criterion)!.score;
      const rScore = rScores[criterion];
      if (rScore !== undefined) {
        sum += (rScore + aiScore) / 2;
      } else {
        sum += aiScore;
      }
    }
    total = Math.round(sum * 10) / 10;
  }

  const resolvedModelName =
    modelName ??
    process.env.AI_MODEL ??
    process.env.GEMMA_MODEL ??
    "unknown";

  const model = servedBy
    ? {
        name: resolvedModelName,
        servedBy,
        openWeight: true,
      }
    : null;

  const scorecard: Scorecard = {
    repo,
    mode,
    rules,
    customRules: customRules ?? [],
    verdicts,
    unscored: finalUnscored,
    total,
    rulesTotal,
    model,
    generatedAt,
  };

  return Scorecard.parse(scorecard);
}
