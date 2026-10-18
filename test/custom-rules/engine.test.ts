import { describe, it, expect } from "vitest";
import {
  CustomRuleSchema,
  FileExistsParams,
  FileMissingParams,
  FileContainsParams,
  FileCountParams,
  JsonFieldEqualsParams,
  CustomRule,
} from "../../src/custom-rules/schema.js";
import {
  evaluateCustomRule,
  runCustomRules,
  globToRegex,
  getNestedProperty,
  loadProjectRules,
} from "../../src/custom-rules/engine.js";
import { RepoSnapshot } from "../../src/schema.js";

function makeSnapshot(overrides: Partial<RepoSnapshot> & { fileContents?: Record<string, string> } = {}): RepoSnapshot & { fileContents?: Record<string, string> } {
  return {
    url: "https://github.com/example/repo",
    owner: "example",
    name: "repo",
    isPublic: true,
    license: "MIT License",
    readme: "# Example Project\nThis is a sample project for testing.\nLicense: MIT.",
    fileTree: [
      "README.md",
      "package.json",
      "tsconfig.json",
      "src/index.ts",
      "src/utils.ts",
      "test/index.test.ts",
    ],
    fileContents: {
      "package.json": JSON.stringify({
        name: "test-pkg",
        type: "module",
        scripts: { test: "vitest" },
      }),
      ...overrides.fileContents,
    },
    commitCount: 20,
    contributors: [{ login: "alice", commits: 20 }],
    hasCI: true,
    hasTests: true,
    hasCodeOfConduct: true,
    linksMlhCoc: true,
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Custom Rules Schema Validation", () => {
  it("validates a correct file_exists rule", () => {
    const valid = {
      id: "check-license",
      name: "Check License",
      check: "file_exists",
      params: { path: "LICENSE" },
      severity: "high",
      weight: 2,
    };
    const res = CustomRuleSchema.safeParse(valid);
    expect(res.success).toBe(true);
  });

  it("rejects file_exists rule with missing path parameter", () => {
    const invalid = {
      id: "check-license",
      name: "Check License",
      check: "file_exists",
      params: {},
    };
    const res = CustomRuleSchema.safeParse(invalid);
    expect(res.success).toBe(false);
  });

  it("validates file_missing rule", () => {
    const valid = {
      id: "no-env",
      name: "No Env",
      check: "file_missing",
      params: { path: ".env" },
    };
    expect(CustomRuleSchema.safeParse(valid).success).toBe(true);
  });

  it("validates file_contains rule", () => {
    const valid = {
      id: "readme-license",
      name: "README has license",
      check: "file_contains",
      params: { path: "README.md", pattern: "MIT", isRegex: false },
    };
    expect(CustomRuleSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects file_contains with empty pattern", () => {
    const invalid = {
      id: "readme-license",
      name: "README has license",
      check: "file_contains",
      params: { path: "README.md", pattern: "" },
    };
    expect(CustomRuleSchema.safeParse(invalid).success).toBe(false);
  });

  it("validates file_count rule with glob and min/max", () => {
    const valid = {
      id: "ts-count",
      name: "TS File Count",
      check: "file_count",
      params: { glob: "src/**/*.ts", min: 1, max: 10 },
    };
    expect(CustomRuleSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects file_count rule without min or max", () => {
    const invalid = {
      id: "ts-count",
      name: "TS File Count",
      check: "file_count",
      params: { glob: "src/**/*.ts" },
    };
    expect(CustomRuleSchema.safeParse(invalid).success).toBe(false);
  });

  it("validates json_field_equals rule", () => {
    const valid = {
      id: "pkg-type",
      name: "Package is ESM",
      check: "json_field_equals",
      params: { path: "package.json", field: "type", value: "module" },
    };
    expect(CustomRuleSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects rule with invalid ID format (contains spaces)", () => {
    const invalid = {
      id: "bad id with spaces",
      name: "Bad ID",
      check: "file_exists",
      params: { path: "README.md" },
    };
    expect(CustomRuleSchema.safeParse(invalid).success).toBe(false);
  });
});

describe("Custom Rules Engine Checks", () => {
  const snap = makeSnapshot();

  describe("file_exists check", () => {
    it("passes when file exists in fileTree", () => {
      const rule: CustomRule = {
        id: "check-pkg",
        name: "Check package.json",
        check: "file_exists",
        params: { path: "package.json" },
        severity: "medium",
        weight: 1,
      };
      const result = evaluateCustomRule(snap, rule);
      expect(result.pass).toBe(true);
      expect(result.evidence).toContain("exists in repository");
    });

    it("fails when file does not exist in fileTree", () => {
      const rule: CustomRule = {
        id: "check-docker",
        name: "Check Dockerfile",
        check: "file_exists",
        params: { path: "Dockerfile" },
        severity: "low",
        weight: 1,
      };
      const result = evaluateCustomRule(snap, rule);
      expect(result.pass).toBe(false);
      expect(result.evidence).toContain("does not exist in repository");
    });
  });

  describe("file_missing check", () => {
    it("passes when file is not in fileTree", () => {
      const rule: CustomRule = {
        id: "no-env",
        name: "No .env",
        check: "file_missing",
        params: { path: ".env" },
        severity: "high",
        weight: 2,
      };
      const result = evaluateCustomRule(snap, rule);
      expect(result.pass).toBe(true);
      expect(result.evidence).toContain("is not present");
    });

    it("fails when file is present in fileTree", () => {
      const rule: CustomRule = {
        id: "no-readme",
        name: "No README",
        check: "file_missing",
        params: { path: "README.md" },
        severity: "high",
        weight: 2,
      };
      const result = evaluateCustomRule(snap, rule);
      expect(result.pass).toBe(false);
      expect(result.evidence).toContain("was found in repository");
    });
  });

  describe("file_contains check", () => {
    it("passes when text substring is found in README", () => {
      const rule: CustomRule = {
        id: "readme-sample",
        name: "README has sample",
        check: "file_contains",
        params: { path: "README.md", pattern: "sample project", isRegex: false },
        severity: "medium",
        weight: 1,
      };
      const result = evaluateCustomRule(snap, rule);
      expect(result.pass).toBe(true);
      expect(result.evidence).toContain("contains required pattern");
    });

    it("passes when regex pattern matches in README", () => {
      const rule: CustomRule = {
        id: "readme-regex",
        name: "README has License mention",
        check: "file_contains",
        params: { path: "README.md", pattern: "license:\\s*mit", isRegex: true },
        severity: "medium",
        weight: 1,
      };
      const result = evaluateCustomRule(snap, rule);
      expect(result.pass).toBe(true);
    });

    it("fails when pattern is missing", () => {
      const rule: CustomRule = {
        id: "readme-missing-pattern",
        name: "README has Docker mention",
        check: "file_contains",
        params: { path: "README.md", pattern: "Docker Container", isRegex: false },
        severity: "medium",
        weight: 1,
      };
      const result = evaluateCustomRule(snap, rule);
      expect(result.pass).toBe(false);
      expect(result.evidence).toContain("does not contain pattern");
    });
  });

  describe("file_count check", () => {
    it("passes when matching count satisfies min and max", () => {
      const rule: CustomRule = {
        id: "src-ts-count",
        name: "Source TS Files",
        check: "file_count",
        params: { glob: "src/**/*.ts", min: 1, max: 5 },
        severity: "medium",
        weight: 1,
      };
      const result = evaluateCustomRule(snap, rule);
      expect(result.pass).toBe(true);
      expect(result.evidence).toContain("Found 2 matching files");
    });

    it("fails when matching count is below min", () => {
      const rule: CustomRule = {
        id: "src-ts-count-too-high",
        name: "Source TS Files",
        check: "file_count",
        params: { glob: "src/**/*.ts", min: 10 },
        severity: "medium",
        weight: 1,
      };
      const result = evaluateCustomRule(snap, rule);
      expect(result.pass).toBe(false);
      expect(result.evidence).toContain("failing requirement");
    });

    it("matches files with regex pattern", () => {
      const rule: CustomRule = {
        id: "test-files-count",
        name: "Test Files",
        check: "file_count",
        params: { pattern: "\\.test\\.ts$", min: 1 },
        severity: "medium",
        weight: 1,
      };
      const result = evaluateCustomRule(snap, rule);
      expect(result.pass).toBe(true);
      expect(result.evidence).toContain("Found 1 matching files");
    });
  });

  describe("json_field_equals check", () => {
    it("passes when top-level field matches expected value", () => {
      const rule: CustomRule = {
        id: "pkg-esm",
        name: "ESM Module",
        check: "json_field_equals",
        params: { path: "package.json", field: "type", value: "module" },
        severity: "high",
        weight: 1,
      };
      const result = evaluateCustomRule(snap, rule);
      expect(result.pass).toBe(true);
      expect(result.evidence).toContain("equals expected value");
    });

    it("passes when nested field matches expected value", () => {
      const rule: CustomRule = {
        id: "pkg-test-script",
        name: "Vitest Script",
        check: "json_field_equals",
        params: { path: "package.json", field: "scripts.test", value: "vitest" },
        severity: "medium",
        weight: 1,
      };
      const result = evaluateCustomRule(snap, rule);
      expect(result.pass).toBe(true);
    });

    it("fails when field value differs", () => {
      const rule: CustomRule = {
        id: "pkg-cjs",
        name: "CommonJS Module",
        check: "json_field_equals",
        params: { path: "package.json", field: "type", value: "commonjs" },
        severity: "medium",
        weight: 1,
      };
      const result = evaluateCustomRule(snap, rule);
      expect(result.pass).toBe(false);
      expect(result.evidence).toContain("is \"module\" (expected \"commonjs\")");
    });
  });

  describe("runCustomRules batch execution", () => {
    it("executes an array of rules and returns individual results", () => {
      const rules: CustomRule[] = [
        {
          id: "r1",
          name: "R1",
          check: "file_exists",
          params: { path: "README.md" },
          severity: "low",
          weight: 1,
        },
        {
          id: "r2",
          name: "R2",
          check: "file_missing",
          params: { path: "missing-file.txt" },
          severity: "high",
          weight: 2,
        },
      ];
      const results = runCustomRules(snap, rules);
      expect(results).toHaveLength(2);
      expect(results[0].pass).toBe(true);
      expect(results[1].pass).toBe(true);
    });
  });

  describe("loadProjectRules", () => {
    it("loads rules from rules.json if present in cwd", () => {
      const rules = loadProjectRules();
      expect(Array.isArray(rules)).toBe(true);
      expect(rules.length).toBeGreaterThan(0);
      expect(rules[0].id).toBeDefined();
    });
  });
});
