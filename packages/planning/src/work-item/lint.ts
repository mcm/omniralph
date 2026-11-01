/**
 * What a draft epic, story or fix is missing before the loop can build
 * against it: the required sections, checkable acceptance criteria, `Covers:`
 * entries the epic defines, and no questions left open.
 */
import {
  ACCEPTANCE_CRITERIA_SECTION,
  COVERS_LABEL,
  EPIC_SECTIONS,
  FIX_SECTIONS,
  SCOPE_PARTS,
} from "../methodology/templates.js";
import { findSection, parseWorkItem, workItemFormat, type WorkItemFormat } from "./parse.js";

/** The heading of the questions a draft still has to answer. */
export const OPEN_QUESTIONS_SECTION = "Open Questions";

export type LintCode =
  /** A required `##` section (or an epic's `### In` / `### Out`) is missing or empty. */
  | "missing-section"
  /** `## Acceptance Criteria` is there but lists no criterion. */
  | "empty-acceptance-criteria"
  /** A criterion describes an outcome after merge or a metric, not evidence to check. */
  | "outcome-criterion"
  /** A `Covers:` entry names a requirement the epic doesn't define. */
  | "unknown-requirement"
  /** `## Open Questions` still lists questions. */
  | "open-questions";

/** One thing a draft is missing. */
export interface LintProblem {
  code: LintCode;
  /** What is wrong, in one sentence. */
  message: string;
  /** The section the problem is in, when it is about one. */
  section?: string;
  /** The criterion or `Covers:` entry at fault, when the problem is about one. */
  item?: string;
}

export interface LintOptions {
  /** Read the text as this format (default: the format it is detected as, else a story). */
  format?: WorkItemFormat;
  /**
   * The identifiers of the requirements of the task's epic (`FR-1`, …). When
   * given, every `Covers:` entry must be one of them.
   */
  epicRequirements?: readonly string[];
}

const REQUIRED_SECTIONS: Record<WorkItemFormat, readonly string[]> = {
  epic: [EPIC_SECTIONS.problem, EPIC_SECTIONS.scope, EPIC_SECTIONS.requirements],
  story: [ACCEPTANCE_CRITERIA_SECTION],
  fix: [
    FIX_SECTIONS.current,
    FIX_SECTIONS.expected,
    FIX_SECTIONS.unchanged,
    ACCEPTANCE_CRITERIA_SECTION,
  ],
};

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
 * Every problem of a draft epic, story or fix, in document order of the checks:
 * missing sections, an empty criteria list, outcome criteria, unknown `Covers:`
 * entries and open questions. Empty when the draft is ready.
 */
export function lintWorkItem(text: string, options: LintOptions = {}): LintProblem[] {
  const item = parseWorkItem(text, options.format ?? workItemFormat(text) ?? "story");
  const problems: LintProblem[] = [];

  for (const name of REQUIRED_SECTIONS[item.format]) {
    const section = findSection(item.sections, name);
    if (!section) {
      problems.push({
        code: "missing-section",
        section: name,
        message: `The ${name} section is missing.`,
      });
    } else if (section.body === "" && name !== ACCEPTANCE_CRITERIA_SECTION) {
      problems.push({
        code: "missing-section",
        section: name,
        message: `The ${name} section is empty.`,
      });
    }
  }

  if (item.format === "epic") {
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
  }

  const criteria = findSection(item.sections, ACCEPTANCE_CRITERIA_SECTION);
  if (criteria && item.acceptanceCriteria.length === 0) {
    problems.push({
      code: "empty-acceptance-criteria",
      section: ACCEPTANCE_CRITERIA_SECTION,
      message: `The ${ACCEPTANCE_CRITERIA_SECTION} section lists no criterion.`,
    });
  }
  for (const criterion of item.acceptanceCriteria) {
    if (isOutcomeCriterion(criterion)) {
      problems.push({
        code: "outcome-criterion",
        section: ACCEPTANCE_CRITERIA_SECTION,
        item: criterion,
        message: `"${criterion}" is an outcome after merge or a metric, not evidence to check on the branch.`,
      });
    }
  }

  if (options.epicRequirements) {
    const known = new Set(options.epicRequirements.map((id) => id.trim().toUpperCase()));
    for (const entry of item.covers) {
      if (!known.has(entry.toUpperCase())) {
        problems.push({
          code: "unknown-requirement",
          item: entry,
          message: `${COVERS_LABEL}: names ${entry}, which the epic's requirements don't define.`,
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
