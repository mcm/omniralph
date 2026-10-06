import { describe, expect, it } from "vitest";
import {
  fieldErrors,
  parseCommaList,
  parsePathExcludes,
  pathExcludeGlobError,
  RalphSettingsInput,
  RepositorySettingsInput,
  ReviewProfileInput,
} from "./settings.js";

const validSettings: RepositorySettingsInput = {
  profileId: "standard",
  triggers: { onOpen: true, onPush: false, drafts: false },
  pathExcludes: ["*.lock", "/vendor/**", "src/**/*.{gen,pb}.ts", "docs/[!_]*.md"],
  customInstructions: "Prefer early returns.",
  pinnedAgentIds: [],
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
      pinnedAgentIds: ["not-a-uuid"],
    });
    expect(Object.keys(fieldErrors(result.error!)).sort()).toEqual([
      "pinnedAgentIds.0",
      "profileId",
    ]);
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

const validRalph: RalphSettingsInput = {
  ralphEnabled: true,
  linearTeamKeys: ["TOOL", "eng_2"],
  linearProjectNames: ["Omniralph v2"],
  linearLabels: ["backend", "needs: api"],
  openPullRequestEarly: false,
  setupCommand: "pnpm install --frozen-lockfile",
  model: "opus",
  manualLabels: ["manual", "needs a person"],
};

describe("parseCommaList", () => {
  it("trims, drops blanks and removes duplicates ignoring case", () => {
    expect(parseCommaList(" TOOL, eng,,tool , ENG ,Ops ")).toEqual(["TOOL", "eng", "Ops"]);
    expect(parseCommaList("  ")).toEqual([]);
  });
});

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

  it("rejects bad team keys, names with commas, bad models and long setup commands", () => {
    const result = RalphSettingsInput.safeParse({
      ...validRalph,
      linearTeamKeys: ["TOOL", "EN G"],
      linearProjectNames: ["a,b"],
      linearLabels: [" "],
      setupCommand: "x".repeat(4001),
      model: "opus; rm -rf /",
    });
    expect(fieldErrors(result.error!)).toEqual({
      "linearTeamKeys.1": "Team keys are letters and digits, e.g. ENG.",
      "linearProjectNames.0": "Names can't contain commas or control characters.",
      "linearLabels.0": "Enter a name.",
      setupCommand: "The setup command can be at most 4,000 characters.",
      model: "Enter a Claude model ID, e.g. claude-sonnet-5-5.",
    });
  });

  it("caps the number of routing values", () => {
    const result = RalphSettingsInput.safeParse({
      ...validRalph,
      linearLabels: Array.from({ length: 51 }, (_, i) => `l${i}`),
    });
    expect(fieldErrors(result.error!)).toEqual({ linearLabels: "At most 50 labels." });
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
});
