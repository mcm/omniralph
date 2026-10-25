import { describe, expect, it } from "vitest";
import {
  DEFAULT_RALPH_SETTINGS,
  epicCompletedTarget,
  fieldErrors,
  parseLines,
  parseRalphSettings,
  RalphSettings,
  ralphSettingsFromInput,
  parsePathExcludes,
  pathExcludeGlobError,
  RalphSettingsInput,
  RepositorySettingsInput,
  RepositoryTaskTypesInput,
  ReviewProfileInput,
} from "./settings.js";

const validSettings: RepositorySettingsInput = {
  profileId: "standard",
  triggers: { onOpen: true, onPush: false, drafts: false },
  pathExcludes: ["*.lock", "/vendor/**", "src/**/*.{gen,pb}.ts", "docs/[!_]*.md"],
  customInstructions: "Prefer early returns.",
  pinnedHarnessIds: [],
  reviewTaskIds: ["builtin:review-pr"],
  correlationTaskId: "builtin:correlate-findings",
};

const validProfile: ReviewProfileInput = {
  model: "claude-sonnet-5-5",
  maxTokensPerReview: 200_000,
  maxFiles: 40,
  allowRepoExploration: true,
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

  it("rejects unknown profiles and malformed agent IDs", () => {
    const result = RepositorySettingsInput.safeParse({
      ...validSettings,
      profileId: "turbo",
      pinnedHarnessIds: ["not-a-uuid"],
    });
    expect(Object.keys(fieldErrors(result.error!)).sort()).toEqual([
      "pinnedHarnessIds.0",
      "profileId",
    ]);
  });

  it("requires one to 20 distinct review tasks", () => {
    const errors = (reviewTaskIds: string[]) => {
      const result = RepositorySettingsInput.safeParse({ ...validSettings, reviewTaskIds });
      return result.success ? {} : fieldErrors(result.error);
    };
    expect(errors(["builtin:review-pr", "builtin:security-review"])).toEqual({});
    expect(errors([])).toEqual({ reviewTaskIds: "Choose at least one review task." });
    expect(errors(["builtin:review-pr", "builtin:review-pr"])).toEqual({
      reviewTaskIds: "Choose each review task once.",
    });
    expect(errors(Array.from({ length: 21 }, (_, i) => `task-${i}`))).toEqual({
      reviewTaskIds: "At most 20 review tasks.",
    });
  });

  it("requires a correlation task", () => {
    const result = RepositorySettingsInput.safeParse({ ...validSettings, correlationTaskId: "" });
    expect(fieldErrors(result.error!)).toEqual({ correlationTaskId: "Choose a correlation task." });
  });
});

describe("ReviewProfileInput", () => {
  it("accepts a valid profile", () => {
    expect(ReviewProfileInput.parse(validProfile)).toEqual(validProfile);
  });

  it("rejects a token cap below 5,000", () => {
    expect(
      ReviewProfileInput.safeParse({ ...validProfile, maxTokensPerReview: 5000 }).success,
    ).toBe(true);
    const result = ReviewProfileInput.safeParse({ ...validProfile, maxTokensPerReview: 4999 });
    expect(fieldErrors(result.error!)).toEqual({
      maxTokensPerReview: "The token cap must be at least 5,000.",
    });
  });

  it("rejects empty models, fractional numbers and zero max files", () => {
    const result = ReviewProfileInput.safeParse({
      ...validProfile,
      model: "  ",
      maxTokensPerReview: 10_000.5,
      maxFiles: 0,
    });
    expect(fieldErrors(result.error!)).toEqual({
      model: "Enter a model.",
      maxTokensPerReview: "Enter a whole number.",
      maxFiles: "Max files must be at least 1.",
    });
  });
});

describe("RepositoryTaskTypesInput", () => {
  it("accepts on, off and null (the organization's default) for each task type", () => {
    for (const value of [true, false, null]) {
      const input = { query: value, review: value, coding: value };
      expect(RepositoryTaskTypesInput.parse(input)).toEqual(input);
    }
  });

  it("rejects a missing or non-boolean switch", () => {
    const result = RepositoryTaskTypesInput.safeParse({ query: "on", review: null });
    expect(fieldErrors(result.error!)).toEqual({
      query: "Choose the organization's default, on or off.",
      coding: "Choose the organization's default, on or off.",
    });
  });
});

const validRalph: RalphSettingsInput = {
  storyTaskId: "builtin:implement-story",
  requestTaskId: "builtin:handle-request",
  verifyCommands: ["pnpm typecheck", "pnpm test"],
  runPrdQualityGates: true,
  setupCommand: "pnpm install --frozen-lockfile",
  appendInstruction: "Keep commits small.",
  model: "opus",
  fallbackModel: "",
  allowedTools: [],
  disallowedTools: ["WebFetch"],
  openPullRequestEarly: false,
  historyRewrite: "when-asked",
  respondToReviews: true,
  maxReviewRounds: 3,
  respondToCiFailures: true,
  maxFixRounds: 3,
  cleanupMergedWorktrees: true,
  unmergedBranchTimeoutMinutes: 60,
  manualLabels: ["manual", "needs a person"],
  blockedLabels: ["under-review", "blocked"],
  allowPreparation: true,
  epicCompletedState: "",
};

describe("RalphSettingsInput", () => {
  it("accepts valid settings", () => {
    expect(RalphSettingsInput.parse(validRalph)).toEqual(validRalph);
    expect(
      RalphSettingsInput.parse({ ...validRalph, setupCommand: "", model: " claude-opus-5-5 " }),
    ).toMatchObject({
      setupCommand: "",
      model: "claude-opus-5-5",
    });
  });

  it("rejects bad labels, bad models and long setup commands", () => {
    const result = RalphSettingsInput.safeParse({
      ...validRalph,
      manualLabels: ["a,b"],
      blockedLabels: [" "],
      setupCommand: "x".repeat(4001),
      model: "opus; rm -rf /",
    });
    expect(fieldErrors(result.error!)).toEqual({
      "manualLabels.0": "Names can't contain commas or control characters.",
      "blockedLabels.0": "Enter a name.",
      setupCommand: "The setup command can be at most 4,000 characters.",
      model: "Enter a Claude model ID, e.g. claude-sonnet-5-5.",
    });
  });

  it("caps the number of labels", () => {
    const result = RalphSettingsInput.safeParse({
      ...validRalph,
      blockedLabels: Array.from({ length: 51 }, (_, i) => `l${i}`),
    });
    expect(fieldErrors(result.error!)).toEqual({ blockedLabels: "At most 50 blocked labels." });
  });

  it("needs at least one valid manual label", () => {
    expect(
      fieldErrors(RalphSettingsInput.safeParse({ ...validRalph, manualLabels: [] }).error!),
    ).toEqual({ manualLabels: "Enter at least one manual label." });
    expect(
      fieldErrors(
        RalphSettingsInput.safeParse({ ...validRalph, manualLabels: ["ok", "a,b"] }).error!,
      ),
    ).toEqual({ "manualLabels.1": "Names can't contain commas or control characters." });
  });

  it("allows no blocked labels, but only valid ones", () => {
    expect(RalphSettingsInput.parse({ ...validRalph, blockedLabels: [] }).blockedLabels).toEqual(
      [],
    );
    expect(
      fieldErrors(
        RalphSettingsInput.safeParse({ ...validRalph, blockedLabels: ["blocked", "a,b"] }).error!,
      ),
    ).toEqual({ "blockedLabels.1": "Names can't contain commas or control characters." });
  });
});

describe("RalphSettings", () => {
  it("has the epic's defaults", () => {
    expect(DEFAULT_RALPH_SETTINGS).toEqual({
      verifyCommands: [],
      runPrdQualityGates: true,
      appendInstruction: null,
      allowedTools: null,
      disallowedTools: null,
      model: "opus",
      fallbackModel: null,
      allowPreparation: true,
      manualLabels: ["manual"],
      blockedLabels: ["under-review", "blocked"],
      historyRewrite: "when-asked",
      respondToReviews: true,
      maxReviewRounds: 3,
      respondToCiFailures: true,
      maxFixRounds: 3,
      cleanupMergedWorktrees: true,
      unmergedBranchTimeoutMinutes: 60,
      epicCompletedState: null,
      openPullRequestEarly: false,
      setupCommand: null,
    });
  });

  it("rejects invalid stored settings", () => {
    const result = RalphSettings.safeParse({
      verifyCommands: ["pnpm test\nrm -rf /"],
      allowedTools: ["Bash(git log:*", "rm -rf"],
      historyRewrite: "sometimes",
      maxReviewRounds: -1,
      unmergedBranchTimeoutMinutes: 0,
    });
    expect(Object.keys(fieldErrors(result.error!)).sort()).toEqual([
      "allowedTools.0",
      "allowedTools.1",
      "historyRewrite",
      "maxReviewRounds",
      "unmergedBranchTimeoutMinutes",
      "verifyCommands.0",
    ]);
  });

  it("reads older rows with the defaults for missing or invalid fields", () => {
    expect(
      parseRalphSettings({
        openPullRequestEarly: true,
        setupCommand: "pnpm i",
        model: "sonnet",
        manualLabels: [],
      }),
    ).toEqual({
      ...DEFAULT_RALPH_SETTINGS,
      openPullRequestEarly: true,
      setupCommand: "pnpm i",
      model: "sonnet",
    });
    expect(parseRalphSettings(null)).toEqual(DEFAULT_RALPH_SETTINGS);
    expect(parseRalphSettings({ blockedLabels: [] }).blockedLabels).toEqual([]);
  });
});

describe("ralphSettingsFromInput", () => {
  it("stores empty text and lists as none", () => {
    expect(ralphSettingsFromInput(RalphSettingsInput.parse(validRalph))).toEqual({
      ...DEFAULT_RALPH_SETTINGS,
      verifyCommands: ["pnpm typecheck", "pnpm test"],
      appendInstruction: "Keep commits small.",
      disallowedTools: ["WebFetch"],
      manualLabels: ["manual", "needs a person"],
      setupCommand: "pnpm install --frozen-lockfile",
    });
    expect(
      ralphSettingsFromInput(
        RalphSettingsInput.parse({
          ...validRalph,
          blockedLabels: [],
          fallbackModel: " sonnet ",
          allowedTools: ["Read", "Bash(pnpm test:*)"],
          epicCompletedState: "In Review",
          historyRewrite: "never",
        }),
      ),
    ).toMatchObject({
      blockedLabels: [],
      fallbackModel: "sonnet",
      allowedTools: ["Read", "Bash(pnpm test:*)"],
      epicCompletedState: "In Review",
      historyRewrite: "never",
    });
  });
});

describe("RalphSettingsInput (cyralph settings)", () => {
  it("rejects bad commands, tools, models, rounds and states", () => {
    const result = RalphSettingsInput.safeParse({
      ...validRalph,
      verifyCommands: [" "],
      fallbackModel: "not a model",
      allowedTools: ["Read", "bad tool"],
      maxReviewRounds: 21,
      maxFixRounds: 1.5,
      unmergedBranchTimeoutMinutes: 0,
      historyRewrite: "sometimes",
      epicCompletedState: "a,b",
      appendInstruction: "x".repeat(10_001),
    });
    expect(fieldErrors(result.error!)).toEqual({
      "verifyCommands.0": "Enter a command.",
      fallbackModel: "Enter a Claude model ID, e.g. claude-sonnet-5-5.",
      "allowedTools.1": "Enter a tool name or rule, e.g. Read or Bash(pnpm test:*).",
      maxReviewRounds: "At most 20.",
      maxFixRounds: "Enter a whole number.",
      unmergedBranchTimeoutMinutes: "Enter at least 1 minute.",
      historyRewrite: "Choose a policy.",
      epicCompletedState: "Names can't contain commas or control characters.",
      appendInstruction: "The instruction can be at most 10,000 characters.",
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
