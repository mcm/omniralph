import { randomUUID } from "node:crypto";
import { type RalphRun, type RalphStory, type Repository, type ScmConnection } from "@omniralph/db";
import type { Epic, Story } from "@omniralph/ralph";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  buildDescribePrPayload,
  buildRequestPayload,
  buildStoryPayload,
  jobSettings,
  storyQualityGates,
} = await import("./payload");
const { DEFAULT_CODING_SETTINGS } = await import("./coding");
type CodingSettings = typeof DEFAULT_CODING_SETTINGS;

/** A story or request playbook's coding settings: `settings` over the built-ins'. */
const coding = (settings: Partial<CodingSettings> = {}): CodingSettings => ({
  ...DEFAULT_CODING_SETTINGS,
  model: "opus",
  ...settings,
});

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

const repository = (policy: Partial<Repository> = {}) =>
  ({
    id: randomUUID(),
    provider: "github",
    fullPath: "acme/api",
    codingInstructions: null,
    historyRewrite: "when-asked",
    checks: [],
    ...policy,
  }) as Repository;

const connection = { baseUrl: "https://api.github.com" } as ScmConnection;

const run = (kind: RalphRun["kind"] = "children") =>
  ({
    id: randomUUID(),
    kind,
    origin: "tracker",
    trackerProvider: "linear",
    progress: "",
    guidance: [],
  }) as unknown as RalphRun;

const lane = { branch: "feat/epic", baseBranch: "main" };

const row = { id: randomUUID(), trackerIssueId: "issue-2", attempts: 0, lastFeedback: null };

function payloadFor(
  kind: RalphRun["kind"],
  settings: Partial<CodingSettings>,
  policy: Partial<Repository> = {},
) {
  return buildStoryPayload({
    coding: coding(settings),
    run: run(kind),
    lane,
    repository: repository(policy),
    connection,
    epic: epic(kind === "single" ? "single" : "children"),
    stories: [story],
    story,
    row: row as RalphStory,
  });
}

describe("story quality gates", () => {
  it("are the repo's checks, then the PRD's gates, without duplicates", () => {
    const payload = payloadFor("children", {}, { checks: ["pnpm typecheck", " pnpm test "] });
    expect(payload.qualityGates).toEqual(["pnpm typecheck", "pnpm test", "pnpm lint"]);
    // The prompt still shows the PRD's gates (those the job runs aren't repeated as the agent's).
    expect(payload.prdQualityGates).toEqual(["pnpm test", "pnpm lint"]);
  });

  it("are only the repo's checks with runPrdQualityGates off", () => {
    const payload = payloadFor(
      "children",
      { runPrdQualityGates: false },
      { checks: ["pnpm typecheck"] },
    );
    expect(payload.qualityGates).toEqual(["pnpm typecheck"]);
    expect(payload.prdQualityGates).toEqual(["pnpm test", "pnpm lint"]);
  });

  it("are the PRD's gates for a repo without checks", () => {
    expect(payloadFor("children", {}).qualityGates).toEqual(["pnpm test", "pnpm lint"]);
  });

  it("are only the repo's checks for a single issue", () => {
    const payload = payloadFor("single", {}, { checks: ["make check"] });
    expect(payload.qualityGates).toEqual(["make check"]);
    expect(payload.prdQualityGates).toEqual([]);
    expect(storyQualityGates("single", epic(), repository(), coding())).toEqual([]);
  });

  it("are what the describe-pr job reports as the verification", () => {
    const payload = buildDescribePrPayload({
      coding: coding(),
      run: run(),
      lane,
      repository: repository({ checks: ["pnpm typecheck"] }),
      connection,
      epic: epic(),
      rows: [],
    });
    expect(payload.qualityGates).toEqual(["pnpm typecheck", "pnpm test", "pnpm lint"]);
  });

  it("are a request's gates too, with the repository's checks, instructions and history rule", () => {
    const request = (kind: RalphRun["kind"]) =>
      buildRequestPayload({
        coding: coding(),
        run: run(kind),
        lane: { ...lane, prUrl: null },
        repository: repository({
          checks: ["pnpm typecheck"],
          codingInstructions: "Be brief.",
          historyRewrite: "never",
        }),
        connection,
        epic: epic(kind === "single" ? "single" : "children"),
        stories: [story],
        requests: [{ id: randomUUID(), text: "push it" }],
        resumeSessionId: null,
      });
    expect(request("children")).toMatchObject({
      qualityGates: ["pnpm typecheck", "pnpm test", "pnpm lint"],
      settings: { appendInstruction: "Be brief." },
      historyRewrite: "never",
    });
    expect(request("single").qualityGates).toEqual(["pnpm typecheck"]);
  });

  it("are the lane repository's checks and PRD gates, never another repository's", () => {
    const scoped: Epic = {
      ...epic(),
      repositoryQualityGates: {
        "acme/api": ["cargo test", "pnpm test"],
        "acme/web": ["pnpm build"],
      },
    };
    const api = { ...repository(), fullPath: "Acme/API", checks: ["pnpm typecheck"] };
    const web = { ...repository(), fullPath: "acme/web", checks: ["pnpm build:web"] };
    const other = { ...repository(), fullPath: "acme/docs" };
    const storyPayload = (repo: Repository) =>
      buildStoryPayload({
        coding: coding(),
        run: run(),
        lane,
        repository: repo,
        connection,
        epic: scoped,
        stories: [story],
        story,
        row: row as RalphStory,
      });

    // The main lane runs its repo's checks.
    expect(storyPayload(api)).toMatchObject({
      qualityGates: ["pnpm typecheck", "pnpm test", "pnpm lint", "cargo test"],
      prdQualityGates: ["pnpm test", "pnpm lint", "cargo test"],
    });
    // A story in a second repo's lane runs that repo's checks, not the main repo's.
    expect(storyPayload(web)).toMatchObject({
      qualityGates: ["pnpm build:web", "pnpm test", "pnpm lint", "pnpm build"],
      prdQualityGates: ["pnpm test", "pnpm lint", "pnpm build"],
    });
    expect(storyPayload(other).qualityGates).toEqual(["pnpm test", "pnpm lint"]);
    // With runPrdQualityGates off, a lane runs only its repo's checks.
    expect(
      storyQualityGates("children", scoped, web, coding({ runPrdQualityGates: false })),
    ).toEqual(["pnpm build:web"]);
    // The describe-pr and request jobs of a lane report the same gates.
    const describe = buildDescribePrPayload({
      coding: coding(),
      run: run(),
      lane,
      repository: web,
      connection,
      epic: scoped,
      rows: [],
    });
    expect(describe.qualityGates).toEqual([
      "pnpm build:web",
      "pnpm test",
      "pnpm lint",
      "pnpm build",
    ]);
    const request = buildRequestPayload({
      coding: coding(),
      run: run(),
      lane: { ...lane, prUrl: null },
      repository: web,
      connection,
      epic: scoped,
      stories: [story],
      requests: [{ id: randomUUID(), text: "push it" }],
      resumeSessionId: null,
    });
    expect(request.qualityGates).toEqual([
      "pnpm build:web",
      "pnpm test",
      "pnpm lint",
      "pnpm build",
    ]);
  });

  it("say whether a request comes from the tracker or a chat thread", () => {
    const request = (origin: RalphRun["origin"]) =>
      buildRequestPayload({
        coding: coding(),
        run: { ...run("single"), origin },
        lane: { ...lane, prUrl: null },
        repository: repository(),
        connection,
        epic: epic("single"),
        stories: [],
        requests: [{ id: randomUUID(), text: "fix the typo" }],
        resumeSessionId: null,
      });
    expect(request("tracker").source).toBe("tracker");
    expect(request("tracker").trackerProvider).toBe("linear");
    // Prompts name the tracker by this (`tracker.name`).
    expect(request("tracker").trackerName).toBe("Linear");
    expect(request("chat").source).toBe("chat");
  });
});

describe("job settings", () => {
  it("carry the playbook's model and worktree setup command and the repository's instructions", () => {
    expect(
      payloadFor(
        "children",
        { model: "sonnet", fallbackModel: "haiku", worktreeSetupCommand: "pnpm install" },
        { codingInstructions: "Write a changelog entry." },
      ).settings,
    ).toEqual({
      model: "sonnet",
      fallbackModel: "haiku",
      appendInstruction: "Write a changelog entry.",
      allowedTools: null,
      disallowedTools: null,
      setupCommand: "pnpm install",
    });
  });

  it("are the built-in playbook's for a repository without instructions", () => {
    expect(jobSettings(repository({ codingInstructions: "  " }), coding())).toEqual({
      model: "opus",
      setupCommand: null,
      fallbackModel: null,
      appendInstruction: null,
      allowedTools: null,
      disallowedTools: null,
    });
  });
});

describe("the tracker's name", () => {
  it("is filled from a Linear run's provider for the story prompt (`tracker.name`)", () => {
    const payload = payloadFor("children", {});
    expect(payload.trackerProvider).toBe("linear");
    expect(payload.trackerName).toBe("Linear");
  });
});
