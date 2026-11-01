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
    ...policy,
  }) as Repository;

const connection = { baseUrl: "https://api.github.com" } as ScmConnection;

const run = (kind: RalphRun["kind"] = "children") =>
  ({
    id: randomUUID(),
    kind,
    origin: "tracker",
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
    expect(storyQualityGates("single", epic(), repository(), coding())).toEqual([]);
  });

  it("are what the describe-pr job reports as the verification", () => {
    const payload = buildDescribePrPayload({
      coding: coding({ verifyCommands: ["pnpm typecheck"] }),
      run: run(),
      lane,
      repository: repository(),
      connection,
      epic: epic(),
      rows: [],
    });
    expect(payload.qualityGates).toEqual(["pnpm typecheck", "pnpm test", "pnpm lint"]);
  });

  it("are a request's gates too, from the request playbook, with the repository's instructions and history rule", () => {
    const request = (kind: RalphRun["kind"]) =>
      buildRequestPayload({
        coding: coding({ verifyCommands: ["pnpm typecheck"] }),
        run: run(kind),
        lane: { ...lane, prUrl: null },
        repository: repository({ codingInstructions: "Be brief.", historyRewrite: "never" }),
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

  it("add the PRD's gates for the lane's repository, never another repository's", () => {
    const scoped: Epic = {
      ...epic(),
      repositoryQualityGates: {
        "acme/api": ["cargo test", "pnpm test"],
        "acme/web": ["pnpm build"],
      },
    };
    const api = { ...repository(), fullPath: "Acme/API" };
    const web = { ...repository(), fullPath: "acme/web" };
    const other = { ...repository(), fullPath: "acme/docs" };
    const storyPayload = (repo: Repository, settings: Partial<CodingSettings> = {}) =>
      buildStoryPayload({
        coding: coding(settings),
        run: run(),
        lane,
        repository: repo,
        connection,
        epic: scoped,
        stories: [story],
        story,
        row: row as RalphStory,
      });

    expect(storyPayload(api, { verifyCommands: ["pnpm typecheck"] })).toMatchObject({
      qualityGates: ["pnpm typecheck", "pnpm test", "pnpm lint", "cargo test"],
      prdQualityGates: ["pnpm test", "pnpm lint", "cargo test"],
    });
    expect(storyPayload(web)).toMatchObject({
      qualityGates: ["pnpm test", "pnpm lint", "pnpm build"],
      prdQualityGates: ["pnpm test", "pnpm lint", "pnpm build"],
    });
    expect(storyPayload(other).qualityGates).toEqual(["pnpm test", "pnpm lint"]);
    // With runPrdQualityGates off, a lane runs only its verify commands.
    expect(
      storyQualityGates("children", scoped, web, coding({ runPrdQualityGates: false })),
    ).toEqual([]);
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
    expect(describe.qualityGates).toEqual(["pnpm test", "pnpm lint", "pnpm build"]);
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
    expect(request.qualityGates).toEqual(["pnpm test", "pnpm lint", "pnpm build"]);
  });

  it("say whether a request comes from Linear or a chat thread", () => {
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
    expect(request("tracker").source).toBe("linear");
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
