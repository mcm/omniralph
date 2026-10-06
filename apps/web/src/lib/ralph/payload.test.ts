import { randomUUID } from "node:crypto";
import {
  DEFAULT_RALPH_SETTINGS,
  type RalphRun,
  type RalphSettings,
  type RalphStory,
  type Repository,
  type ScmConnection,
} from "@omniralph/db";
import type { Epic, Story } from "@omniralph/ralph";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { buildDescribePrPayload, buildStoryPayload, jobSettings, storyQualityGates } =
  await import("./payload");

const story: Story = {
  key: "issue-2",
  storyId: "ENG-2",
  identifier: "ENG-2",
  issueId: "issue-2",
  title: "Alpha",
  description: "Do it.",
  acceptanceCriteria: [],
  priority: 0,
  dependsOn: [],
  status: "open",
};

const epic = (kind: Epic["kind"] = "children"): Epic => ({
  kind,
  issueId: "issue-1",
  identifier: "ENG-1",
  title: "Epic",
  description: "Build the thing.",
  branchName: "feat/epic",
  qualityGates: ["pnpm test", "pnpm lint"],
  stories: [story],
});

const repository = (settings: Partial<RalphSettings> = {}) =>
  ({
    id: randomUUID(),
    provider: "github",
    fullPath: "acme/api",
    ralphSettings: { ...DEFAULT_RALPH_SETTINGS, ...settings },
  }) as Repository;

const connection = { baseUrl: "https://api.github.com" } as ScmConnection;

const run = (kind: RalphRun["kind"] = "children") =>
  ({
    id: randomUUID(),
    kind,
    progress: "",
    guidance: [],
  }) as unknown as RalphRun;

const lane = { branch: "feat/epic", baseBranch: "main" };

const row = { id: randomUUID(), linearIssueId: "issue-2", attempts: 0, lastFeedback: null };

function payloadFor(kind: RalphRun["kind"], settings: Partial<RalphSettings>) {
  return buildStoryPayload({
    run: run(kind),
    lane,
    repository: repository(settings),
    connection,
    epic: epic(kind === "single" ? "single" : "children"),
    stories: [story],
    story,
    row: row as RalphStory,
  });
}

describe("story quality gates", () => {
  it("are the verify commands, then the PRD's gates, without duplicates", () => {
    const payload = payloadFor("children", {
      verifyCommands: ["pnpm typecheck", " pnpm test "],
    });
    expect(payload.qualityGates).toEqual(["pnpm typecheck", "pnpm test", "pnpm lint"]);
    // The prompt still shows the PRD's gates (those the job runs aren't repeated as the agent's).
    expect(payload.prdQualityGates).toEqual(["pnpm test", "pnpm lint"]);
  });

  it("are only the verify commands with runPrdQualityGates off", () => {
    const payload = payloadFor("children", {
      verifyCommands: ["pnpm typecheck"],
      runPrdQualityGates: false,
    });
    expect(payload.qualityGates).toEqual(["pnpm typecheck"]);
    expect(payload.prdQualityGates).toEqual(["pnpm test", "pnpm lint"]);
  });

  it("are the PRD's gates by default", () => {
    expect(payloadFor("children", {}).qualityGates).toEqual(["pnpm test", "pnpm lint"]);
  });

  it("are only the verify commands for a single issue", () => {
    const payload = payloadFor("single", { verifyCommands: ["make check"] });
    expect(payload.qualityGates).toEqual(["make check"]);
    expect(payload.prdQualityGates).toEqual([]);
    expect(storyQualityGates("single", epic(), repository())).toEqual([]);
  });

  it("are what the describe-pr job reports as the verification", () => {
    const payload = buildDescribePrPayload({
      run: run(),
      lane,
      repository: repository({ verifyCommands: ["pnpm typecheck"] }),
      connection,
      epic: epic(),
      rows: [],
    });
    expect(payload.qualityGates).toEqual(["pnpm typecheck", "pnpm test", "pnpm lint"]);
  });
});

describe("job settings", () => {
  it("carry the repository's prompt, model and tool settings", () => {
    expect(
      payloadFor("children", {
        model: "sonnet",
        fallbackModel: "haiku",
        appendInstruction: "Write a changelog entry.",
        allowedTools: ["Read", "Bash(pnpm test:*)"],
        disallowedTools: ["WebFetch"],
        setupCommand: "pnpm install",
      }).settings,
    ).toEqual({
      model: "sonnet",
      fallbackModel: "haiku",
      appendInstruction: "Write a changelog entry.",
      allowedTools: ["Read", "Bash(pnpm test:*)"],
      disallowedTools: ["WebFetch"],
      setupCommand: "pnpm install",
    });
  });

  it("fill in the defaults for a row saved before the settings existed", () => {
    const old = {
      ralphSettings: { openPullRequestEarly: false, setupCommand: null, model: "opus" },
    } as unknown as Repository;
    expect(jobSettings(old)).toEqual({
      model: "opus",
      setupCommand: null,
      fallbackModel: null,
      appendInstruction: null,
      allowedTools: null,
      disallowedTools: null,
    });
  });

  it("match the shared schema's defaults", async () => {
    const { DEFAULT_RALPH_SETTINGS: shared } = await import("@omniralph/shared");
    expect(DEFAULT_RALPH_SETTINGS).toEqual(shared);
  });
});
