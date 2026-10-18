import { z } from "zod";

export const CustomRuleCheckType = z.enum([
  "file_exists",
  "file_missing",
  "file_contains",
  "file_count",
  "json_field_equals",
]);

export const FileExistsParams = z
  .object({
    path: z.string().min(1, "path is required"),
  })
  .strict();

export const FileMissingParams = z
  .object({
    path: z.string().min(1, "path is required"),
  })
  .strict();

export const FileContainsParams = z
  .object({
    path: z.string().min(1, "path is required"),
    pattern: z.string().min(1, "pattern is required"),
    isRegex: z.boolean().optional().default(false),
  })
  .strict();

export const FileCountParams = z
  .object({
    glob: z.string().optional(),
    pattern: z.string().optional(),
    min: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((data) => data.min !== undefined || data.max !== undefined, {
    message: "At least one of min or max must be specified",
  });

export const JsonFieldEqualsParams = z
  .object({
    path: z.string().min(1, "path is required"),
    field: z.string().min(1, "field is required"),
    value: z.any(),
  })
  .strict();

const BaseCustomRuleSchema = z
  .object({
    id: z
      .string()
      .min(1, "id is required")
      .regex(
        /^[a-zA-Z0-9_.-]+$/,
        "id must contain only alphanumeric characters, dots, underscores, or dashes"
      ),
    name: z.string().min(1, "name is required").max(100),
    description: z.string().max(300).optional(),
    check: CustomRuleCheckType,
    params: z.record(z.string(), z.any()),
    severity: z.enum(["low", "medium", "high"]).optional().default("medium"),
    weight: z.number().min(0).max(100).optional().default(1),
  });

export const CustomRuleSchema = z.preprocess((val: any) => {
  if (val && typeof val === "object" && !Array.isArray(val)) {
    const check = val.check || val.type;
    let params = val.params;
    if (!params || typeof params !== "object") {
      params = {};
      if (val.path !== undefined) params.path = val.path;
      if (val.pattern !== undefined) params.pattern = val.pattern;
      if (val.glob !== undefined) params.glob = val.glob;
      if (val.isRegex !== undefined) params.isRegex = val.isRegex;
      if (val.min !== undefined) params.min = val.min;
      if (val.max !== undefined) params.max = val.max;
      if (val.field !== undefined) params.field = val.field;
      if (val.value !== undefined) params.value = val.value;
      if (val.expectedValue !== undefined) params.value = val.expectedValue;
    } else {
      params = { ...params };
      if (params.expectedValue !== undefined && params.value === undefined) {
        params.value = params.expectedValue;
      }
    }
    return {
      ...val,
      check,
      params,
    };
  }
  return val;
}, BaseCustomRuleSchema)
  .superRefine((rule, ctx) => {
    let result: { success: boolean; error?: z.ZodError };
    switch (rule.check) {
      case "file_exists":
        result = FileExistsParams.safeParse(rule.params);
        break;
      case "file_missing":
        result = FileMissingParams.safeParse(rule.params);
        break;
      case "file_contains":
        result = FileContainsParams.safeParse(rule.params);
        break;
      case "file_count":
        result = FileCountParams.safeParse(rule.params);
        break;
      case "json_field_equals":
        result = JsonFieldEqualsParams.safeParse(rule.params);
        break;
    }
    if (!result.success && result.error) {
      for (const issue of result.error.issues) {
        ctx.addIssue({
          ...issue,
          path: ["params", ...issue.path],
        });
      }
    }
  });

export const CustomRuleCheckResult = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  check: CustomRuleCheckType,
  pass: z.boolean(),
  evidence: z.string(),
  severity: z.enum(["low", "medium", "high"]).optional(),
  weight: z.number().optional(),
});

export type CustomRuleCheckType = z.infer<typeof CustomRuleCheckType>;
export type CustomRule = z.infer<typeof CustomRuleSchema>;
export type CustomRuleCheckResult = z.infer<typeof CustomRuleCheckResult>;
