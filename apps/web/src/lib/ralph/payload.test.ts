import { randomUUID } from "node:crypto";
import { type RalphRun, type RalphStory, type Repository, type ScmConnection } from "@omniralph/db";
import { childrenEpic, type Epic, type EpicIssue, type Story } from "@omniralph/ralph";
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

  it("are only the repo's checks for a new-format epic, and its legacy PRD's gates otherwise", () => {
    const issueOf = (id: string, description: string): EpicIssue => ({
      id,
      identifier: id.toUpperCase(),
      title: id,
      description,
      branchName: "feat/epic",
      stateType: "unstarted",
      labels: [],
    });
    const fix = issueOf(
      "issue-2",
      "## Current behavior\n\nCrashes.\n\n## Expected behavior\n\nNo crash.\n\n## Unchanged behavior\n\nThe rest.\n\n## Acceptance Criteria\n\n- [ ] No crash",
    );
    const payloadOf = (description: string) => {
      const built = childrenEpic(issueOf("issue-1", description), [{ issue: fix, blockers: [] }]);
      const fixStory = built.stories[0]!;
      return buildStoryPayload({
        coding: coding(),
        run: run("children"),
        lane,
        repository: repository({ checks: ["pnpm check"] }),
        connection,
        epic: built,
        stories: built.stories,
        story: fixStory,
        row: row as RalphStory,
      });
    };

    const fresh = payloadOf(
      "## Problem\n\nCrashes.\n\n## Scope\n\n### In\n\n- Stop it\n\n### Out\n\n- Nothing\n\n## Requirements\n\n- FR-1: The system must not crash.\n\n## Quality Gates\n\n- `pnpm lint`",
    );
    expect(fresh.qualityGates).toEqual(["pnpm check"]);
    expect(fresh.prdQualityGates).toEqual([]);
    // A fix-format body is a fix even without a fix label.
    expect(fresh.story.kind).toBe("fix");

    const legacy = payloadOf("Build it.\n\n## Quality Gates\n\n- `pnpm lint`");
    expect(legacy.qualityGates).toEqual(["pnpm check", "pnpm lint"]);
    expect(legacy.prdQualityGates).toEqual(["pnpm lint"]);
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

describe("the story's kind", () => {
  const kindOf = (
    kind: RalphRun["kind"],
    labels: string[] | undefined,
    fixLabels?: readonly string[],
  ) => {
    const labelled: Story = { ...story, ...(labels && { labels }) };
    return buildStoryPayload({
      coding: coding(),
      run: run(kind),
      lane,
      repository: repository(),
      connection,
      epic: { ...epic(kind === "single" ? "single" : "children"), stories: [labelled] },
      stories: [labelled],
      story: labelled,
      row: row as RalphStory,
      ...(fixLabels && { fixLabels }),
    }).story.kind;
  };

  it("is a Fix with the default fix label, Bug, and a Story without it", () => {
    expect(kindOf("children", ["frontend", "bug"])).toBe("fix");
    expect(kindOf("children", ["Enhancement"])).toBe("story");
    expect(kindOf("children", undefined)).toBe("story");
  });

  it("follows the integration's custom fix labels, for a story and a single issue", () => {
    expect(kindOf("children", ["Defect"], ["Defect", "Regression"])).toBe("fix");
    expect(kindOf("single", ["regression"], ["Defect", "Regression"])).toBe("fix");
    expect(kindOf("single", ["Bug"], ["Defect"])).toBe("story");
  });
});
