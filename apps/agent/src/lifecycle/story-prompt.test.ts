/**
 * A story's acceptance criteria reach the story session's prompt. The server builds
 * `story.description` from the parsed work item, which leaves its `## Acceptance Criteria`
 * checklist out, so the payload carries the criteria in `story.acceptanceCriteria`; an
 * older server's payload has none, and the agent parses them from the description.
 */
import { randomUUID } from "node:crypto";
import { storyIssueBody } from "@omniralph/ralph";
import { RalphStoryPayload } from "@omniralph/shared";
import { getBuiltinTask } from "@omniralph/tasks";
import { describe, expect, it } from "vitest";
import { storyRunPrompt } from "./coding.js";

const storyTask = getBuiltinTask("builtin:implement-story")!;

const WORK_ITEM = [
  "## Story",
  "",
  "As a user I want to export my data.",
  "",
  "## Acceptance Criteria",
  "",
  "- [ ] The export button downloads a CSV",
  "- [ ] The CSV has one row per record",
].join("\n");

/** A story payload shaped like `buildStoryPayload`'s, with `story` over its story. */
function payload(story: Record<string, unknown>): RalphStoryPayload {
  return RalphStoryPayload.parse({
    runId: randomUUID(),
    repositoryId: randomUUID(),
    repository: {
      provider: "github",
      baseUrl: "https://api.github.com",
      fullPath: "acme/api",
      cloneUrl: "https://github.com/acme/api.git",
      defaultBranch: "main",
    },
    branch: "feat/export",
    baseBranch: "main",
    settings: {
      model: null,
      setupCommand: null,
      fallbackModel: null,
      appendInstruction: null,
      allowedTools: null,
      disallowedTools: null,
    },
    trackerProvider: "linear",
    trackerName: "Linear",
    storyId: randomUUID(),
    attempt: 1,
    epic: { identifier: "ENG-1", title: "Export", kind: "children", url: null, prd: "Export." },
    story: {
      identifier: "ENG-2",
      title: "Export to CSV",
      trackerIssueId: "issue-2",
      url: null,
      kind: "story",
      ...story,
    },
    stories: [],
    commitMessage: "feat(ENG-2): Export to CSV",
    qualityGates: ["pnpm test"],
    progress: "# Ralph Progress Log\n",
    lastFeedback: null,
    guidance: [],
  });
}

/** The prompt's `### Acceptance Criteria` section (criteria render fenced), or null without one. */
function criteriaSection(p: RalphStoryPayload): string | null {
  const text = storyRunPrompt({ task: storyTask }, p, {
    offered: [],
    progressFile: "/tmp/progress.md",
  });
  return /### Acceptance Criteria\n([\s\S]*?)\n###? /.exec(text)?.[1] ?? null;
}

describe("the story prompt's acceptance criteria", () => {
  it("are the payload's, which the work item's description no longer carries", () => {
    const body = storyIssueBody(WORK_ITEM);
    // What the server sends: the parsed description, without its criteria.
    expect(body.description).not.toContain("The export button downloads a CSV");
    const section = criteriaSection(
      payload({ description: body.description, acceptanceCriteria: body.acceptanceCriteria }),
    );
    expect(section).toContain("- [ ] ```\nThe export button downloads a CSV\n```");
    expect(section).toContain("- [ ] ```\nThe CSV has one row per record\n```");
  });

  it("are parsed from the description of an older server's payload, which has no criteria field", () => {
    const section = criteriaSection(payload({ description: WORK_ITEM }));
    expect(section).toContain("- [ ] ```\nThe export button downloads a CSV\n```");
    expect(section).toContain("- [ ] ```\nThe CSV has one row per record\n```");
  });

  it("are none for a story without any", () => {
    expect(
      criteriaSection(payload({ description: "Just do it.", acceptanceCriteria: [] })),
    ).toBeNull();
  });
});
