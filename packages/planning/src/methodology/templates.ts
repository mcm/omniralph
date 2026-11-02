/**
 * The Markdown templates for the work items Omniralph builds against: an epic,
 * a story (a task for new work) and a fix (a task for a bug). Each heading is defined once, here, so the
 * templates, the methodology text and the parser agree on it.
 */

/** The sections of an epic, in order. */
export const EPIC_SECTIONS = {
  problem: "Problem",
  scope: "Scope",
  design: "Design",
  technicalNotes: "Technical notes",
  requirements: "Requirements",
} as const;

/** The epic sections that may be left out when there is nothing to say. */
export const OPTIONAL_EPIC_SECTIONS: readonly string[] = [
  EPIC_SECTIONS.design,
  EPIC_SECTIONS.technicalNotes,
];

/** The two parts of an epic's `## Scope`, as `###` headings. */
export const SCOPE_PARTS = { in: "In", out: "Out" } as const;

/** The sections of a fix, in order. */
export const FIX_SECTIONS = {
  current: "Current behavior",
  expected: "Expected behavior",
  unchanged: "Unchanged behavior",
  acceptanceCriteria: "Acceptance Criteria",
} as const;

/** The heading of a task's checklist, story or fix. */
export const ACCEPTANCE_CRITERIA_SECTION = "Acceptance Criteria";

/** The label of the line naming the epic requirements a story owns (`Covers: FR-2, FR-4`). */
export const COVERS_LABEL = "Covers";

/** The prefix of a requirement's identifier (`FR-1`). */
export const REQUIREMENT_PREFIX = "FR-";

/**
 * The title of the legacy validation task that closed an epic before the epic audit
 * replaced it. Epics are no longer planned with one; an existing one still runs as a task.
 */
export const VALIDATION_AUDIT_TITLE = "Validate functional requirements";

/** A `##` heading line. */
export function heading(name: string): string {
  return `## ${name}`;
}

/** An epic: the problem, the scope, how it is built and what it must do. */
export const EPIC_TEMPLATE = `${heading(EPIC_SECTIONS.problem)}

[Who has the problem, what it is today and why it matters now.]

${heading(EPIC_SECTIONS.scope)}

### ${SCOPE_PARTS.in}

- [What this epic delivers]

### ${SCOPE_PARTS.out}

- [What it deliberately leaves out]

${heading(EPIC_SECTIONS.design)}

[Optional: UI and UX decisions, flows, components to reuse.]

${heading(EPIC_SECTIONS.technicalNotes)}

[Optional: constraints, integration points, file paths, patterns to follow.]

${heading(EPIC_SECTIONS.requirements)}

- ${REQUIREMENT_PREFIX}1: The system must [behavior].
- ${REQUIREMENT_PREFIX}2: WHEN [event or state], the system must [behavior].
- ${REQUIREMENT_PREFIX}3: IF [unwanted condition], the system must [behavior].`;

/** A story: a task for new work, owning some of its epic's requirements. */
export const STORY_TEMPLATE = `As a [user], I want [capability] so that [benefit].

${COVERS_LABEL}: ${REQUIREMENT_PREFIX}1, ${REQUIREMENT_PREFIX}3

[Optional context: files to touch, patterns to follow.]

${heading(ACCEPTANCE_CRITERIA_SECTION)}

- [ ] [Evidence to check]
- [ ] [More evidence to check]`;

/** A fix: a task for a bug, framed by how the behavior must change and what must not. */
export const FIX_TEMPLATE = `${heading(FIX_SECTIONS.current)}

[What happens now, with the steps or input that show it.]

${heading(FIX_SECTIONS.expected)}

[What must happen instead.]

${heading(FIX_SECTIONS.unchanged)}

[Nearby behavior the fix must keep exactly as it is.]

${heading(FIX_SECTIONS.acceptanceCriteria)}

- [ ] [Evidence to check]
- [ ] [More evidence to check]`;
