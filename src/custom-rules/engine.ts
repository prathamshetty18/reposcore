import fs from "fs";
import path from "path";
import { RepoSnapshot } from "../schema.js";
import {
  CustomRule,
  CustomRuleCheckResult,
  CustomRuleSchema,
} from "./schema.js";

/**
 * Converts a standard file glob (supporting * and **) into a RegExp.
 */
export function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "___GLOBSTAR_SLASH___")
    .replace(/\*\*/g, "___GLOBSTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/___GLOBSTAR_SLASH___/g, "(?:.*/)?")
    .replace(/___GLOBSTAR___/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Traverses a nested object by dot-separated path (e.g. "scripts.build").
 */
export function getNestedProperty(obj: unknown, fieldPath: string): unknown {
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return undefined;
  }
  const parts = fieldPath.split(".");
  let curr: any = obj;
  for (const part of parts) {
    if (curr === null || curr === undefined || typeof curr !== "object") {
      return undefined;
    }
    curr = curr[part];
  }
  return curr;
}

/**
 * Resolves file text from snapshot (readme, license, or fileContents).
 */
export function getSnapshotFileContent(
  snap: RepoSnapshot & { fileContents?: Record<string, string> },
  targetPath: string
): string | null {
  const norm = targetPath.trim().replace(/^\/+/, "");
  const lower = norm.toLowerCase();

  // Check README
  if (lower === "readme.md" || lower === "readme") {
    return snap.readme;
  }

  // Check LICENSE
  if (lower === "license" || lower === "license.md" || lower === "license.txt") {
    return snap.license;
  }

  // Check fileContents map if available
  if (snap.fileContents) {
    if (norm in snap.fileContents) {
      return snap.fileContents[norm];
    }
    for (const [k, v] of Object.entries(snap.fileContents)) {
      if (k.toLowerCase() === lower) {
        return v;
      }
    }
  }

  return null;
}

/**
 * Evaluates a single declarative custom rule against a repository snapshot.
 */
export function evaluateCustomRule(
  snap: RepoSnapshot & { fileContents?: Record<string, string> },
  rule: CustomRule
): CustomRuleCheckResult {
  const { id, name, description, check, params, severity, weight } = rule;
  const fileTree = snap.fileTree || [];

  switch (check) {
    case "file_exists": {
      const target = String(params.path).trim().replace(/^\/+/, "");
      const exists = fileTree.some(
        (f) => f.toLowerCase() === target.toLowerCase() || f === target
      );
      return {
        id,
        name,
        description,
        check,
        pass: exists,
        evidence: exists
          ? `File '${target}' exists in repository.`
          : `File '${target}' does not exist in repository.`,
        severity,
        weight,
      };
    }

    case "file_missing": {
      const target = String(params.path).trim().replace(/^\/+/, "");
      const exists = fileTree.some(
        (f) => f.toLowerCase() === target.toLowerCase() || f === target
      );
      return {
        id,
        name,
        description,
        check,
        pass: !exists,
        evidence: !exists
          ? `File '${target}' is not present in repository (as required).`
          : `File '${target}' was found in repository, but should be missing.`,
        severity,
        weight,
      };
    }

    case "file_contains": {
      const target = String(params.path).trim().replace(/^\/+/, "");
      const pattern = String(params.pattern);
      const isRegex = Boolean(params.isRegex);

      const content = getSnapshotFileContent(snap, target);
      if (content === null) {
        return {
          id,
          name,
          description,
          check,
          pass: false,
          evidence: `File '${target}' was not found or its contents are not available in snapshot.`,
          severity,
          weight,
        };
      }

      let matches = false;
      if (isRegex) {
        try {
          const re = new RegExp(pattern, "i");
          matches = re.test(content);
        } catch (err: unknown) {
          return {
            id,
            name,
            description,
            check,
            pass: false,
            evidence: `Invalid regex pattern '${pattern}': ${err instanceof Error ? err.message : String(err)}`,
            severity,
            weight,
          };
        }
      } else {
        matches = content.includes(pattern);
      }

      return {
        id,
        name,
        description,
        check,
        pass: matches,
        evidence: matches
          ? `File '${target}' contains required pattern '${pattern}'.`
          : `File '${target}' does not contain pattern '${pattern}'.`,
        severity,
        weight,
      };
    }

    case "file_count": {
      let matcher: (file: string) => boolean;

      if (params.pattern) {
        try {
          const re = new RegExp(String(params.pattern), "i");
          matcher = (f) => re.test(f);
        } catch (err: unknown) {
          return {
            id,
            name,
            description,
            check,
            pass: false,
            evidence: `Invalid file pattern regex '${params.pattern}': ${err instanceof Error ? err.message : String(err)}`,
            severity,
            weight,
          };
        }
      } else if (params.glob) {
        const re = globToRegex(String(params.glob));
        matcher = (f) => re.test(f);
      } else {
        matcher = () => true;
      }

      const matchingFiles = fileTree.filter(matcher);
      const count = matchingFiles.length;
      const min = params.min as number | undefined;
      const max = params.max as number | undefined;

      const minPass = min === undefined || count >= min;
      const maxPass = max === undefined || count <= max;
      const pass = minPass && maxPass;

      const constraints: string[] = [];
      if (min !== undefined) constraints.push(`min ${min}`);
      if (max !== undefined) constraints.push(`max ${max}`);
      const constraintStr = constraints.join(", ");

      return {
        id,
        name,
        description,
        check,
        pass,
        evidence: pass
          ? `Found ${count} matching files (meets requirement of ${constraintStr}).`
          : `Found ${count} matching files, failing requirement (${constraintStr}).`,
        severity,
        weight,
      };
    }

    case "json_field_equals": {
      const target = String(params.path).trim().replace(/^\/+/, "");
      const field = String(params.field);
      const expectedValue = params.value;

      const content = getSnapshotFileContent(snap, target);
      if (content === null) {
        return {
          id,
          name,
          description,
          check,
          pass: false,
          evidence: `JSON file '${target}' was not found or its contents are not available in snapshot.`,
          severity,
          weight,
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        return {
          id,
          name,
          description,
          check,
          pass: false,
          evidence: `File '${target}' contains invalid JSON.`,
          severity,
          weight,
        };
      }

      const actualValue = getNestedProperty(parsed, field);
      const equals =
        JSON.stringify(actualValue) === JSON.stringify(expectedValue) ||
        actualValue === expectedValue;

      return {
        id,
        name,
        description,
        check,
        pass: equals,
        evidence: equals
          ? `File '${target}' field '${field}' equals expected value (${JSON.stringify(expectedValue)}).`
          : `File '${target}' field '${field}' is ${JSON.stringify(actualValue)} (expected ${JSON.stringify(expectedValue)}).`,
        severity,
        weight,
      };
    }

    default: {
      return {
        id,
        name,
        description,
        check,
        pass: false,
        evidence: `Unknown check type: ${check}`,
        severity,
        weight,
      };
    }
  }
}

/**
 * Runs a list of custom rules against a repository snapshot.
 */
export function runCustomRules(
  snap: RepoSnapshot & { fileContents?: Record<string, string> },
  rules: CustomRule[]
): CustomRuleCheckResult[] {
  return rules.map((rule) => evaluateCustomRule(snap, rule));
}

/**
 * Loads rules from rules.json file in project root if it exists.
 */
export function loadProjectRules(projectRoot: string = process.cwd()): CustomRule[] {
  const rulesPath = path.resolve(projectRoot, "rules.json");
  if (!fs.existsSync(rulesPath)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(rulesPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn("[repojudge] rules.json is not an array of rules.");
      return [];
    }

    const validated: CustomRule[] = [];
    for (const item of parsed) {
      const res = CustomRuleSchema.safeParse(item);
      if (res.success) {
        validated.push(res.data);
      } else {
        console.warn(`[repojudge] Invalid rule in rules.json: ${res.error.message}`);
      }
    }
    return validated;
  } catch (err: unknown) {
    console.warn(`[repojudge] Failed to load rules.json: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
