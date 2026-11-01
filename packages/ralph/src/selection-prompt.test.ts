import { describe, expect, it } from "vitest";
import {
  appendProgress,
  extractCodebasePatterns,
  initialProgress,
  progressAddition,
  recentProgressEntries,
} from "./progress.js";
import {
  PR_DESCRIPTION_SCHEMA,
  isWaitingRequest,
  isWaitingStory,
  STORY_OUTPUT_SCHEMA,
  StoryAgentOutput,
  readPullRequestDescription,
  readStoryOutcome,
} from "./output.js";
import {
  buildDescribePrPrompt,
  buildRequestPrompt,
  buildStoryPrompt,
  GOOD_NEIGHBOR_RULE,
  RALPH_SYSTEM_APPEND,
  renderTemplate,
  requestSystemAppend,
  storyTemplateContext,
  uniqueCommands,
} from "./prompt.js";
import { blockedStories, isEpicComplete, selectNextStory } from "./selection.js";
import type { Epic, Story } from "./types.js";

const story = (key: string, over: Partial<Story> = {}): Story => ({
  key,
  storyId: key,
  title: `Story ${key}`,
  description: "",
  acceptanceCriteria: [],
  priority: 3,
  dependsOn: [],
  status: "open",
  ...over,
});

describe("selectNextStory", () => {
  it("respects dependencies and priority", () => {
    const stories = [
      story("US-001", { priority: 2 }),
      story("US-002", { priority: 1, dependsOn: ["US-001"] }),
      story("US-003", { priority: 3 }),
    ];
    expect(selectNextStory(stories)?.key).toBe("US-001");
    stories[0]!.status = "completed";
    expect(selectNextStory(stories)?.key).toBe("US-002");
  });

  it("prefers in-progress work and honours exclusions", () => {
    const stories = [
      story("US-001", { priority: 1 }),
      story("US-002", { priority: 5, status: "in_progress" }),
    ];
    expect(selectNextStory(stories)?.key).toBe("US-002");
    expect(selectNextStory(stories, new Set(["US-002"]))?.key).toBe("US-001");
  });

  it("breaks priority ties by Linear sub-issue order before the id", () => {
    const stories = [
      story("ENG-2", { sortOrder: 3 }),
      story("ENG-3", { sortOrder: -1 }),
      story("ENG-4"),
      story("ENG-5", { priority: 2 }),
    ];
    expect(selectNextStory(stories)?.key).toBe("ENG-5");
    stories[3]!.status = "completed";
    expect(selectNextStory(stories)?.key).toBe("ENG-3");
    stories[1]!.status = "completed";
    expect(selectNextStory(stories)?.key).toBe("ENG-2");
  });

  it("treats external blockers as unsatisfied", () => {
    expect(selectNextStory([story("A", { dependsOn: ["external:ENG-9"] })])).toBeUndefined();
  });

  it("never selects manual stories, and their dependents wait for them", () => {
    const stories = [
      story("US-001", { priority: 1, manual: true }),
      story("US-002", { priority: 1, dependsOn: ["US-001"] }),
      story("US-003", { priority: 5 }),
    ];
    expect(selectNextStory(stories)?.key).toBe("US-003");
    stories[2]!.status = "completed";
    expect(selectNextStory(stories)).toBeUndefined();
    stories[0]!.status = "completed";
    expect(selectNextStory(stories)?.key).toBe("US-002");
  });

  it("ranks Linear's no priority (0) last", () => {
    expect(
      selectNextStory([
        story("A", { priority: 0, sortOrder: 0 }),
        story("B", { priority: 4, sortOrder: 1 }),
      ])?.key,
    ).toBe("B");
  });

  it("skips exhausted stories, and dependents of exhausted stories are blocked", () => {
    const stories = [
      story("A", { priority: 1, exhausted: true }),
      story("B", { dependsOn: ["A"] }),
      story("C", { priority: 4 }),
    ];
    expect(selectNextStory(stories)?.key).toBe("C");
    expect(blockedStories(stories, new Set()).map((s) => s.key)).toEqual(["B"]);
  });

  it("orders story ids naturally", () => {
    expect(selectNextStory([story("US-010"), story("US-002")])?.key).toBe("US-002");
  });

  it("finds transitively blocked stories", () => {
    const stories = [
      story("A"),
      story("B", { dependsOn: ["A"] }),
      story("C", { dependsOn: ["B"] }),
      story("D"),
    ];
    expect(blockedStories(stories, new Set(["A"])).map((s) => s.key)).toEqual(["B", "C"]);
    expect(isEpicComplete(stories)).toBe(false);
  });
});

describe("prompt", () => {
  const epic: Epic = {
    kind: "children",
    issueId: "e",
    identifier: "ENG-1",
    title: "Task Priority",
    description: "The PRD body",
    branchName: "ralph/x",
    qualityGates: ["pnpm lint"],
    stories: [
      story("US-001", { status: "completed" }),
      story("US-002", { dependsOn: ["US-001"], acceptanceCriteria: ["badge shows"] }),
    ],
  };

  it("renders the full story prompt", () => {
    const p = buildStoryPrompt({
      trackerName: "Linear",
      epic,
      story: epic.stories[1]!,
      progressFile: "/tmp/p.md",
      guidance: ["use tailwind"],
      previousAttemptFeedback: "lint failed",
      attempt: 2,
      maxAttempts: 3,
    });
    expect(p).toContain("## Your Task: US-002 - Story US-002");
    expect(p).toContain("1/2 stories complete");
    expect(p).toContain("- [x] US-001");
    expect(p).toContain("(depends on US-001)  <- current");
    expect(p).toContain("- [ ] badge shows");
    expect(p).toContain("- `pnpm lint`");
    expect(p).toContain("- use tailwind");
    expect(p).toContain("lint failed");
    expect(p).toContain("<prd-document>\nThe PRD body");
    expect(p).not.toMatch(/\{\{/);
  });

  it("feeds the progress log's patterns and tail into the prompt", () => {
    const progress = `# Ralph Progress Log\n\n## Codebase Patterns (Study These First)\n- Use zod\n\n---\n\n${Array.from({ length: 7 }, (_, i) => `## [2026-01-0${i + 1}] - US-00${i}: S${i}\n- did ${i}\n---\n`).join("\n")}`;
    const p = buildStoryPrompt({
      trackerName: "Linear",
      epic,
      story: epic.stories[1]!,
      progressFile: "/tmp/p.md",
      progress,
      attempt: 1,
      maxAttempts: 3,
      now: new Date("2026-10-06T12:00:00Z"),
    });
    expect(p).toContain("## Codebase Patterns (Study These First)\n- Use zod");
    expect(p).toContain("## Recent Progress");
    expect(p).toContain("- did 6");
    expect(p).not.toContain("- did 1");
    expect(p).toContain("## [2026-10-06] - US-002: Story US-002");
  });

  it("shows no PRD document for a single issue", () => {
    const single: Epic = { ...epic, kind: "single", stories: [story("ENG-1")] };
    const p = buildStoryPrompt({
      trackerName: "Linear",
      epic: single,
      story: single.stories[0]!,
      progressFile: "/tmp/p.md",
      attempt: 1,
      maxAttempts: 3,
    });
    expect(p).not.toContain("<prd-document>");
    expect(p).not.toContain("## Previous Attempt");
    expect(p).not.toContain("## Guidance");
  });

  it("leaves quality gates the orchestrator runs to the orchestrator", () => {
    const gated: Epic = {
      ...epic,
      qualityGates: ["pnpm lint", "pnpm  test", "pnpm typecheck", "pnpm lint"],
    };
    const p = buildStoryPrompt({
      trackerName: "Linear",
      epic: gated,
      story: gated.stories[1]!,
      progressFile: "/tmp/p.md",
      attempt: 1,
      maxAttempts: 3,
      checks: ["pnpm test", "pnpm build", "pnpm build"],
    });
    const [gates = "", checked = ""] = p.split("### Checked by the Orchestrator");
    expect(gates).toContain("- `pnpm lint`\n- `pnpm typecheck`\n\n");
    expect(gates).not.toContain("pnpm  test");
    expect(checked).toContain("- `pnpm test`\n- `pnpm build`\n\n");
    expect(p.match(/`pnpm lint`/g)).toHaveLength(1);

    const all = buildStoryPrompt({
      trackerName: "Linear",
      epic: gated,
      story: gated.stories[1]!,
      progressFile: "/tmp/p.md",
      attempt: 1,
      maxAttempts: 3,
      checks: ["pnpm lint", "pnpm test", "pnpm typecheck"],
    });
    expect(all).not.toContain("### Quality Gates");
    expect(all).toContain("### Checked by the Orchestrator");

    // Without checks the section is left out, and the PRD's gates are the agent's to run.
    const none = buildStoryPrompt({
      trackerName: "Linear",
      epic: gated,
      story: gated.stories[1]!,
      progressFile: "/tmp/p.md",
      attempt: 1,
      maxAttempts: 3,
      checks: [],
    });
    expect(none).not.toContain("### Checked by the Orchestrator");
    expect(none).toContain("### Quality Gates");
  });

  it("says whether the story is a Fix or a Story, under its issue line", () => {
    const prompt = (kind: Story["kind"]) => {
      const task = { ...epic.stories[1]!, identifier: "ENG-2", ...(kind && { kind }) };
      const ctx = {
        trackerName: "Linear",
        epic,
        story: task,
        progressFile: "/tmp/p.md",
        attempt: 1,
        maxAttempts: 3,
      };
      expect(storyTemplateContext(ctx).story.kind).toBe(kind === "fix" ? "Fix" : "Story");
      return buildStoryPrompt(ctx);
    };
    expect(prompt("fix")).toMatch(/\nLinear issue: [^\n]+\nKind: Fix\n/);
    expect(prompt("story")).toMatch(/\nLinear issue: [^\n]+\nKind: Story\n/);
    // A story without a kind (one of a PRD) is new work.
    expect(prompt(undefined)).toContain("\nKind: Story\n");
    expect(prompt("fix")).not.toContain("Kind: Story");
  });

  describe("a planning-format epic", () => {
    const planning: Epic = {
      ...epic,
      description:
        "## Problem\nSlow reviews.\n\n## Requirements\n- FR-1: The system must badge tasks.",
      qualityGates: [],
      requirements: [
        { id: "FR-1", text: "The system must badge tasks." },
        { id: "FR-2", text: "The system must sort by priority." },
      ],
    };
    const build = (over: Partial<Story>, e: Epic = planning) =>
      buildStoryPrompt({
        trackerName: "Linear",
        epic: e,
        story: { ...epic.stories[1]!, ...over },
        progressFile: "/tmp/p.md",
        attempt: 1,
        maxAttempts: 3,
      });

    it("shows the epic as context, not as a PRD", () => {
      const p = build({});
      expect(p).toContain("## Epic: Task Priority (ENG-1)");
      expect(p).toMatch(
        /### Epic Context \(background, not your task\)\n.+\n\n<epic-context>\n## Problem/,
      );
      expect(p).not.toContain("<prd-document>");
      expect(p).not.toContain("## PRD:");
      // A legacy PRD keeps its framing.
      const legacy = build({}, epic);
      expect(legacy).toContain("## PRD: Task Priority (ENG-1)");
      expect(legacy).toContain("<prd-document>\nThe PRD body");
      expect(legacy).not.toContain("<epic-context>");
    });

    it("lists the covered requirements with the epic's text, flagging unknown ones", () => {
      const p = build({ covers: ["FR-2", "FR-7", "the badge"] });
      expect(p).toContain(
        "- FR-2: The system must sort by priority.\n- FR-7: (not among the epic's requirements)\n\n### Acceptance Criteria",
      );
      expect(p).not.toContain("the badge");
      expect(build({})).not.toContain("### Requirements This Task Covers");
    });

    it("frames a Fix by its behavior sections, apart from the rest of its description", () => {
      const p = build({
        kind: "fix",
        description:
          "Seen on Safari.\n\n## Current behavior\nBadges vanish.\n\n## Unchanged behavior\nSorting stays.",
      });
      expect(p).toContain("Kind: Fix\n\nThis task is a Fix:");
      expect(p).toContain(
        "### Description\nSeen on Safari.\n\n### Current behavior\nBadges vanish.",
      );
      expect(p).toContain("### Unchanged behavior\nSorting stays.");
      expect(p).not.toContain("### Expected behavior");
      expect(p).toContain("regression test only where the affected code already has tests");
      // A Story's own `##` sections stay in its description.
      const story = build({ description: "Lead.\n\n## Current behavior\nKept." });
      expect(story).toContain("### Description\nLead.\n\n## Current behavior\nKept.");
      expect(story).not.toContain("This task is a Fix");
    });
  });

  it("says criteria are evidence to check, not tests to write", () => {
    const p = buildStoryPrompt({
      trackerName: "Linear",
      epic,
      story: epic.stories[1]!,
      progressFile: "/tmp/p.md",
      attempt: 1,
      maxAttempts: 3,
    });
    const [, criteria = ""] = p.split("### Acceptance Criteria\n");
    expect(criteria).toMatch(
      /^Your task is done when every criterion below holds\. A criterion is evidence to check, not a test to write/,
    );
    expect(criteria).toContain("- [ ] badge shows");
  });

  it("drops duplicate commands, ignoring whitespace", () => {
    expect(uniqueCommands([" pnpm test", "pnpm  test", "", "pnpm lint", "pnpm test"])).toEqual([
      "pnpm test",
      "pnpm lint",
    ]);
  });

  it("supports nested if/else in custom templates", () => {
    expect(
      renderTemplate("{{#if a}}A{{#if b}}B{{/if}}{{else}}none{{/if}}", { a: "1", b: "" }),
    ).toBe("A");
    expect(renderTemplate("{{#if a}}A{{else}}none{{/if}}", {})).toBe("none");
  });

  it("asks for a structured result instead of signals in the text", () => {
    const p = buildStoryPrompt({
      trackerName: "Linear",
      epic,
      story: epic.stories[1]!,
      progressFile: "/tmp/p.md",
      attempt: 1,
      maxAttempts: 3,
      followUps: true,
    });
    expect(p).not.toMatch(/<promise>|<follow-up/);
    expect(p).toContain('`status: "blocked"`');
    expect(p).toContain("`commit: { summary }`");
    expect(p).toContain("Add one entry per item to `followUps`");
    expect(
      buildStoryPrompt({
        trackerName: "Linear",
        epic,
        story: epic.stories[1]!,
        progressFile: "/tmp/p.md",
        attempt: 1,
        maxAttempts: 3,
      }),
    ).toContain("Leave `followUps` empty.");
  });

  it("lists stash entries to review only when there are some", () => {
    const base = {
      trackerName: "Linear",
      epic,
      story: epic.stories[1]!,
      progressFile: "/tmp/p.md",
      attempt: 2,
      maxAttempts: 3,
    };
    expect(buildStoryPrompt(base)).not.toContain("## Stashed Work");
    const p = buildStoryPrompt({
      ...base,
      stashes: [
        { sha: "a".repeat(40), label: "cyralph: E-1 US-002 blocked", date: "2026-10-05T10:00:00Z" },
      ],
    });
    expect(p).toContain("## Stashed Work From Earlier Sessions");
    expect(p).toContain(
      `- \`${"a".repeat(40)}\` cyralph: E-1 US-002 blocked (2026-10-05T10:00:00Z)`,
    );
    expect(p).toContain("`git stash show -p --include-untracked <sha>`");
    expect(p).toContain("`git stash apply <sha>`");
    expect(p).toContain("`appliedStashes`");
  });

  it("tells story and request sessions to share the machine's resources", () => {
    expect(GOOD_NEIGHBOR_RULE).toContain("never assume what resources are available");
    expect(GOOD_NEIGHBOR_RULE).toContain("saturating all cores");
    expect(GOOD_NEIGHBOR_RULE).toContain("running several instances of a test suite");
    expect(RALPH_SYSTEM_APPEND).toContain(GOOD_NEIGHBOR_RULE);
    expect(requestSystemAppend("when-asked")).toContain(GOOD_NEIGHBOR_RULE);
    expect(requestSystemAppend("never")).toContain(GOOD_NEIGHBOR_RULE);
    expect(requestSystemAppend("always")).toContain(GOOD_NEIGHBOR_RULE);
  });

  it("rebases and force-pushes with lease without being asked, never merging, under `always`", () => {
    const system = requestSystemAppend("always");
    expect(system).toContain("History rewrites are allowed on the epic branch without being asked");
    expect(system).toContain("never merge the base branch");
    expect(system).toContain("`git push --force-with-lease`");
    expect(system).not.toContain("Don't rewrite history on your own initiative");
  });
});

describe("request prompt", () => {
  const base = {
    trackerName: "Linear",
    requests: ["fix the typo in the README"],
    branch: "omniralph/x",
    baseBranch: "main",
    remoteUrl: "https://github.com/acme/app.git",
    progressFile: "/tmp/progress.md",
    qualityGates: ["pnpm test"],
  };
  const linearEpic: Epic = {
    kind: "children",
    issueId: "e",
    identifier: "ENG-1",
    title: "Task Priority",
    description: "The PRD body",
    branchName: "omniralph/x",
    qualityGates: [],
    stories: [story("US-001", { status: "completed" }), story("US-002")],
  };
  // What a chat run's request jobs get in place of a Linear issue (`chatRequestEpic`).
  const chatEpic: Epic = {
    kind: "single",
    issueId: "run",
    identifier: "chat-1a2b3c4d",
    title: "fix the typo in the README",
    description: "",
    branchName: "omniralph/chat-1a2b3c4d",
    qualityGates: [],
    stories: [],
  };

  it("is about the Linear issue and its stories by default", () => {
    const p = buildRequestPrompt({ ...base, epic: linearEpic });
    expect(buildRequestPrompt({ ...base, epic: linearEpic, source: "tracker" })).toBe(p);
    expect(p).toContain("You are working on Linear ENG-1: Task Priority.");
    expect(p).toContain("## Status: 1/2 stories complete");
    expect(p).toContain("<prd-document>\nThe PRD body\n</prd-document>");
    expect(p).toContain("reviewers who can't see Linear");
    expect(p).toContain("judgement calls. Don't list the user stories.");
    expect(p).toContain("Finish with a short summary for the thread on Linear");
  });

  it("names neither Linear nor a story status for a request from chat", () => {
    const p = buildRequestPrompt({ ...base, epic: chatEpic, source: "chat" });
    expect(p).toContain(
      "You are working on a request from a chat thread: fix the typo in the README.",
    );
    expect(p).toContain("on branch `omniralph/x` (base `main`)");
    expect(p).toContain("## Request from your team\n> fix the typo in the README");
    expect(p).toContain("reviewers who can't see the chat thread");
    expect(p).toContain("Finish with a short summary for the chat thread");
    expect(p).not.toContain("Linear");
    expect(p).not.toContain("Status");
    expect(p).not.toContain("stories");
    expect(p).not.toContain("chat-1a2b3c4d");
  });

  it("rebases onto the base branch instead of merging it under `always`", () => {
    const p = buildRequestPrompt({ ...base, epic: chatEpic, historyRewrite: "always" });
    expect(p).toContain(
      "History rewrites are allowed on `omniralph/x` without being asked, and merges are not: never merge `main`",
    );
    expect(p).toContain("`git fetch origin && git rebase origin/main`");
    expect(p).toContain("`git push --force-with-lease origin omniralph/x`");
    expect(p).not.toContain("when the request asks for one");
  });

  it("has a system prompt for each source", () => {
    expect(requestSystemAppend("when-asked", "tracker")).toBe(requestSystemAppend("when-asked"));
    const linear = requestSystemAppend("when-asked", "tracker", { trackerName: "Linear" });
    expect(linear).toContain("a request in a thread on Linear about a PRD epic");
    expect(linear).toContain("posted to the thread on Linear");
    expect(requestSystemAppend()).toContain("posted to the thread on the tracker");
    const chat = requestSystemAppend("never", "chat");
    expect(chat).toContain("a request in a chat thread about a repository");
    expect(chat).toContain("posted to the chat thread");
    expect(chat).not.toContain("Linear");
  });
});

describe("PR/MR description", () => {
  it("asks for the deliverable from the diff, with the issue as background only", () => {
    const epic: Epic = {
      kind: "children",
      issueId: "e",
      identifier: "ENG-1",
      title: "Task Priority",
      description: "The PRD body",
      branchName: "b",
      qualityGates: [],
      stories: [story("US-001")],
    };
    const p = buildDescribePrPrompt({
      epic,
      branch: "b",
      baseBranch: "main",
      prTerm: "merge request",
      progressFile: "/tmp/p.md",
    });
    expect(p).toContain("ready for a merge request into `main`");
    expect(p).toContain("<issue-background>\nThe PRD body\n</issue-background>");
    expect(p).toContain("git diff origin/main...HEAD");
    expect(p).toContain("**Breaking changes**");
    expect(p).toContain("**Decisions**");
    expect(p).toContain("- US-001: ");
    expect(p).toContain("**Stories**");
    expect(p).toContain("**Verification**");
    expect(p).toContain("at most 72 characters");
    expect(p).toContain("`/tmp/p.md`");
  });

  it("quotes the progress log, the stories with their commits and the quality gates", () => {
    const p = buildDescribePrPrompt({
      epic: {
        kind: "children",
        issueId: "e",
        identifier: "ENG-1",
        title: "Task Priority",
        description: "",
        branchName: "b",
        qualityGates: ["pnpm test", " pnpm  test", "pnpm lint"],
        stories: [],
      },
      branch: "b",
      baseBranch: "main",
      prTerm: "pull request",
      progress: "## [2026-10-06] - ENG-2: Store\nUsed a jsonb column.",
      stories: [{ identifier: "ENG-2", title: "Store", commitSha: "0123456789abcdef" }],
    });
    expect(p).toContain("- ENG-2: Store (`0123456789`)");
    expect(p).toContain(
      "<progress-log>\n## [2026-10-06] - ENG-2: Store\nUsed a jsonb column.\n</progress-log>",
    );
    expect(p).toContain("- `pnpm test`\n- `pnpm lint`\n");
    expect(p).not.toContain("<issue-background>");
  });

  it("reads the title and description from the structured result", () => {
    expect(
      readPullRequestDescription({
        title: '\n "Add task  priorities" ',
        body: "\n## Summary\nAdds priorities.\n",
      }),
    ).toEqual({
      title: "Add task priorities",
      body: "## Summary\nAdds priorities.",
    });
    expect(readPullRequestDescription({ title: "t" })).toBeUndefined();
    expect(readPullRequestDescription({ title: " ", body: "b" })).toBeUndefined();
    expect(readPullRequestDescription(undefined)).toBeUndefined();
    expect(PR_DESCRIPTION_SCHEMA).toMatchObject({ type: "object", required: ["title", "body"] });
  });
});

describe("progress log", () => {
  const log = `# Ralph Progress Log

## Codebase Patterns (Study These First)
- Use zod for all config

---

## [2026-01-01] - US-001: DB
- did it
---

## [2026-01-02] - US-002: UI
- did that
---
`;
  it("extracts patterns and recent entries", () => {
    expect(extractCodebasePatterns(log)).toBe("- Use zod for all config");
    const recent = recentProgressEntries(log, 1);
    expect(recent).toContain("US-002");
    expect(recent).not.toContain("US-001");
  });

  it("starts and appends to a log", () => {
    const start = initialProgress("ENG-1: Epic");
    expect(start).toContain("## Codebase Patterns");
    expect(start).toContain("Epic: ENG-1: Epic");
    expect(extractCodebasePatterns(start)).toBeUndefined();
    const next = appendProgress(start, "\n## [2026-10-06] - US-001: DB\n- did it\n---\n\n");
    expect(next).toBe(`${start}\n## [2026-10-06] - US-001: DB\n- did it\n---\n`);
    expect(appendProgress(next, "  \n")).toBe(next);
    expect(recentProgressEntries(next)).toContain("US-001: DB");
  });

  it("finds what a session added to the log", () => {
    expect(progressAddition(log, `${log}\n## [2026-01-03] - US-003: API\n`)).toBe(
      "## [2026-01-03] - US-003: API",
    );
    expect(progressAddition(log, log)).toBeUndefined();
    expect(progressAddition(log, "rewritten")).toBe("rewritten");
  });
});

describe("structured results", () => {
  it("publishes JSON schemas for every kind of session", () => {
    expect(STORY_OUTPUT_SCHEMA).toMatchObject({
      type: "object",
      required: ["status", "summary", "followUps"],
    });
    expect(
      (STORY_OUTPUT_SCHEMA.properties as Record<string, { enum?: string[] }>).status?.enum,
    ).toEqual(["complete", "blocked", "incomplete", "waiting"]);
    expect(STORY_OUTPUT_SCHEMA).not.toHaveProperty("$schema");
  });

  it("tells a result that waits for background work apart", () => {
    expect(isWaitingStory({ status: "waiting", summary: "", followUps: [] })).toBe(true);
    expect(isWaitingStory({ status: "incomplete" })).toBe(false);
    expect(isWaitingStory(undefined)).toBe(false);
    expect(isWaitingStory(null)).toBe(false);
    expect(isWaitingRequest({ summary: "", waiting: true })).toBe(true);
    expect(isWaitingRequest({ summary: "" })).toBe(false);
    expect(isWaitingRequest(undefined)).toBe(false);
  });

  it("reads follow-ups, drops repeats by title, and caps the count", () => {
    const read = readStoryOutcome({
      status: "incomplete",
      summary: "Found things.",
      followUps: [
        { title: "Fix A", description: "A is broken.\n- [ ] A works\n", manual: false },
        { title: "fix a", description: "dup", manual: false },
        { title: " Fix B ", description: "B", manual: false },
        { title: " ", description: "no title", manual: false },
        { title: "Grant access", description: "Add the bot to the org.", manual: true },
        {
          title: "Drop the shim",
          description: "Remove it.",
          manual: false,
          after: "epic",
          reason: " The shim stays until this epic ships. ",
        },
        { title: "Tidy up", description: "Later.", manual: false, after: "epic", reason: " " },
      ],
    });
    expect(read).toEqual({
      outcome: {
        status: "incomplete",
        summary: "Found things.",
        followUps: [
          { title: "Fix A", description: "A is broken.\n- [ ] A works" },
          { title: "Fix B", description: "B" },
          { title: "Grant access", description: "Add the bot to the org.", manual: true },
          {
            title: "Drop the shim",
            description: "Remove it.",
            after: "epic",
            reason: "The shim stays until this epic ships.",
          },
          { title: "Tidy up", description: "Later.", after: "epic" },
        ],
      },
    });
    const many = readStoryOutcome({
      status: "complete",
      summary: "",
      followUps: Array.from({ length: 15 }, (_, i) => ({
        title: `T${i}`,
        description: "x",
        manual: false,
      })),
    });
    expect("outcome" in many && many.outcome.followUps).toHaveLength(10);
  });

  it("reads recommendations, drops repeats by title, and caps the count", () => {
    const read = readStoryOutcome({
      status: "complete",
      summary: "Done.",
      followUps: [],
      recommendations: [
        { title: " Fix the  parser upstream ", description: "In acme/lib: drop our shim.\n" },
        { title: "fix the parser upstream", description: "dup" },
        { title: " ", description: "no title" },
      ],
    });
    expect(read).toEqual({
      outcome: {
        status: "complete",
        summary: "Done.",
        followUps: [],
        recommendations: [
          { title: "Fix the parser upstream", description: "In acme/lib: drop our shim." },
        ],
      },
    });
    const many = readStoryOutcome({
      status: "complete",
      summary: "",
      followUps: [],
      recommendations: Array.from({ length: 15 }, (_, i) => ({ title: `R${i}`, description: "x" })),
    });
    expect("outcome" in many && many.outcome.recommendations).toHaveLength(10);
    const none = readStoryOutcome({ status: "complete", summary: "", followUps: [] });
    expect("outcome" in none && none.outcome.recommendations).toBeUndefined();
  });

  it("keeps a blocked result's commit and applied stashes", () => {
    const read = readStoryOutcome({
      status: "blocked",
      summary: "No creds.",
      commit: { summary: " Add the  migration " },
      appliedStashes: ["abc1234"],
      followUps: [],
    });
    expect(read).toEqual({
      outcome: {
        status: "blocked",
        summary: "No creds.",
        commit: { summary: "Add the migration" },
        appliedStashes: ["abc1234"],
        followUps: [],
      },
    });
  });

  it("keeps a round's metric, dropping one without a name or a finite value", () => {
    const base = { status: "blocked", summary: "Score 26.", followUps: [] };
    const metric = { name: " critique  score ", value: 26, direction: "higher", target: 34 };
    expect(readStoryOutcome({ ...base, metric })).toMatchObject({
      outcome: { metric: { name: "critique score", value: 26, direction: "higher", target: 34 } },
    });
    const unnamed = readStoryOutcome({ ...base, metric: { ...metric, name: " " } });
    expect("outcome" in unnamed && unnamed.outcome).not.toHaveProperty("metric");
    // Results of older sessions have none.
    const without = readStoryOutcome(base);
    expect("outcome" in without && without.outcome).not.toHaveProperty("metric");
    expect(readStoryOutcome({ ...base, metric: { ...metric, direction: "up" } })).toMatchObject({
      problem: expect.stringContaining("`metric.direction`"),
    });
    expect((STORY_OUTPUT_SCHEMA.properties as Record<string, unknown>).metric).toMatchObject({
      type: "object",
    });
  });

  it("says what's wrong with a missing or invalid result", () => {
    expect(readStoryOutcome(undefined)).toEqual({ problem: "no structured result" });
    expect(readStoryOutcome({ status: "done", summary: "x", followUps: [] })).toMatchObject({
      problem: expect.stringContaining("`status`"),
    });
    expect(readStoryOutcome({ status: "complete" })).toMatchObject({
      problem: expect.stringContaining("invalid structured result"),
    });
    expect(readStoryOutcome("Done.")).toMatchObject({
      problem: expect.stringContaining("invalid structured result"),
    });
    expect(
      StoryAgentOutput.safeParse({ status: "complete", summary: "x", followUps: [] }).success,
    ).toBe(true);
  });
});
