/**
 * The plan critic's rubrics: what a triage draft must get right before
 * Omniralph builds against it, one rubric per size of draft. A Fix and a
 * Story are judged as single tasks in the task format; an Epic by the epic
 * format, its requirements and the stories that build them. The critic
 * playbook (`builtin:critique-plan`) renders the rubric matched to a draft's
 * size and answers one note per item, by its `id`.
 *
 * Each item restates its rule from `rules.ts` and `templates.ts` as one thing
 * to judge, so the critic, the triage prompt and the formats agree on it.
 */
import {
  EPIC_SECTIONS,
  REQUIREMENT_PREFIX,
  SCOPE_PARTS,
  TASK_PARAGRAPHS,
  VALIDATION_AUDIT_TITLE,
} from "./templates.js";

/** The sizes of draft the critic has a rubric for. */
export const CRITIQUE_SIZES = ["fix", "story", "epic"] as const;
export type CritiqueSize = (typeof CRITIQUE_SIZES)[number];

/** One thing the critic judges a draft on. */
export interface RubricItem {
  /** A stable identifier the critic's note names, e.g. `checkable-criteria`. */
  id: string;
  /** What the draft must do, in one or two sentences. */
  check: string;
}

function code(text: string): string {
  return `\`${text}\``;
}

/** A task paragraph as a rubric names it: its number and its opening words. */
function paragraph(name: keyof typeof TASK_PARAGRAPHS): string {
  const number = Object.keys(TASK_PARAGRAPHS).indexOf(name) + 1;
  return `paragraph ${number} (${code(`${TASK_PARAGRAPHS[name].opening} …`)})`;
}

const TASK_SHAPE: RubricItem = {
  id: "task-format",
  check: `The description is exactly three paragraphs opening with ${code(`${TASK_PARAGRAPHS.build.opening} …`)}, ${code(`${TASK_PARAGRAPHS.approach.opening} …`)} and ${code(`${TASK_PARAGRAPHS.done.opening} …`)}, in that order, and nothing else: no headings, checklist section, story sentence ("As a … I want … so that …"), ${code("Covers:")} line, identifiers or metadata lines.`,
};

const CHECKABLE_CRITERIA: RubricItem = {
  id: "checkable-criteria",
  check: `Every done criterion in ${paragraph("done")} is evidence an agent can confirm inside the repo (in the code, the output of a command or the behavior of the running software): no outcome or metric measured after merge, nothing needing human judgement, production access or an outside account, and no criterion phrased as a test to write.`,
};

const CONSTRAINTS_PLACED: RubricItem = {
  id: "constraints-placed",
  check: `Every constraint that must hold (something not to change, not to do, or to keep working) is in ${paragraph("done")}, not only in ${paragraph("approach")}: the agent verifying the task never sees paragraph 2.`,
};

const GROUNDED: RubricItem = {
  id: "grounded-in-repo",
  check: `The file paths, functions, settings and behavior the draft names exist in the repo as described (when there is no repo, the draft keeps paths generic and asks which repo the work belongs in).`,
};

const ONE_SESSION: RubricItem = {
  id: "one-session",
  check: `The work is small enough for one fresh, unattended agent session (smaller than L): it doesn't need splitting into an epic of stories.`,
};

/** A Fix: the bugfix sections of the task format. */
const FIX_RUBRIC: readonly RubricItem[] = [
  TASK_SHAPE,
  {
    id: "broken-behavior",
    check: `${paragraph("build")} says what is broken: what happens now and what should happen instead, concretely enough to tell the two apart.`,
  },
  {
    id: "reproduction",
    check: `The draft says how to reproduce the bug: the steps, input or state that makes it happen, so the agent can see it fail before fixing it.`,
  },
  {
    id: "located-cause",
    check: `${paragraph("approach")} names the likely cause of the bug and where the code lives, by real file (and function) the repo has.`,
  },
  {
    id: "fixed-behavior",
    check: `${paragraph("done")} states the fixed behavior as criteria the loop can check, and the nearby behavior that must not change.`,
  },
  CHECKABLE_CRITERIA,
  CONSTRAINTS_PLACED,
  GROUNDED,
  ONE_SESSION,
];

/** A Story: the story sentence (paragraph 1) and checkable acceptance criteria. */
const STORY_RUBRIC: readonly RubricItem[] = [
  TASK_SHAPE,
  {
    id: "story-sentence",
    check: `${paragraph("build")} says what to build, for whom and why, in one paragraph: a person reading only it knows what the task delivers.`,
  },
  {
    id: "approach",
    check: `${paragraph("approach")} says where the code lives, the patterns to follow and the files to touch, as guidance the agent may depart from.`,
  },
  {
    id: "done-criteria",
    check: `${paragraph("done")} holds the done criteria the loop checks, and together they cover everything ${paragraph("build")} asks for.`,
  },
  CHECKABLE_CRITERIA,
  CONSTRAINTS_PLACED,
  GROUNDED,
  ONE_SESSION,
];

/** An Epic: the epic template, every requirement built by a story, and the stories' order as blocks. */
const EPIC_RUBRIC: readonly RubricItem[] = [
  {
    id: "epic-format",
    check: `The description follows the epic template: ${code(`## ${EPIC_SECTIONS.problem}`)}, ${code(`## ${EPIC_SECTIONS.scope}`)} (with ${code(`### ${SCOPE_PARTS.in}`)} and ${code(`### ${SCOPE_PARTS.out}`)}), the optional ${code(`## ${EPIC_SECTIONS.design}`)} and ${code(`## ${EPIC_SECTIONS.technicalNotes}`)}, and ${code(`## ${EPIC_SECTIONS.requirements}`)}, in that order, and nothing else: no title heading, checklist or list of commands to run.`,
  },
  {
    id: "honest-scope",
    check: `${code(`### ${SCOPE_PARTS.out}`)} lists only what is really out of scope: no requested work relabeled as later or optional.`,
  },
  {
    id: "requirement-wording",
    check: `The requirements are a bullet list numbered from 1 (${code(`- ${REQUIREMENT_PREFIX}1: The system must …`)}), each one behavior stated as what the system must do, with WHEN or IF only on conditional behavior.`,
  },
  {
    id: "requirements-covered",
    check: `Every requirement is built by at least one story, and every story is in scope for the epic. Name each requirement no story builds.`,
  },
  {
    id: "story-order",
    check: `The stories are ordered so earlier ones enable later ones, and each story's dependencies are expressed as blocks relations (${code("dependsOn")}) on earlier stories it really depends on: no story waits on a later one, and no relation is missing where a story builds on another's work.`,
  },
  {
    id: "story-split",
    check: `The stories are split by feature boundary, never by development phase; tests, error handling and documentation are in the story that adds the code; there is no ${code(VALIDATION_AUDIT_TITLE)} or other audit story; and a step only a person can do is its own manual story.`,
  },
  {
    id: "story-format",
    check: `Every story's body is a task in the task format (three paragraphs opening with ${code(`${TASK_PARAGRAPHS.build.opening} …`)}, ${code(`${TASK_PARAGRAPHS.approach.opening} …`)} and ${code(`${TASK_PARAGRAPHS.done.opening} …`)}), small enough for one session, with done criteria the loop can check and its constraints in paragraph 3.`,
  },
  GROUNDED,
];

/** The rubric for each size of draft, its items in the order the critic judges them. */
export const PLAN_RUBRICS: Readonly<Record<CritiqueSize, readonly RubricItem[]>> = {
  fix: FIX_RUBRIC,
  story: STORY_RUBRIC,
  epic: EPIC_RUBRIC,
};

/** The rubric for `size` as a Markdown list: one `` - `id`: check `` line per item. */
export function renderRubric(size: CritiqueSize): string {
  return PLAN_RUBRICS[size].map((item) => `- ${code(item.id)}: ${item.check}`).join("\n");
}
