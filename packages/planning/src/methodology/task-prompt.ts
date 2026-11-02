/**
 * The wording of a task's prompt that comes from the methodology: the epic as
 * background rather than work, how a three-paragraph task's paragraphs are
 * presented, how a Fix is framed and what an acceptance criterion is. Both
 * story prompts (ralph's and the `builtin:implement-story` playbook's) render
 * these texts, so an agent reads the same rules triage writes the work items by.
 */

/** The heading of the epic's description in a task's prompt, marking it as background. */
export const EPIC_CONTEXT_HEADING = "Epic Context (background, not your task)";

/** What the epic's description is for, above it in a task's prompt. */
export const EPIC_CONTEXT_NOTE = `The epic's description explains why the work exists and what its tasks deliver together. Its requirements are delivered across all of the epic's tasks: build only what your task asks for. Your task's own acceptance criteria decide when it is done.`;

/** What a criterion is and how it's satisfied: evidence to check, not a test to write. */
const CRITERIA_AS_EVIDENCE = `A criterion is evidence to check, not a test to write: confirm it in the code, the output of a command or the behavior of the running software. Write tests where the repo's conventions call for them on new behavior, never just to prove a criterion. A test that only asserts a file exists or what a config contains doesn't satisfy a criterion.`;

/** What an acceptance criterion is, above a legacy story's criteria in its prompt. */
export const CRITERIA_AS_EVIDENCE_NOTE = `Your task is done when every criterion below holds. ${CRITERIA_AS_EVIDENCE}`;

/**
 * How a legacy Fix (a story with a fix label that isn't a three-paragraph
 * task) is worked, in its prompt.
 */
export const FIX_TASK_NOTE = `This task is a Fix: make the current behavior become the expected behavior, and keep the unchanged behavior working exactly as it is. Add a regression test only where the affected code already has tests.`;

/**
 * The headings of a three-paragraph task's paragraphs in its prompt: what to
 * build (a Fix: what is broken), how to build it (a Fix: the likely cause),
 * marked as guidance, and the stop condition.
 */
export const TASK_PROMPT_HEADINGS = {
  build: { story: "What to Build", fix: "What Is Broken" },
  approach: {
    story: "How to Build It (guidance)",
    fix: "Likely Cause and How to Fix It (guidance)",
  },
  done: "Don't Stop Until",
} as const;

/** What paragraph 2 is, above it in a task's prompt. */
export const TASK_APPROACH_NOTE = `This is guidance on how to build it, not part of what is checked: follow it where it fits, and depart from it when the code shows a better way.`;

/** What paragraph 3 is, above its criteria in a task's prompt: the stop condition, as evidence. */
export const TASK_DONE_NOTE = `This is your stop condition: keep working until every criterion below holds, and every constraint in it is respected. ${CRITERIA_AS_EVIDENCE}`;

/** How a three-paragraph Fix is worked, in its prompt. */
export const FIX_TASK_PROMPT_NOTE = `This task is a Fix: "${TASK_PROMPT_HEADINGS.build.fix}" below is the bug and what should happen instead. Make that happen, and keep every behavior named under "${TASK_PROMPT_HEADINGS.done}" working as it does now. Add a regression test only where the affected code already has tests.`;
