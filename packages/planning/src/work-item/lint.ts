/**
 * What a draft epic or task is missing before the loop can build against it:
 * an epic's required sections, a task's three paragraphs with checkable done
 * criteria, and no questions left open.
 */
import { EPIC_SECTIONS, SCOPE_PARTS, TASK_PARAGRAPHS } from "../methodology/templates.js";
import {
  TASK_PARAGRAPH_NAMES,
  findSection,
  parseWorkItem,
  workItemFormat,
  type TaskParagraphName,
  type WorkItemFormat,
} from "./parse.js";

/** The heading of the questions a draft still has to answer. */
export const OPEN_QUESTIONS_SECTION = "Open Questions";

export type LintCode =
  /** A required `##` section of an epic (or its `### In` / `### Out`) is missing or empty. */
  | "missing-section"
  /** A task paragraph is missing, or holds only its opening words. */
  | "missing-paragraph"
  /** A task's paragraph 3 ("Don't stop until …") holds no done criterion. */
  | "empty-done-criteria"
  /** A criterion describes an outcome after merge or a metric, not evidence to check. */
  | "outcome-criterion"
  /** `## Open Questions` still lists questions. */
  | "open-questions";

/** One thing a draft is missing. */
export interface LintProblem {
  code: LintCode;
  /** What is wrong, in one sentence. */
  message: string;
  /** The section the problem is in, when it is about one. */
  section?: string;
  /** The task paragraph the problem is in, when it is about one. */
  paragraph?: TaskParagraphName;
  /** The criterion at fault, when the problem is about one. */
  item?: string;
}

export interface LintOptions {
  /** Read the text as this format (default: the format it is detected as, else a task). */
  format?: WorkItemFormat;
}

const REQUIRED_EPIC_SECTIONS = [
  EPIC_SECTIONS.problem,
  EPIC_SECTIONS.scope,
  EPIC_SECTIONS.requirements,
] as const;

/** A paragraph as a problem names it: its number and its opening words. */
function paragraphLabel(name: TaskParagraphName): string {
  return `paragraph ${TASK_PARAGRAPH_NAMES.indexOf(name) + 1} ("${TASK_PARAGRAPHS[name].opening} …")`;
}

/**
 * Phrases of a criterion that can only be checked after merge: how people
 * respond, a business metric, or a time after release.
 */
const OUTCOME_PATTERNS: readonly RegExp[] = [
  // "users finish setup in under 2 minutes", "customers … within 5 days"
  /\b(?:users?|customers?|people|teams?|developers?|admins?|visitors?)\b.*\b(?:in|within)\s+(?:under|less than|fewer than|at most)?\s*\d+\s*(?:s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?|days?|weeks?|months?)\b/i,
  /\badoption\b/i,
  /\b(?:after|post[- ]?)(?:\s+the)?\s*(?:release|launch|merge|rollout|ship(?:ping)?|deploy(?:ment)?)\b/i,
  /\bonce\s+(?:it\s+|this\s+)?(?:is\s+)?(?:released|launched|shipped|deployed|merged|live)\b/i,
  /\b(?:conversion|retention|churn|engagement|satisfaction|nps|dau|mau|kpis?)\b/i,
  /\b(?:increases?|decreases?|reduces?|improves?|grows?|drops?|lowers?|raises?|cuts?)\b.*\bby\s+\d+(?:\.\d+)?\s*(?:%|percent)/i,
  /\b\d+(?:\.\d+)?\s*(?:%|percent)\s+(?:of\s+)?(?:users?|customers?|people|teams?|sessions?|visitors?)\b/i,
  /\bsuccess metrics?\b/i,
];

/** Whether a criterion is an outcome after merge or a metric rather than evidence to check. */
export function isOutcomeCriterion(criterion: string): boolean {
  return OUTCOME_PATTERNS.some((pattern) => pattern.test(criterion));
}

/** An `## Open Questions` body that answers nothing is left: empty, or "None". */
function noQuestions(body: string): boolean {
  const text = body
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_.]/g, "")
    .trim();
  return text === "" || /^(?:none|n\/a|-)$/i.test(text);
}

/**
 * Every problem of a draft epic or task, in document order of the checks: an
 * epic's missing sections, a task's missing paragraphs and empty done
 * criteria, outcome criteria and open questions. Empty when the draft is ready.
 */
export function lintWorkItem(text: string, options: LintOptions = {}): LintProblem[] {
  const item = parseWorkItem(text, { format: options.format ?? workItemFormat(text) ?? "task" });
  const problems: LintProblem[] = [];

  if (item.format === "epic") {
    for (const name of REQUIRED_EPIC_SECTIONS) {
      const section = findSection(item.sections, name);
      if (!section || section.body === "") {
        problems.push({
          code: "missing-section",
          section: name,
          message: `The ${name} section is ${section ? "empty" : "missing"}.`,
        });
      }
    }
    const scope = findSection(item.sections, EPIC_SECTIONS.scope);
    if (scope?.body) {
      for (const part of [SCOPE_PARTS.in, SCOPE_PARTS.out]) {
        if (!new RegExp(`^ {0,3}###[ \\t]+${part}\\b`, "im").test(scope.body)) {
          problems.push({
            code: "missing-section",
            section: `${EPIC_SECTIONS.scope}: ${part}`,
            message: `The ${EPIC_SECTIONS.scope} section has no ### ${part} part.`,
          });
        }
      }
    }
    const requirements = findSection(item.sections, EPIC_SECTIONS.requirements);
    if (requirements?.body && item.requirements.length === 0) {
      problems.push({
        code: "missing-section",
        section: EPIC_SECTIONS.requirements,
        message: `The ${EPIC_SECTIONS.requirements} section lists no requirement (FR-1: …).`,
      });
    }
  } else {
    for (const name of TASK_PARAGRAPH_NAMES) {
      const paragraph = item.paragraphs[name];
      if (paragraph === undefined) {
        problems.push({
          code: "missing-paragraph",
          paragraph: name,
          message: `The task has no ${paragraphLabel(name)}.`,
        });
      } else if (name !== "done" && !hasContent(paragraph, name)) {
        problems.push({
          code: "missing-paragraph",
          paragraph: name,
          message: `The task's ${paragraphLabel(name)} is empty.`,
        });
      }
    }
    if (item.paragraphs.done !== undefined && item.acceptanceCriteria.length === 0) {
      problems.push({
        code: "empty-done-criteria",
        paragraph: "done",
        message: `The task's ${paragraphLabel("done")} holds no done criterion.`,
      });
    }
    for (const criterion of item.acceptanceCriteria) {
      if (isOutcomeCriterion(criterion)) {
        problems.push({
          code: "outcome-criterion",
          paragraph: "done",
          item: criterion,
          message: `"${criterion}" is an outcome after merge or a metric, not evidence to check on the branch.`,
        });
      }
    }
  }

  const questions = findSection(item.sections, OPEN_QUESTIONS_SECTION);
  if (questions && !noQuestions(questions.body)) {
    problems.push({
      code: "open-questions",
      section: OPEN_QUESTIONS_SECTION,
      message: `The ${OPEN_QUESTIONS_SECTION} section still has questions: answer them and remove it.`,
    });
  }

  return problems;
}

/** Whether a paragraph says anything after its opening words. */
function hasContent(paragraph: string, name: TaskParagraphName): boolean {
  const opening = TASK_PARAGRAPHS[name].opening.length;
  return /[\p{L}\p{N}]/u.test(paragraph.replace(/^[\s*_]*/, "").slice(opening));
}
