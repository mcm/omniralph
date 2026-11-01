import { describe, expect, it } from "vitest";
import {
  epicCompletedTarget,
  fieldErrors,
  parseLines,
  parsePathExcludes,
  pathExcludeGlobError,
  RepositoryCodingInput,
  RepositorySettingsInput,
  RepositoryTaskTypesInput,
} from "./settings.js";

const validSettings: RepositorySettingsInput = {
  depth: "standard",
  triggers: { onOpen: true, onPush: false, drafts: false },
  pathExcludes: ["*.lock", "/vendor/**", "src/**/*.{gen,pb}.ts", "docs/[!_]*.md"],
  customInstructions: "Prefer early returns.",
  pinnedAgentIds: [],
  reviewPlaybookIds: ["builtin:review-pr"],
  correlationPlaybookId: "builtin:correlate-findings",
};

describe("pathExcludeGlobError", () => {
  it.each([
    "/*",
    "*.lock",
    "/vendor/**",
    "**/__snapshots__/**",
    "src/**/*.{gen,pb}.ts",
    "a/[(]b.ts",
    "+(a|b).js",
    "file\\[1\\].txt",
  ])("accepts %s", (pattern) => {
    expect(pathExcludeGlobError(pattern)).toBeNull();
  });

  it.each([
    ["", "Enter a glob pattern."],
    [" *.lock", "Remove the leading or trailing spaces."],
    ["!keep.ts", "Negated patterns (starting with !) aren't supported."],
    ["src/[abc.ts", 'Missing a closing "]".'],
    ["src/abc].ts", 'Unbalanced "]".'],
    ["src/{a,b.ts", 'Missing a closing "}".'],
    ["src/a,b}.ts", 'Unbalanced "}".'],
    ["src/(a|b.ts", 'Missing a closing ")".'],
    ["src/***/x", "Use ** to match any number of directories."],
    ["**", "This pattern would exclude every file."],
    ["/**", "This pattern would exclude every file."],
    ["*", "This pattern would exclude every file."],
    ["dir\\", "The pattern ends with an unfinished escape (\\)."],
    ["a".repeat(501), "Patterns can be at most 500 characters."],
  ])("rejects %j", (pattern, message) => {
    expect(pathExcludeGlobError(pattern)).toBe(message);
  });
});

describe("parsePathExcludes", () => {
  it("splits lines and drops blank ones", () => {
    expect(parsePathExcludes("*.lock\r\n\n  dist/**  \n")).toEqual(["*.lock", "dist/**"]);
  });
});

describe("RepositorySettingsInput", () => {
  it("accepts valid settings", () => {
    expect(RepositorySettingsInput.parse(validSettings)).toEqual(validSettings);
  });

  it("reports a bad glob on its line", () => {
    const result = RepositorySettingsInput.safeParse({
      ...validSettings,
      pathExcludes: ["*.lock", "src/{a,b.ts"],
    });
    expect(result.success).toBe(false);
    expect(fieldErrors(result.error!)).toEqual({ "pathExcludes.1": 'Missing a closing "}".' });
  });

  it("rejects custom instructions over 4,000 characters", () => {
    expect(
      RepositorySettingsInput.safeParse({ ...validSettings, customInstructions: "x".repeat(4000) })
        .success,
    ).toBe(true);
    const result = RepositorySettingsInput.safeParse({
      ...validSettings,
      customInstructions: "x".repeat(4001),
    });
    expect(fieldErrors(result.error!)).toEqual({
      customInstructions: "Custom instructions can be at most 4,000 characters.",
    });
  });

  it("rejects unknown depths and malformed agent IDs", () => {
    const result = RepositorySettingsInput.safeParse({
      ...validSettings,
      depth: "turbo",
      pinnedAgentIds: ["not-a-uuid"],
    });
    expect(Object.keys(fieldErrors(result.error!)).sort()).toEqual(["depth", "pinnedAgentIds.0"]);
  });

  it("takes one to 20 distinct review playbooks, or leaves them unchanged", () => {
    const errors = (reviewPlaybookIds: string[]) => {
      const result = RepositorySettingsInput.safeParse({ ...validSettings, reviewPlaybookIds });
      return result.success ? {} : fieldErrors(result.error);
    };
    expect(errors(["builtin:review-pr", "builtin:security-review"])).toEqual({});
    const { reviewPlaybookIds: _ids, correlationPlaybookId: _id, ...unbound } = validSettings;
    expect(RepositorySettingsInput.safeParse(unbound).success).toBe(true);
    expect(errors([])).toEqual({ reviewPlaybookIds: "Choose at least one review playbook." });
    expect(errors(["builtin:review-pr", "builtin:review-pr"])).toEqual({
      reviewPlaybookIds: "Choose each review playbook once.",
    });
    expect(errors(Array.from({ length: 21 }, (_, i) => `task-${i}`))).toEqual({
      reviewPlaybookIds: "At most 20 review playbooks.",
    });
  });

  it("accepts each review depth and rejects any other", () => {
    for (const depth of ["quick", "standard", "deep"] as const) {
      expect(RepositorySettingsInput.parse({ ...validSettings, depth }).depth).toBe(depth);
    }
    const result = RepositorySettingsInput.safeParse({ ...validSettings, depth: "thorough" });
    expect(fieldErrors(result.error!)).toEqual({
      depth: "Choose a review depth: quick, standard or deep.",
    });
  });

  it("refuses an empty correlation playbook", () => {
    const result = RepositorySettingsInput.safeParse({
      ...validSettings,
      correlationPlaybookId: "",
    });
    expect(fieldErrors(result.error!)).toEqual({
      correlationPlaybookId: "Choose a correlation playbook.",
    });
  });
});

describe("RepositoryTaskTypesInput", () => {
  it("accepts on and off for each switch", () => {
    for (const value of [true, false]) {
      const input = { reviews: value, coding: value, ask: value };
      expect(RepositoryTaskTypesInput.parse(input)).toEqual(input);
    }
  });

  it("rejects a missing, null (inherit) or non-boolean switch, and the old keys", () => {
    const result = RepositoryTaskTypesInput.safeParse({ reviews: "on", ask: null });
    expect(fieldErrors(result.error!)).toEqual({
      reviews: "Choose on or off.",
      coding: "Choose on or off.",
      ask: "Choose on or off.",
    });
    expect(
      RepositoryTaskTypesInput.safeParse({ reviews: true, coding: false, ask: true, query: true })
        .success,
    ).toBe(false);
  });
});

const validCoding: RepositoryCodingInput = {
  codingEnabled: true,
  codingInstructions: "NEVER use `git merge` in this repo, ALWAYS rebase.",
  openPullRequestEarly: false,
  historyRewrite: "always",
  respondToReviewsAndCi: true,
  checks: ["pnpm lint", "pnpm test"],
};

describe("RepositoryCodingInput", () => {
  it("accepts the coding policy, with or without instructions and checks", () => {
    expect(RepositoryCodingInput.parse(validCoding)).toEqual(validCoding);
    expect(
      RepositoryCodingInput.safeParse({ ...validCoding, codingInstructions: null }).success,
    ).toBe(true);
    expect(RepositoryCodingInput.parse({ ...validCoding, checks: [] }).checks).toEqual([]);
  });

  it("trims each check and keeps their order", () => {
    expect(
      RepositoryCodingInput.parse({ ...validCoding, checks: ["  pnpm test ", "pnpm build"] })
        .checks,
    ).toEqual(["pnpm test", "pnpm build"]);
  });

  it("refuses blank, multi-line, long and too many checks", () => {
    const errors = (checks: string[]) =>
      fieldErrors(RepositoryCodingInput.safeParse({ ...validCoding, checks }).error!);
    expect(errors(["pnpm lint", " "])).toEqual({ "checks.1": "Enter a command." });
    expect(errors(["pnpm lint\npnpm test"])).toEqual({
      "checks.0": "Commands are one line, without control characters.",
    });
    expect(errors(["x".repeat(4001)])).toEqual({
      "checks.0": "Commands can be at most 4,000 characters.",
    });
    expect(errors(Array.from({ length: 51 }, (_, index) => `echo ${index}`))).toEqual({
      checks: "Add at most 50 checks.",
    });
  });

  it("rejects unknown keys, such as the settings that moved to playbooks", () => {
    for (const key of [
      "model",
      "verifyCommands",
      "maxReviewRounds",
      "manualLabels",
      "storyPlaybookId",
    ]) {
      const parsed = RepositoryCodingInput.safeParse({ ...validCoding, [key]: "x" });
      expect(parsed.success).toBe(false);
      expect(fieldErrors(parsed.error!)).toEqual({ form: expect.stringContaining(key) });
    }
  });

  it("rejects missing switches, unknown policies and long instructions", () => {
    expect(
      fieldErrors(
        RepositoryCodingInput.safeParse({
          ...validCoding,
          codingEnabled: undefined,
          historyRewrite: "sometimes",
          codingInstructions: "x".repeat(10_001),
        }).error!,
      ),
    ).toEqual({
      codingEnabled: "Choose on or off.",
      historyRewrite: "Choose a policy.",
      codingInstructions: "Extra instructions can be at most 10,000 characters.",
    });
  });
});

describe("epicCompletedTarget", () => {
  it("names a state, and a state type falls back to the first state of that type", () => {
    expect(epicCompletedTarget(null)).toBeNull();
    expect(epicCompletedTarget(" ")).toBeNull();
    expect(epicCompletedTarget("In Review")).toEqual({ name: "In Review" });
    expect(epicCompletedTarget("Completed")).toEqual({ name: "Completed", type: "completed" });
    expect(epicCompletedTarget("started")).toEqual({ name: "started", type: "started" });
  });
});

describe("parseLines", () => {
  it("splits lines, trimming and dropping blanks", () => {
    expect(parseLines(" pnpm test \r\n\n pnpm lint")).toEqual(["pnpm test", "pnpm lint"]);
  });
});
