/**
 * Read a work item description written in one of the planning formats (an
 * epic, a story or a fix, see `../methodology/templates.ts`) into the parts the
 * loop works from. Text in no planning format (a legacy PRD, a plain issue)
 * parses to null, so the caller can fall back to its legacy parser.
 */
import type { WorkItemKind } from "../model.js";
import {
  ACCEPTANCE_CRITERIA_SECTION,
  COVERS_LABEL,
  EPIC_SECTIONS,
  FIX_SECTIONS,
  REQUIREMENT_PREFIX,
  type AuditRequirement,
} from "../methodology/templates.js";

/** The planning formats: an epic, a story (new work) or a fix (a bug). */
export type WorkItemFormat = "epic" | "story" | "fix";

/** An epic requirement (`FR-1: The system must …`). */
export type Requirement = AuditRequirement;

/** A `##` section of a work item. */
export interface WorkItemSection {
  /** The heading as written, without the `##`. */
  name: string;
  /** The text under the heading, trimmed. */
  body: string;
}

/** A work item description in one of the planning formats. */
export interface ParsedWorkItem {
  format: WorkItemFormat;
  /** What a task is (`fix` or `story`); absent for an epic. */
  kind?: WorkItemKind;
  /**
   * The work itself: the whole description for an epic, the text without the
   * `Covers:` line and the acceptance criteria for a story or a fix.
   */
  description: string;
  /** The items under `## Acceptance Criteria`, without their checkboxes. */
  acceptanceCriteria: string[];
  /** The requirement identifiers of the `Covers:` line, as written (`FR-2`), in order. */
  covers: string[];
  /** An epic's requirements, from `## Requirements`; empty for a task. */
  requirements: Requirement[];
  /** The text before the first `##` heading, trimmed. */
  lead: string;
  /** The `##` sections, in order. */
  sections: WorkItemSection[];
}

const EPIC_MARKERS = [EPIC_SECTIONS.problem, EPIC_SECTIONS.scope, EPIC_SECTIONS.requirements];
const FIX_MARKERS = [FIX_SECTIONS.current, FIX_SECTIONS.expected, FIX_SECTIONS.unchanged];

/** A section name as compared: no markdown escapes, trailing colon or case. */
export function sectionKey(name: string): string {
  return name
    .replace(/\\([\\`*_{}[\]()#+\-.!~|<>])/g, "$1")
    .replace(/[*_]/g, "")
    .replace(/:\s*$/, "")
    .trim()
    .toLowerCase();
}

/** The lead text and the `##` sections of a markdown text (fenced code is never a heading). */
export function splitSections(text: string): { lead: string; sections: WorkItemSection[] } {
  const sections: WorkItemSection[] = [];
  const lead: string[] = [];
  let current: { name: string; lines: string[] } | undefined;
  let fence: string | undefined;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const fenceMark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fenceMark) {
      if (!fence) fence = fenceMark;
      else if (fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = undefined;
    }
    const heading = fence || fenceMark ? undefined : /^ {0,3}##[ \t]+(.+?)[ \t#]*$/.exec(line)?.[1];
    if (heading !== undefined) {
      if (current) sections.push({ name: current.name, body: current.lines.join("\n").trim() });
      current = { name: heading.trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else lead.push(line);
  }
  if (current) sections.push({ name: current.name, body: current.lines.join("\n").trim() });
  return { lead: lead.join("\n").trim(), sections };
}

/** The body of the section named `name` (ignoring case), if the item has one. */
export function findSection(
  sections: readonly WorkItemSection[],
  name: string,
): WorkItemSection | undefined {
  const key = sectionKey(name);
  return sections.find((section) => sectionKey(section.name) === key);
}

function countSections(sections: readonly WorkItemSection[], names: readonly string[]): number {
  return names.filter((name) => findSection(sections, name)).length;
}

const COVERS_LINE = new RegExp(
  `^[ \\t]*(?:[-*+][ \\t]+)?(?:\\*\\*|__)?${COVERS_LABEL}(?:\\*\\*|__)?[ \\t]*:[ \\t]*(?:\\*\\*|__)?(.*)$`,
  "im",
);

/** The `Covers:` line of a text: the line itself and its entries, if there is one. */
function coversLine(text: string): { line: string; entries: string[] } | undefined {
  const match = COVERS_LINE.exec(text);
  if (!match) return undefined;
  const entries = (match[1] ?? "")
    .replace(/[*_`]/g, "")
    .split(/[,;]|\s+and\s+/i)
    .map((entry) => entry.trim().replace(/\.$/, ""))
    .filter((entry) => entry !== "" && !/^(none|n\/a|-)$/i.test(entry))
    .map((entry) => (requirementId(entry) ? entry.toUpperCase() : entry));
  return { line: match[0], entries };
}

const REQUIREMENT_ID = new RegExp(`^${REQUIREMENT_PREFIX}\\d+$`, "i");

/** Whether `text` is a requirement identifier (`FR-3`). */
export function requirementId(text: string): boolean {
  return REQUIREMENT_ID.test(text.trim());
}

const REQUIREMENT_LINE = new RegExp(
  `^\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?(?:\\[[ xX]\\]\\s+)?(?:\\*\\*|__)?(${REQUIREMENT_PREFIX}\\d+)(?:\\*\\*|__)?\\s*[:.)\\-–—]\\s*(?:\\*\\*|__)?\\s*(.+)$`,
  "i",
);

/** The requirements listed in a `## Requirements` section body. */
export function parseRequirements(body: string): Requirement[] {
  const requirements: Requirement[] = [];
  for (const line of body.split("\n")) {
    const match = REQUIREMENT_LINE.exec(line);
    if (match?.[1] && match[2]) {
      requirements.push({ id: match[1].toUpperCase(), text: match[2].trim() });
    }
  }
  return requirements;
}

/** The top-level list items of a section body (`- [ ] item`, `- item`), without checkboxes. */
export function parseCriteria(body: string): string[] {
  const criteria: string[] = [];
  for (const line of body.split("\n")) {
    const item = /^ ?(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(line)?.[1]?.trim();
    if (item) criteria.push(item);
  }
  return criteria;
}

/**
 * The planning format of a description, if it is in one:
 *
 * - an epic has two of `## Problem`, `## Scope` and `## Requirements`;
 * - a fix has two of `## Current behavior`, `## Expected behavior` and `## Unchanged behavior`;
 * - a story has a `Covers:` line before its first section, or opens with
 *   "As a … I want" and has `## Acceptance Criteria`.
 */
export function workItemFormat(text: string | null | undefined): WorkItemFormat | null {
  if (!text?.trim()) return null;
  const { lead, sections } = splitSections(text);
  return formatOf(lead, sections);
}

function formatOf(lead: string, sections: readonly WorkItemSection[]): WorkItemFormat | null {
  if (countSections(sections, EPIC_MARKERS) >= 2) return "epic";
  if (countSections(sections, FIX_MARKERS) >= 2) return "fix";
  if (coversLine(lead)) return "story";
  if (
    /^As an?\b[\s\S]*?\bI want\b/i.test(lead) &&
    findSection(sections, ACCEPTANCE_CRITERIA_SECTION)
  )
    return "story";
  return null;
}

/** Whether a description is in one of the planning formats (else: a legacy PRD or plain text). */
export function isPlanningFormat(text: string | null | undefined): boolean {
  return workItemFormat(text) !== null;
}

/**
 * A description in one of the planning formats, read into its parts; null when
 * it is in none (see `workItemFormat`). Pass `format` to read a draft as that
 * format even when it lacks the sections that would identify it.
 */
export function parseWorkItem(
  text: string | null | undefined,
  format: WorkItemFormat,
): ParsedWorkItem;
export function parseWorkItem(
  text: string | null | undefined,
  format?: WorkItemFormat,
): ParsedWorkItem | null;
export function parseWorkItem(
  text: string | null | undefined,
  format?: WorkItemFormat,
): ParsedWorkItem | null {
  const source = (text ?? "").replace(/\r\n/g, "\n").trim();
  const { lead, sections } = splitSections(source);
  const detected = format ?? formatOf(lead, sections);
  if (!detected) return null;

  const criteriaSection = findSection(sections, ACCEPTANCE_CRITERIA_SECTION);
  const acceptanceCriteria = criteriaSection ? parseCriteria(criteriaSection.body) : [];
  const covers = coversLine(lead);
  const requirementsSection = findSection(sections, EPIC_SECTIONS.requirements);

  if (detected === "epic") {
    return {
      format: "epic",
      description: source,
      acceptanceCriteria,
      covers: covers?.entries ?? [],
      requirements: requirementsSection ? parseRequirements(requirementsSection.body) : [],
      lead,
      sections,
    };
  }

  const leadText = covers ? removeLine(lead, covers.line) : lead;
  const parts = [
    leadText,
    ...sections
      .filter((section) => section !== criteriaSection)
      .map((section) => `## ${section.name}\n\n${section.body}`.trim()),
  ].filter((part) => part !== "");
  return {
    format: detected,
    kind: detected,
    description: parts.join("\n\n"),
    acceptanceCriteria,
    covers: covers?.entries ?? [],
    requirements: [],
    lead,
    sections,
  };
}

function removeLine(text: string, line: string): string {
  return text
    .split("\n")
    .filter((l) => l !== line)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
