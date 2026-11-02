/**
 * The Markdown templates for the work items Omniralph builds against: an epic
 * and a task, whose Story (new work) and Fix (a bug) kinds share one
 * three-paragraph shape. Each heading and opening is defined once, here, so the
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

/**
 * The sections of the interim fix format, which tasks are no longer written in.
 * Only the parser and the story prompts still read them, until they read the
 * three-paragraph task.
 */
export const FIX_SECTIONS = {
  current: "Current behavior",
  expected: "Expected behavior",
  unchanged: "Unchanged behavior",
  acceptanceCriteria: "Acceptance Criteria",
} as const;

/** The heading of the checklist in the interim story and fix formats and in legacy PRDs. */
export const ACCEPTANCE_CRITERIA_SECTION = "Acceptance Criteria";

/**
 * The label of the interim story format's line naming the epic requirements it
 * owns (`Covers: FR-2, FR-4`). Tasks no longer carry one: the epic audit checks
 * every requirement against the finished branch.
 */
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

/** What one paragraph of a task holds, for each kind of task. */
export interface TaskParagraph {
  /** The words the paragraph opens with. */
  opening: string;
  /** What the paragraph holds in a Story. */
  story: string;
  /** What the paragraph holds in a Fix. */
  fix: string;
}

/**
 * The three paragraphs of a task, in order: what to build, how to build it and
 * when it is done. Story and Fix are kinds of the same shape; only what each
 * paragraph says differs. Each `story` and `fix` text reads on from the opening.
 */
export const TASK_PARAGRAPHS = {
  build: {
    opening: "I want you to",
    story: "build what the task delivers, for whom and why",
    fix: "fix what is broken, saying what happens now and what should happen instead",
  },
  approach: {
    opening: "Build it by",
    story: "where the code lives, the patterns to follow and the files to touch",
    fix: "the likely cause of the bug and where the code lives",
  },
  done: {
    opening: "Don't stop until",
    story: "the done criteria the loop can check and every constraint that must hold",
    fix: "the fixed behavior, every constraint that must hold and the nearby behavior that must not change",
  },
} as const satisfies Record<string, TaskParagraph>;

/** The Markdown placeholder of a paragraph: what it holds in a Story, then in a Fix. */
function placeholder(paragraph: TaskParagraph): string {
  return `[Story: ${paragraph.story}. Fix: ${paragraph.fix}.]`;
}

/**
 * A task, Story or Fix: three paragraphs opening with "I want you to", "Build
 * it by" and "Don't stop until". The done criteria may be prose or, as here, a
 * short list.
 */
export const TASK_TEMPLATE = `${TASK_PARAGRAPHS.build.opening} ${placeholder(TASK_PARAGRAPHS.build)}

${TASK_PARAGRAPHS.approach.opening} ${placeholder(TASK_PARAGRAPHS.approach)}

${TASK_PARAGRAPHS.done.opening} ${placeholder(TASK_PARAGRAPHS.done)}:
- [A done criterion to check]
- [A constraint that must hold]`;
