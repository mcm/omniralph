/**
 * The wording of a task's prompt that comes from the methodology: the epic as
 * background rather than work, the requirements a task covers, how a Fix is
 * framed and what an acceptance criterion is. Both story prompts (ralph's and
 * the `builtin:implement-story` playbook's) render these texts, so an agent
 * reads the same rules triage writes the work items by.
 */
import { splitSections, findSection } from "../work-item/parse.js";
import { FIX_SECTIONS } from "./templates.js";

/** The heading of the epic's description in a task's prompt, marking it as background. */
export const EPIC_CONTEXT_HEADING = "Epic Context (background, not your task)";

/** What the epic's description is for, above it in a task's prompt. */
export const EPIC_CONTEXT_NOTE = `The epic's description explains why the work exists and what its tasks deliver together. Its requirements are delivered across all of the epic's tasks: build only what your task asks for. Your task's own acceptance criteria decide when it is done.`;

/** The heading of the requirements a task owns, in its prompt. */
export const COVERED_REQUIREMENTS_HEADING = "Requirements This Task Covers";

/** What the requirements of a task's `Covers:` line are, above them in its prompt. */
export const COVERED_REQUIREMENTS_NOTE = `The epic requirements this task owns, as the epic words them. The acceptance criteria below show what delivering them takes in this task.`;

/** What an unknown requirement of a `Covers:` line shows instead of its text. */
export const UNKNOWN_REQUIREMENT_TEXT = "(not among the epic's requirements)";

/** How a Fix is worked, in its prompt. */
export const FIX_TASK_NOTE = `This task is a Fix: make the current behavior become the expected behavior, and keep the unchanged behavior working exactly as it is. Add a regression test only where the affected code already has tests.`;

/** What an acceptance criterion is, above a task's criteria in its prompt. */
export const CRITERIA_AS_EVIDENCE_NOTE = `Your task is done when every criterion below holds. A criterion is evidence to check, not a test to write: confirm it in the code, the output of a command or the behavior of the running software. Write tests where the repo's conventions call for them on new behavior, never just to prove a criterion. A test that only asserts a file exists or what a config contains doesn't satisfy a criterion.`;

/** A Fix's description split into its behavior sections and the rest. */
export interface FixDescription {
  /** The text that is none of the behavior sections (the lead and any other section), trimmed. */
  description: string;
  /** `## Current behavior`, when the description has it. */
  current: string | null;
  /** `## Expected behavior`, when the description has it. */
  expected: string | null;
  /** `## Unchanged behavior`, when the description has it. */
  unchanged: string | null;
}

/**
 * A task description (without its acceptance criteria) with the Fix sections
 * taken out, so a prompt can show each one under its own heading. Text with
 * none of them comes back whole as `description`.
 */
export function splitFixDescription(text: string): FixDescription {
  const { lead, sections } = splitSections(text.trim());
  const pick = (name: string) => findSection(sections, name);
  const parts = {
    current: pick(FIX_SECTIONS.current),
    expected: pick(FIX_SECTIONS.expected),
    unchanged: pick(FIX_SECTIONS.unchanged),
  };
  const taken = new Set(Object.values(parts));
  const description = [
    lead,
    ...sections
      .filter((section) => !taken.has(section))
      .map((section) => `## ${section.name}\n\n${section.body}`.trim()),
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  return {
    description,
    current: parts.current?.body || null,
    expected: parts.expected?.body || null,
    unchanged: parts.unchanged?.body || null,
  };
}
