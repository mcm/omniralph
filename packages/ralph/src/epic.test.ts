import { describe, expect, it } from "vitest";
import {
  type EpicIssue,
  type StoryIssue,
  childrenEpic,
  materializationPlan,
  openRootBlockers,
  parsePrepareBlocks,
  prdEpic,
  singleIssueEpic,
  statusFromStateType,
  withManualOptions,
} from "./epic.js";
import { parsePrd } from "./prd.js";
import { sortStories } from "./selection.js";

let seq = 0;
const issue = (over: Partial<EpicIssue> = {}): EpicIssue => {
  seq += 1;
  return {
    id: `id-${seq}`,
    identifier: `ENG-${seq}`,
    title: `Issue ${seq}`,
    description: "",
    url: `https://linear.app/x/issue/ENG-${seq}`,
    branchName: `eng-${seq}`,
    teamId: "team",
    teamKey: "ENG",
    stateType: "unstarted",
    labels: [],
    priority: 0,
    ...over,
  };
};
const child = (
  over: Partial<EpicIssue> = {},
  blockers: StoryIssue["blockers"] = [],
): StoryIssue => ({ issue: issue(over), blockers });

const LEGACY_BODY = (id: string, prio: number) =>
  `## Ralph Metadata\n- **Story ID:** ${id}\n- **Ralph Priority:** ${prio}\n\n## Description\nDo ${id}\n\n## Acceptance Criteria\n- [ ] ${id} works`;

describe("childrenEpic (Linear metadata only)", () => {
  it("orders stories by Linear priority, then sub-issue order, using identifiers and plain titles", () => {
    const epic = childrenEpic(issue({ title: "Epic" }), [
      child({ title: "Low", identifier: "ENG-11", priority: 4, subIssueSortOrder: 0 }),
      child({ title: "Unprioritized", identifier: "ENG-12", priority: 0, subIssueSortOrder: 1 }),
      child({ title: "Urgent second", identifier: "ENG-13", priority: 1, subIssueSortOrder: 3 }),
      child({ title: "Urgent first", identifier: "ENG-14", priority: 1, subIssueSortOrder: 2 }),
    ]);
    expect(epic.kind).toBe("children");
    expect(sortStories(epic.stories).map((s) => `${s.storyId} ${s.title}`)).toEqual([
      "ENG-14 Urgent first",
      "ENG-13 Urgent second",
      "ENG-11 Low",
      "ENG-12 Unprioritized",
    ]);
  });

  it("still reads epics created in the ralph-tui format, without exposing its markers", () => {
    const epic = childrenEpic(issue({ title: "Old epic" }), [
      child({
        title: "US-002: Second",
        identifier: "ENG-21",
        description: LEGACY_BODY("US-002", 2),
      }),
      child({
        title: "US-001: First",
        identifier: "ENG-22",
        description: LEGACY_BODY("US-001", 1),
      }),
    ]);
    const first = epic.stories.find((s) => s.identifier === "ENG-22");
    expect(first).toMatchObject({
      storyId: "ENG-22",
      priority: 1,
      description: "Do US-001",
      acceptanceCriteria: ["US-001 works"],
    });
    expect(epic.stories.find((s) => s.identifier === "ENG-21")?.priority).toBe(2);
  });

  it("maps states, and resolves blockers inside and outside the epic", () => {
    const a = child({ stateType: "completed" });
    const b = child({ stateType: "started" }, [
      { id: a.issue.id, identifier: a.issue.identifier, stateType: "completed" },
    ]);
    const c = child({}, [
      { id: "ext-open", identifier: "OPS-9", stateType: "started" },
      { id: "ext-done", identifier: "OPS-8", stateType: "canceled" },
    ]);
    const epic = childrenEpic(issue(), [a, b, c]);
    expect(epic.stories.map((s) => s.status)).toEqual(["completed", "in_progress", "open"]);
    expect(epic.stories[1]?.dependsOn).toEqual([a.issue.id]);
    expect(epic.stories[2]?.dependsOn).toEqual(["external:ext-open"]);
    expect(epic.externalIssues).toEqual({ "ext-open": "OPS-9" });
    expect(statusFromStateType("backlog")).toBe("open");
    expect(statusFromStateType("canceled")).toBe("cancelled");
  });

  it("takes the branch from a `> Branch:` line, else Linear's, and the gates from the description", () => {
    const parent = issue({
      branchName: "linear-branch",
      description: "> Branch: feat/epic\n\n## Quality Gates\n- `pnpm test`",
    });
    const epic = childrenEpic(parent, [child()]);
    expect(epic.branchName).toBe("feat/epic");
    expect(epic.qualityGates).toEqual(["pnpm test"]);
    expect(childrenEpic(issue({ branchName: "linear-branch" }), [child()]).branchName).toBe(
      "linear-branch",
    );
    expect(epic).not.toHaveProperty("repositoryQualityGates");
  });

  it("scopes the description's gates under a repository heading to that repository", () => {
    const parent = issue({
      description: "## Quality Gates\n- `pnpm test`\n\n### `Acme/Web`\n- `pnpm build`",
    });
    const epic = childrenEpic(parent, [child()]);
    expect(epic.qualityGates).toEqual(["pnpm test"]);
    expect(epic.repositoryQualityGates).toEqual({ "acme/web": ["pnpm build"] });
  });
});

describe("preparation blocks", () => {
  const fence = "```";
  const manualStory = (description: string) => {
    const epic = childrenEpic(
      issue({ description: `Context\n\n${fence}cyralph-prepare\necho epic-level\n${fence}` }),
      [
        child({ title: "Smoke test", identifier: "ENG-41", labels: ["Manual"], description }),
        child({ title: "Agent work", identifier: "ENG-42", description }),
      ],
      { manualLabels: ["manual"] },
    );
    return {
      manual: epic.stories.find((s) => s.identifier === "ENG-41"),
      agent: epic.stories.find((s) => s.identifier === "ENG-42"),
    };
  };

  it("reads one block from a manual story, dropping blank lines", () => {
    const { manual } = manualStory(
      `## Description\nPush to staging first.\n\n${fence}cyralph-prepare\ngit fetch origin\n\n   \ngit push --force origin HEAD:staging\n${fence}\n\nThen check the site.`,
    );
    expect(manual?.manual).toBe(true);
    expect(manual?.preparation).toEqual([
      "git fetch origin",
      "git push --force origin HEAD:staging",
    ]);
  });

  it("joins every block in order and ignores other code blocks", () => {
    const { manual } = manualStory(
      `${fence}cyralph-prepare\nfirst\n${fence}\n\n${fence}sh\nnot a command\n${fence}\n\n~~~~cyralph-prepare\nsecond\n${fence}\nthird\n~~~~`,
    );
    expect(manual?.preparation).toEqual(["first", "second", fence, "third"]);
  });

  it("ignores blocks in non-manual stories and the epic description", () => {
    const { agent } = manualStory(`${fence}cyralph-prepare\nrm -rf build\n${fence}`);
    expect(agent?.manual).toBeUndefined();
    expect(agent).not.toHaveProperty("preparation");
  });

  it("ignores blocks in a single-issue epic, even one labeled manual", () => {
    const epic = singleIssueEpic(
      issue({
        labels: ["Manual"],
        stateType: "completed",
        description: `${fence}cyralph-prepare\nrm -rf build\n${fence}`,
      }),
    );
    expect(epic.kind).toBe("single");
    expect(epic.stories).toHaveLength(1);
    expect(epic.stories[0]).not.toHaveProperty("preparation");
    // The delegated issue is the work item; it is never already done.
    expect(epic.stories[0]?.status).toBe("open");
  });

  it("treats the blocks as plain text with allowPreparation off", () => {
    const description = `Deploy it.\n\n${fence}cyralph-prepare\ngit push origin HEAD:staging\n${fence}`;
    const epic = childrenEpic(
      issue(),
      [child({ title: "Deploy", identifier: "ENG-41", labels: ["manual"], description })],
      { manualLabels: ["manual"], allowPreparation: false },
    );
    expect(epic.stories[0]?.manual).toBe(true);
    expect(epic.stories[0]).not.toHaveProperty("preparation");
    expect(epic.stories[0]?.description).toContain("cyralph-prepare");
  });

  it("reads a story again with another repository's manual labels and preparation", () => {
    const description = `Deploy it.\n\n${fence}cyralph-prepare\ngit push origin HEAD:staging\n${fence}`;
    const [byHand, manual] = childrenEpic(
      issue(),
      [
        child({ title: "Deploy", identifier: "ENG-41", labels: ["By Hand"], description }),
        child({ title: "Check", identifier: "ENG-42", labels: ["manual"], description }),
      ],
      { manualLabels: ["manual"], allowPreparation: false },
    ).stories;
    expect(byHand?.manual).toBeUndefined();
    expect(manual).toMatchObject({ manual: true });
    expect(manual).not.toHaveProperty("preparation");

    const elsewhere = { manualLabels: ["by hand"], allowPreparation: true };
    expect(withManualOptions(byHand!, elsewhere)).toMatchObject({
      manual: true,
      preparation: ["git push origin HEAD:staging"],
    });
    const notManual = withManualOptions(manual!, elsewhere);
    expect(notManual).not.toHaveProperty("manual");
    expect(notManual).not.toHaveProperty("preparation");
    expect(
      withManualOptions(byHand!, { ...elsewhere, allowPreparation: false }),
    ).not.toHaveProperty("preparation");
  });

  it("leaves preparation unset for a manual story without a block", () => {
    const { manual } = manualStory(`Check the site by hand.\n\n${fence}sh\necho hi\n${fence}`);
    expect(manual?.manual).toBe(true);
    expect(manual).not.toHaveProperty("preparation");
  });
});

describe("parsePrepareBlocks", () => {
  it("returns nothing for text without blocks", () => {
    expect(parsePrepareBlocks("plain text\n```\ncode\n```")).toEqual([]);
  });

  it("runs an unclosed block to the end of the text", () => {
    expect(parsePrepareBlocks("```cyralph-prepare\r\na\r\nb")).toEqual(["a", "b"]);
  });
});

const PRD = `# PRD: Priorities

> Branch: feat/prio

## Quality Gates
- \`pnpm lint\`

## User Stories

### US-001: Store priority
**Acceptance Criteria:**
- [ ] column exists

### US-002: Show priority
**Priority:** 1
**Depends on:** US-001, US-999

**Acceptance Criteria:**
- [ ] badge shows
`;

describe("PRD epics", () => {
  it("keeps an unmaterialized PRD's stories in memory", () => {
    const prd = parsePrd(PRD)!;
    const epic = prdEpic(issue({ title: "Issue title", description: PRD }), prd);
    expect(epic).toMatchObject({
      kind: "prd",
      title: "Priorities",
      branchName: "feat/prio",
      qualityGates: ["pnpm lint"],
      description: PRD,
    });
    expect(epic.stories.map((s) => [s.key, s.status, s.dependsOn])).toEqual([
      ["US-001", "open", []],
      ["US-002", "open", ["US-001", "US-999"]],
    ]);
  });

  it("plans sub-issues with Linear priorities, order and blocks relations", () => {
    const plan = materializationPlan(parsePrd(PRD)!);
    expect(plan.issues).toEqual([
      {
        storyId: "US-001",
        title: "Store priority",
        description: "## Acceptance Criteria\n- [ ] column exists",
        priority: 3,
        subIssueSortOrder: 0,
        completed: false,
        manual: false,
      },
      {
        storyId: "US-002",
        title: "Show priority",
        description: "## Acceptance Criteria\n- [ ] badge shows",
        priority: 1,
        subIssueSortOrder: 1,
        completed: false,
        manual: false,
      },
    ]);
    expect(plan.relations).toEqual([{ blocker: "US-001", blocked: "US-002" }]);
  });

  it("plans manual PRD stories (markdown labels or prd.json) as manual", () => {
    const markdown = parsePrd(
      "# PRD: X\n\n### US-001: Grant access\n**Labels:** `manual`, ops\n\n### US-002: Build it\n**Labels:** backend\n",
    )!;
    expect(materializationPlan(markdown).issues.map((i) => [i.storyId, i.manual])).toEqual([
      ["US-001", true],
      ["US-002", false],
    ]);
    const json = parsePrd(
      JSON.stringify({
        name: "X",
        userStories: [
          { id: "US-1", title: "A", manual: true },
          { id: "US-2", title: "B", labels: ["Manual"] },
          { id: "US-3", title: "C" },
        ],
      }),
    )!;
    expect(materializationPlan(json).issues.map((i) => i.manual)).toEqual([true, true, false]);
  });
});

describe("openRootBlockers", () => {
  it("lists open blockers of the epic issue other than its own stories", () => {
    const own = child();
    const epic = childrenEpic(issue(), [own]);
    expect(
      openRootBlockers(epic, [
        { id: own.issue.id, identifier: own.issue.identifier, stateType: "started" },
        { id: "x", identifier: "OPS-1", stateType: "started" },
        { id: "y", identifier: "OPS-2", stateType: "completed" },
      ]),
    ).toEqual([{ id: "x", identifier: "OPS-1" }]);
  });
});
