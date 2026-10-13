import { describe, expect, it } from "vitest";
import {
  parseBranchLine,
  parsePrd,
  parsePrdJson,
  parsePrdMarkdown,
  parseQualityGates,
  parseRepositoryQualityGates,
} from "./prd.js";
import {
  buildStoryIssueBody,
  linearPriorityFor,
  parseStoryBody,
  storyRank,
  stripLegacyMetadata,
} from "./story-body.js";

const PRD = `[PRD]
# PRD: Task Priority System

> Branch: \`ralph/task-priority\`

## Overview
Add priority levels to tasks so users can focus on what matters.

## Goals
- Ship it

## Quality Gates
These commands must pass for every user story:
- \`pnpm typecheck\` - Type checking
- \`pnpm lint\` - Linting

For UI stories, also include:
- Verify in browser using dev-browser skill

## User Stories

### US-001: Add priority field to database
**Description:** As a developer, I need to store task priority.

**Acceptance Criteria:**
- [ ] Add priority column: 1-4 (default 2)
- [ ] Migration runs successfully

### US-002: Show priority badge
**Description:** As a user, I want to see priority at a glance.
It should be colourful.

**Priority:** P1
**Depends on:** US-001

**Acceptance Criteria:**
- [ ] Badge renders on each card

## Functional Requirements
- FR-1: something
[/PRD]`;

describe("parsePrdMarkdown", () => {
  it("parses the ralph-tui-prd skill format", () => {
    const prd = parsePrdMarkdown(PRD);
    expect(prd).not.toBeNull();
    expect(prd?.name).toBe("Task Priority System");
    expect(prd?.branchName).toBe("ralph/task-priority");
    expect(prd?.description).toContain("Add priority levels");
    expect(prd?.qualityGates).toEqual(["pnpm typecheck", "pnpm lint"]);
    expect(prd?.stories.map((s) => s.id)).toEqual(["US-001", "US-002"]);
    const [a, b] = prd?.stories ?? [];
    expect(a?.acceptanceCriteria).toEqual([
      "Add priority column: 1-4 (default 2)",
      "Migration runs successfully",
    ]);
    expect(a?.description).toBe("As a developer, I need to store task priority.");
    expect(b?.priority).toBe(1);
    expect(b?.dependsOn).toEqual(["US-001"]);
    expect(b?.description).toContain("colourful");
    // Functional requirements must not leak into the last story.
    expect(b?.acceptanceCriteria).toEqual(["Badge renders on each card"]);
  });

  it("returns null without user stories", () => {
    expect(parsePrdMarkdown("# Just a bug\n\nIt crashes.")).toBeNull();
  });
});

describe("parsePrdJson / parsePrd", () => {
  const json = {
    name: "Task Priority System",
    branchName: "ralph/task-priority",
    userStories: [
      {
        id: "US-001",
        title: "DB",
        acceptanceCriteria: ["a"],
        priority: 1,
        passes: true,
        dependsOn: [],
      },
      { id: "US-002", title: "UI", priority: 2, passes: false, dependsOn: ["US-001"] },
    ],
  };

  it("parses prd.json", () => {
    const prd = parsePrdJson(JSON.stringify(json));
    expect(prd?.stories[0]?.passes).toBe(true);
    expect(prd?.stories[1]?.dependsOn).toEqual(["US-001"]);
  });

  it("finds prd.json in a fenced block of an issue description", () => {
    const prd = parsePrd(
      `Here is the plan:\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n`,
    );
    expect(prd?.source).toBe("json");
    expect(prd?.stories).toHaveLength(2);
  });

  it("falls back to markdown", () => {
    expect(parsePrd(PRD)?.source).toBe("markdown");
  });

  it("extracts quality gates standalone", () => {
    expect(parseQualityGates(PRD)).toEqual(["pnpm typecheck", "pnpm lint"]);
  });
});

describe("story issue body", () => {
  it("round-trips without ralph markers", () => {
    const body = buildStoryIssueBody({ description: "Do it", acceptanceCriteria: ["x", "y"] });
    expect(body).not.toMatch(/Ralph|US-/);
    expect(parseStoryBody(body)).toEqual({ description: "Do it", acceptanceCriteria: ["x", "y"] });
  });

  it("treats plain descriptions as description + checklist", () => {
    const parsed = parseStoryBody("Fix the thing\n\n- [ ] it works\n- [x] tests");
    expect(parsed.description).toContain("Fix the thing");
    expect(parsed.acceptanceCriteria).toEqual(["it works", "tests"]);
    expect(parsed.legacyRalphPriority).toBeUndefined();
  });

  it("strips a legacy Ralph Metadata section, keeping its priority only as a fallback", () => {
    const legacy =
      "## Ralph Metadata\n- **Story ID:** US-001\n- **Ralph Priority:** 2\n\n## Description\nDo it\n\n## Acceptance Criteria\n- [ ] x";
    expect(parseStoryBody(legacy)).toEqual({
      description: "Do it",
      acceptanceCriteria: ["x"],
      legacyRalphPriority: 2,
    });
    expect(stripLegacyMetadata(legacy)).toBe(
      "## Description\nDo it\n\n## Acceptance Criteria\n- [ ] x",
    );
  });

  it("ranks by Linear priority, then legacy priority, then last", () => {
    expect(storyRank(1)).toBe(1);
    expect(storyRank(4, 1)).toBe(4);
    expect(storyRank(0, 2)).toBe(2);
    expect(storyRank(0)).toBe(5);
    expect([1, 2, 3, 4, 9].map(linearPriorityFor)).toEqual([1, 2, 3, 4, 4]);
  });
});

describe("parsePrd extras", () => {
  it("reads the branch line and quality gates around a prd.json block", () => {
    const json = JSON.stringify({ name: "X", userStories: [{ id: "US-001", title: "A" }] });
    const prd = parsePrd(
      `> Branch: feat/x\n\n## Quality Gates\n- \`pnpm test\` - tests\n\n\`\`\`json\n${json}\n\`\`\`\n`,
    );
    expect(prd).toMatchObject({
      source: "json",
      branchName: "feat/x",
      qualityGates: ["pnpm test"],
    });
  });

  it("takes the first backticked span of each quality gate bullet only", () => {
    expect(
      parseQualityGates(
        "## Quality Gates\n- `a` then `b`\n* `c`\n- not a gate\n- `a`\n\n## Next\n- `d`",
      ),
    ).toEqual(["a", "c"]);
  });

  it("reads a branch line without a PRD", () => {
    expect(parseBranchLine("Epic\n\n> Branch: `feat/epic`\n")).toBe("feat/epic");
    expect(parseBranchLine("No branch here")).toBeUndefined();
    expect(parsePrd("> Branch: feat/epic\n\nJust prose.")).toBeNull();
    expect(parsePrd("")).toBeNull();
  });
});

describe("repository quality gates", () => {
  const gates = (body: string) => parseRepositoryQualityGates(`## Quality Gates\n${body}`);

  it("keeps shared gates only when no repository is named", () => {
    expect(gates("- `pnpm lint`\n- `pnpm test`\n")).toEqual({
      shared: ["pnpm lint", "pnpm test"],
      byRepository: {},
    });
    expect(parsePrd(`${PRD}`)).not.toHaveProperty("repositoryQualityGates");
  });

  it("scopes bullets under a repository heading to that repository", () => {
    const body = [
      "- `pnpm lint` - Linting",
      "",
      "### mcm/Omniralph",
      "- `pnpm test`",
      "",
      "### `Group/Sub/API.git`",
      "- `go test ./...`",
      "",
      "## Non-Goals",
      "- `not a gate`",
    ].join("\n");
    expect(gates(body)).toEqual({
      shared: ["pnpm lint"],
      byRepository: { "mcm/omniralph": ["pnpm test"], "group/sub/api": ["go test ./..."] },
    });
    expect(parseQualityGates(`## Quality Gates\n${body}`)).toEqual(["pnpm lint"]);
  });

  it("keeps bullets under a heading that isn't a repository path shared", () => {
    expect(
      gates(
        "- `pnpm lint`\n\n### For UI stories, also:\n- `pnpm e2e`\n\n### acme/web\n- `pnpm build`\n\n### Other checks\n- `pnpm audit`",
      ),
    ).toEqual({
      shared: ["pnpm lint", "pnpm e2e", "pnpm audit"],
      byRepository: { "acme/web": ["pnpm build"] },
    });
  });

  it("reads repository headings Linear escaped", () => {
    expect(gates("* `make check`\n\n### acme/my\\_repo\\-x:\n* `make test`")).toEqual({
      shared: ["make check"],
      byRepository: { "acme/my_repo-x": ["make test"] },
    });
  });

  it("drops duplicates within a scope and merges repeated repository headings", () => {
    expect(
      gates("- `a`\n- `a`\n### acme/web\n- `b`\n- `a`\n### ACME/web.git\n- `b`\n- `c`"),
    ).toEqual({ shared: ["a"], byRepository: { "acme/web": ["b", "a", "c"] } });
  });

  it("carries scoped gates on the parsed PRD", () => {
    const text = `${PRD.replace("## Quality Gates", "## Quality Gates\n### acme/web\n- `pnpm build`\n\n### Shared again")}`;
    expect(parsePrd(text)?.repositoryQualityGates).toEqual({ "acme/web": ["pnpm build"] });
  });
});

describe("parseStoryBody", () => {
  it("takes the acceptance criteria from the Acceptance Criteria section only", () => {
    const parsed = parseStoryBody(
      "Build it.\n\n- [ ] not a criterion\n\n## Acceptance Criteria\n- [ ] one\n- [x] two\n\n## Test Plan\n- [ ] later",
    );
    expect(parsed.description).toBe("Build it.\n\n- [ ] not a criterion");
    expect(parsed.acceptanceCriteria).toEqual(["one", "two"]);
    expect(parseStoryBody(undefined)).toEqual({ description: "", acceptanceCriteria: [] });
  });
});
