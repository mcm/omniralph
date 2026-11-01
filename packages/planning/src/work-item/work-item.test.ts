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

const STORY = `As a reviewer, I want inline comments so that I see feedback where it applies.

Covers: FR-1, fr-2

Touch \`packages/engine\`.

## Acceptance Criteria

- [ ] A flagged line has a comment on it
- [x] The summary links to each comment`;

const FIX = `**Covers:** FR-2

## Current behavior

The summary is posted twice when a review is retried.

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
    expect(item).toMatchObject({ format: "epic", description: EPIC, covers: [] });
    expect(item?.kind).toBeUndefined();
    expect(item?.requirements).toEqual([
      { id: "FR-1", text: "The system must post a review comment on each changed line it flags." },
      { id: "FR-2", text: "WHEN a review finishes, the system must post a summary." },
    ]);
  });

  it("reads a story: the work without its Covers line, its criteria and the requirements it covers", () => {
    expect(parseWorkItem(STORY)).toMatchObject({
      format: "story",
      kind: "story",
      description:
        "As a reviewer, I want inline comments so that I see feedback where it applies.\n\nTouch `packages/engine`.",
      acceptanceCriteria: [
        "A flagged line has a comment on it",
        "The summary links to each comment",
      ],
      covers: ["FR-1", "FR-2"],
      requirements: [],
    });
  });

  it("reads a story without a Covers line from its user story sentence", () => {
    const item = parseWorkItem(
      "As an admin, I want an audit log so that I can trace changes.\n\n## Acceptance Criteria\n\n- Each change has a log entry",
    );
    expect(item).toMatchObject({
      format: "story",
      covers: [],
      acceptanceCriteria: ["Each change has a log entry"],
    });
  });

  it("reads a fix: its behavior sections as the description, framed as a fix", () => {
    const item = parseWorkItem(FIX);
    expect(item).toMatchObject({
      format: "fix",
      kind: "fix",
      covers: ["FR-2"],
      acceptanceCriteria: ["A retried review leaves one summary"],
    });
    expect(item?.description).toBe(
      [
        "## Current behavior\n\nThe summary is posted twice when a review is retried.",
        "## Expected behavior\n\nOne summary per review.",
        "## Unchanged behavior\n\nA new review still posts its own summary.",
      ].join("\n\n"),
    );
  });

  it("returns null for a legacy PRD, a legacy story body and plain text", () => {
    expect(parseWorkItem(LEGACY_PRD)).toBeNull();
    expect(parseWorkItem("Do the thing\n\n## Acceptance Criteria\n- [ ] Done")).toBeNull();
    expect(parseWorkItem("Just a note")).toBeNull();
    expect(parseWorkItem("")).toBeNull();
    expect(workItemFormat(LEGACY_PRD)).toBeNull();
  });

  it("ignores headings inside fenced code", () => {
    const text = "Notes\n\n```md\n## Problem\n## Scope\n```";
    expect(workItemFormat(text)).toBeNull();
  });

  it("reads a draft as the format it is asked for", () => {
    expect(parseWorkItem("## Problem\n\nSlow.", "epic")).toMatchObject({
      format: "epic",
      requirements: [],
    });
  });
});

describe("lintWorkItem", () => {
  it("finds nothing in a complete epic, story or fix", () => {
    expect(lintWorkItem(EPIC)).toEqual([]);
    expect(lintWorkItem(STORY, { epicRequirements: ["FR-1", "FR-2"] })).toEqual([]);
    expect(lintWorkItem(FIX, { epicRequirements: ["FR-1", "FR-2"] })).toEqual([]);
  });

  it("reports each missing required section", () => {
    const epic = "## Problem\n\nSlow.\n\n## Scope\n\n### In\n\n- Fast";
    expect(lintWorkItem(epic).map((p) => [p.code, p.section])).toEqual([
      ["missing-section", "Requirements"],
      ["missing-section", "Scope: Out"],
    ]);
    const fix = "## Current behavior\n\nCrashes.\n\n## Expected behavior\n\nNo crash.";
    expect(lintWorkItem(fix).map((p) => p.section)).toEqual([
      "Unchanged behavior",
      "Acceptance Criteria",
    ]);
    expect(lintWorkItem("As a user, I want speed.").map((p) => p.section)).toEqual([
      "Acceptance Criteria",
    ]);
  });

  it("reports an empty Acceptance Criteria section", () => {
    const problems = lintWorkItem("Covers: FR-1\n\n## Acceptance Criteria\n\n");
    expect(problems.map((p) => p.code)).toEqual(["empty-acceptance-criteria"]);
  });

  it("reports criteria phrased as outcomes after merge or metrics", () => {
    const story = `Covers: FR-1

## Acceptance Criteria

- [ ] Users finish setup in under 2 minutes
- [ ] Adoption reaches half of the teams
- [ ] Error reports drop after release
- [ ] Support tickets decrease by 20%
- [ ] The setup page saves the token
- [ ] The import runs in under 2 seconds on the fixture repo`;
    expect(lintWorkItem(story).map((p) => [p.code, p.item])).toEqual([
      ["outcome-criterion", "Users finish setup in under 2 minutes"],
      ["outcome-criterion", "Adoption reaches half of the teams"],
      ["outcome-criterion", "Error reports drop after release"],
      ["outcome-criterion", "Support tickets decrease by 20%"],
    ]);
  });

  it("reports Covers entries the epic's requirements don't define", () => {
    const epicRequirements = parseWorkItem(EPIC)?.requirements.map((r) => r.id);
    const story = "Covers: FR-1, FR-7, the login page\n\n## Acceptance Criteria\n\n- [ ] Done";
    expect(lintWorkItem(story, { epicRequirements }).map((p) => [p.code, p.item])).toEqual([
      ["unknown-requirement", "FR-7"],
      ["unknown-requirement", "the login page"],
    ]);
  });

  it("reports an Open Questions section that still has questions, not one that says None", () => {
    const open = `${EPIC}\n\n## Open Questions\n\n- Which reviewers see comments?`;
    expect(lintWorkItem(open).map((p) => p.code)).toEqual(["open-questions"]);
    expect(lintWorkItem(`${EPIC}\n\n## Open Questions\n\nNone.`)).toEqual([]);
  });
});
