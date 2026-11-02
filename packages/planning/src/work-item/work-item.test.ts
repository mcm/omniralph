import { describe, expect, it } from "vitest";
import { lintWorkItem } from "./lint.js";
import { parseWorkItem, workItemFormat } from "./parse.js";

const EPIC = `## Problem

Reviewers wait a day for feedback on small changes.

## Scope

### In

- Inline review comments

### Out

- Review analytics

## Requirements

- FR-1: The system must post a review comment on each changed line it flags.
- **FR-2**: WHEN a review finishes, the system must post a summary.

## Technical notes

Reuse the review pipeline.`;

const STORY = `I want you to build inline review comments, so that reviewers see feedback on the line it applies to.

Build it by extending the review pipeline in \`packages/engine\`: post one comment per flagged line.

Don't stop until:
- [ ] A flagged line has a comment on it
- [x] The summary links to each comment
- The pipeline never posts to a closed pull request`;

const FIX = `I want you to fix the summary being posted twice when a review is retried: a retried review should leave one summary.

Build it by checking the retry path in \`review.ts\`, which probably posts again without looking for the earlier summary.

Don't stop until a retried review leaves one summary. A new review still posts its own summary, e.g. on a new commit.`;

// The interim formats of TOOL-944, which are no longer tasks.
const INTERIM_STORY = `As a reviewer, I want inline comments so that I see feedback where it applies.

Covers: FR-1

## Acceptance Criteria

- [ ] A flagged line has a comment on it`;

const INTERIM_FIX = `## Current behavior

The summary is posted twice.

## Expected behavior

One summary per review.

## Unchanged behavior

A new review still posts its own summary.

## Acceptance Criteria

- [ ] A retried review leaves one summary`;

const LEGACY_PRD = `# PRD: Reviews

## Introduction

Inline reviews.

## Quality Gates

- \`pnpm test\` - Tests

## User Stories

### US-001: Post comments

**Description:** As a reviewer, I want comments.

**Acceptance Criteria:**
- [ ] Comments appear`;

describe("parseWorkItem", () => {
  it("reads an epic: its whole text as the description and its requirements", () => {
    const item = parseWorkItem(EPIC);
    expect(item).toMatchObject({ format: "epic", description: EPIC, approach: "" });
    expect(item?.kind).toBeUndefined();
    expect(item?.requirements).toEqual([
      { id: "FR-1", text: "The system must post a review comment on each changed line it flags." },
      { id: "FR-2", text: "WHEN a review finishes, the system must post a summary." },
    ]);
  });

  it("reads a Story: paragraph 1 as the description, 2 as the approach and the list of 3 as its criteria", () => {
    expect(parseWorkItem(STORY, { labels: ["Feature"] })).toMatchObject({
      format: "task",
      kind: "story",
      description:
        "I want you to build inline review comments, so that reviewers see feedback on the line it applies to.",
      approach:
        "Build it by extending the review pipeline in `packages/engine`: post one comment per flagged line.",
      acceptanceCriteria: [
        "A flagged line has a comment on it",
        "The summary links to each comment",
        "The pipeline never posts to a closed pull request",
      ],
      requirements: [],
    });
  });

  it("reads a Fix from its label, with prose done criteria split into sentences", () => {
    const item = parseWorkItem(FIX, { labels: [" bug "] });
    expect(item).toMatchObject({ format: "task", kind: "fix" });
    expect(item?.approach).toMatch(/^Build it by checking the retry path/);
    expect(item?.acceptanceCriteria).toEqual([
      "A retried review leaves one summary.",
      "A new review still posts its own summary, e.g. on a new commit.",
    ]);
    expect(parseWorkItem(FIX, { labels: ["Defect"], fixLabels: ["defect"] })?.kind).toBe("fix");
    expect(parseWorkItem(FIX)?.kind).toBe("story");
  });

  it("reads bold or curly-quoted openings, and keeps sentences in code spans whole", () => {
    const item = parseWorkItem(
      "**I want you to** add a flag.\n\n**Build it by** editing `cli.ts`.\n\nDon’t stop until `--dry-run. Done` prints nothing. Exit code is 0!",
    );
    expect(item?.acceptanceCriteria).toEqual([
      "`--dry-run. Done` prints nothing.",
      "Exit code is 0!",
    ]);
  });

  it("keeps a paragraph's following lines and blank-line breaks with it", () => {
    const item = parseWorkItem(
      "I want you to add a flag\nfor dry runs.\n\nMore about it.\n\nBuild it by editing `cli.ts`.\n\nDon't stop until:\n\n1. It prints nothing\n2. It exits 0",
    );
    expect(item?.description).toBe("I want you to add a flag\nfor dry runs.\n\nMore about it.");
    expect(item?.acceptanceCriteria).toEqual(["It prints nothing", "It exits 0"]);
  });

  it("returns null for a legacy PRD, a legacy story body, the interim formats and plain text", () => {
    expect(parseWorkItem(LEGACY_PRD)).toBeNull();
    expect(parseWorkItem("Do the thing\n\n## Acceptance Criteria\n- [ ] Done")).toBeNull();
    expect(parseWorkItem(INTERIM_STORY)).toBeNull();
    expect(parseWorkItem(INTERIM_FIX)).toBeNull();
    expect(parseWorkItem("I want you to do the thing.")).toBeNull();
    expect(parseWorkItem("Context first.\n\n" + STORY)).toBeNull();
    expect(parseWorkItem("Just a note")).toBeNull();
    expect(parseWorkItem("")).toBeNull();
    expect(workItemFormat(LEGACY_PRD)).toBeNull();
  });

  it("ignores headings inside fenced code", () => {
    const text = "Notes\n\n```md\n## Problem\n## Scope\n```";
    expect(workItemFormat(text)).toBeNull();
  });

  it("reads a draft as the format it is asked for", () => {
    expect(parseWorkItem("## Problem\n\nSlow.", { format: "epic" })).toMatchObject({
      format: "epic",
      requirements: [],
    });
    expect(parseWorkItem("Speed it up.", { format: "task" })).toMatchObject({
      format: "task",
      description: "",
      paragraphs: {},
      acceptanceCriteria: [],
    });
  });
});

describe("lintWorkItem", () => {
  it("finds nothing in a complete epic, Story or Fix", () => {
    expect(lintWorkItem(EPIC)).toEqual([]);
    expect(lintWorkItem(STORY)).toEqual([]);
    expect(lintWorkItem(FIX)).toEqual([]);
  });

  it("reports each missing required section of an epic", () => {
    const epic = "## Problem\n\nSlow.\n\n## Scope\n\n### In\n\n- Fast";
    expect(lintWorkItem(epic).map((p) => [p.code, p.section])).toEqual([
      ["missing-section", "Requirements"],
      ["missing-section", "Scope: Out"],
    ]);
  });

  it("reports each missing or empty paragraph of a task", () => {
    const noApproach = "I want you to add a flag.\n\nDon't stop until it prints nothing.";
    expect(lintWorkItem(noApproach).map((p) => [p.code, p.paragraph])).toEqual([
      ["missing-paragraph", "approach"],
    ]);
    const emptyApproach =
      "I want you to add a flag.\n\nBuild it by\n\nDon't stop until it exits 0.";
    expect(lintWorkItem(emptyApproach).map((p) => [p.code, p.paragraph])).toEqual([
      ["missing-paragraph", "approach"],
    ]);
    expect(lintWorkItem(INTERIM_STORY).map((p) => [p.code, p.paragraph])).toEqual([
      ["missing-paragraph", "build"],
      ["missing-paragraph", "approach"],
      ["missing-paragraph", "done"],
    ]);
  });

  it("reports a paragraph 3 that holds no done criterion", () => {
    const task = "I want you to add a flag.\n\nBuild it by editing `cli.ts`.\n\nDon't stop until:";
    expect(lintWorkItem(task).map((p) => [p.code, p.paragraph])).toEqual([
      ["empty-done-criteria", "done"],
    ]);
  });

  it("reports criteria phrased as outcomes after merge or metrics", () => {
    const task = `I want you to speed up setup.

Build it by caching the token.

Don't stop until:
- [ ] Users finish setup in under 2 minutes
- [ ] Adoption reaches half of the teams
- [ ] Error reports drop after release
- [ ] Support tickets decrease by 20%
- [ ] The setup page saves the token
- [ ] The import runs in under 2 seconds on the fixture repo`;
    expect(lintWorkItem(task).map((p) => [p.code, p.item])).toEqual([
      ["outcome-criterion", "Users finish setup in under 2 minutes"],
      ["outcome-criterion", "Adoption reaches half of the teams"],
      ["outcome-criterion", "Error reports drop after release"],
      ["outcome-criterion", "Support tickets decrease by 20%"],
    ]);
    const prose = `${STORY.split("\n\nDon't")[0]}\n\nDon't stop until the page saves the token. Retention improves.`;
    expect(lintWorkItem(prose).map((p) => [p.code, p.item])).toEqual([
      ["outcome-criterion", "Retention improves."],
    ]);
  });

  it("no longer checks a Covers line", () => {
    expect(lintWorkItem(`${STORY}\n\nCovers: FR-9`)).toEqual([]);
  });

  it("reports an Open Questions section that still has questions, not one that says None", () => {
    const open = `${EPIC}\n\n## Open Questions\n\n- Which reviewers see comments?`;
    expect(lintWorkItem(open).map((p) => p.code)).toEqual(["open-questions"]);
    expect(lintWorkItem(`${EPIC}\n\n## Open Questions\n\nNone.`)).toEqual([]);
    expect(
      lintWorkItem(`${STORY}\n\n## Open Questions\n\n- Which lines?`).map((p) => p.code),
    ).toEqual(["open-questions"]);
  });
});
