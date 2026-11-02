/**
 * Read a work item description written in one of the planning formats (an
 * epic, or a three-paragraph task, see `../methodology/templates.ts`) into the
 * parts the loop works from. Text in no planning format (a legacy PRD, a plain
 * issue, a task in the interim Story or Fix format) parses to null, so the
 * caller can fall back to its legacy parser.
 */
import { workItemKind, type WorkItemKind } from "../model.js";
import { EPIC_SECTIONS, REQUIREMENT_PREFIX, TASK_PARAGRAPHS } from "../methodology/templates.js";

/** The planning formats: an epic, or a task (a Story or a Fix, by its labels). */
export type WorkItemFormat = "epic" | "task";

/** The three paragraphs of a task, by the name of their opening in `TASK_PARAGRAPHS`. */
export type TaskParagraphName = keyof typeof TASK_PARAGRAPHS;

/** The paragraphs of a task in order. */
export const TASK_PARAGRAPH_NAMES: readonly TaskParagraphName[] = ["build", "approach", "done"];

/** An epic requirement (`FR-1: The system must …`). */
export interface Requirement {
  /** The identifier, e.g. `FR-1`. */
  id: string;
  /** What the system must do. */
  text: string;
}

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
  /** What a task is (`fix` or `story`, from its labels); absent for an epic. */
  kind?: WorkItemKind;
  /**
   * The work itself: the whole description for an epic, paragraph 1 ("I want
   * you to …") for a task.
   */
  description: string;
  /** How to build it: a task's paragraph 2 ("Build it by …"); empty for an epic. */
  approach: string;
  /** A task's paragraph 3 ("Don't stop until …") as written; empty for an epic. */
  done: string;
  /**
   * A task's done criteria, from paragraph 3: one per list item, or one per
   * sentence when it is prose. Empty for an epic.
   */
  acceptanceCriteria: string[];
  /** The task paragraphs the text has, by name (a draft may lack some); empty for an epic. */
  paragraphs: Partial<Record<TaskParagraphName, string>>;
  /** An epic's requirements, from `## Requirements`; empty for a task. */
  requirements: Requirement[];
  /** The text before the first `##` heading, trimmed. */
  lead: string;
  /** The `##` sections, in order. */
  sections: WorkItemSection[];
}

const EPIC_MARKERS = [EPIC_SECTIONS.problem, EPIC_SECTIONS.scope, EPIC_SECTIONS.requirements];

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

/** A regular expression source matching `text` literally, with any apostrophe as ' or ’. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['’]");
}

/** A line opening a task paragraph: its opening words, maybe bold, at the start of the line. */
const PARAGRAPH_OPENINGS = Object.fromEntries(
  TASK_PARAGRAPH_NAMES.map((name) => [
    name,
    new RegExp(`^ {0,3}(?:\\*\\*|__)?${literal(TASK_PARAGRAPHS[name].opening)}\\b`, "i"),
  ]),
) as Record<TaskParagraphName, RegExp>;

/**
 * The task paragraphs of a text (a task's lead, before any `##` section): each
 * runs from the line that opens with its words to the next one that opens a
 * later paragraph. Only openings in order count; the text before the first is
 * returned as `before`.
 */
function taskParagraphs(text: string): {
  paragraphs: Partial<Record<TaskParagraphName, string>>;
  before: string;
} {
  const paragraphs: Partial<Record<TaskParagraphName, string>> = {};
  const before: string[] = [];
  let current: { name: TaskParagraphName; lines: string[] } | undefined;
  let next = 0;
  const close = () => {
    if (current) paragraphs[current.name] = current.lines.join("\n").trim();
  };
  for (const line of text.split("\n")) {
    const index = TASK_PARAGRAPH_NAMES.findIndex(
      (name, i) => i >= next && PARAGRAPH_OPENINGS[name].test(line),
    );
    if (index >= 0) {
      close();
      current = { name: TASK_PARAGRAPH_NAMES[index]!, lines: [line] };
      next = index + 1;
      continue;
    }
    if (current) current.lines.push(line);
    else before.push(line);
  }
  close();
  return { paragraphs, before: before.join("\n").trim() };
}

/** Whether a text's lead is a task: it opens with "I want you to" and has another opening after it. */
function isTask(lead: string): boolean {
  const { paragraphs, before } = taskParagraphs(lead);
  return before === "" && paragraphs.build !== undefined && Object.keys(paragraphs).length >= 2;
}

/** The text of a paragraph without its opening words (and a colon right after them). */
function withoutOpening(paragraph: string, name: TaskParagraphName): string {
  const opening = new RegExp(
    `^ {0,3}(?:\\*\\*|__)?${literal(TASK_PARAGRAPHS[name].opening)}(?:\\*\\*|__)?[ \\t]*:?`,
    "i",
  );
  return paragraph.replace(opening, "").trim();
}

/** The sentences of a prose text, never split inside a code span or after an abbreviation. */
export function splitSentences(text: string): string[] {
  const prose = text.replace(/\s+/g, " ").trim();
  const sentences: string[] = [];
  let start = 0;
  let code = false;
  for (let i = 0; i < prose.length; i++) {
    const char = prose[i];
    if (char === "`") code = !code;
    if (code || !".!?".includes(char!)) continue;
    const rest = prose.slice(i + 1);
    // A sentence ends at . ! or ? (and closing quotes or brackets) before a space and a capital.
    const end = /^["')\]’”]*(?= +["'([`*_‘“]*[A-Z0-9])/.exec(rest);
    if (!end) continue;
    const word = /(\S+)$/.exec(prose.slice(start, i + 1))?.[1] ?? "";
    if (/^(?:e\.g|i\.e|etc|vs|cf|approx|incl)\.$/i.test(word)) continue;
    sentences.push(prose.slice(start, i + 1 + end[0].length).trim());
    start = i + 1 + end[0].length;
  }
  sentences.push(prose.slice(start).trim());
  return sentences.filter((sentence) => sentence !== "");
}

/**
 * The done criteria of a task's paragraph 3: its list items when it has any,
 * else each sentence of its prose. The opening words are not part of a
 * criterion, and a sentence that is only them ("Don't stop until:") is none.
 */
export function parseDoneCriteria(paragraph: string): string[] {
  const listed = parseCriteria(paragraph);
  if (listed.length > 0) return listed;
  const text = withoutOpening(paragraph, "done").replace(/^[,:;\s]+/, "");
  return splitSentences(text)
    .map((sentence, i) => (i === 0 ? capitalize(sentence) : sentence))
    .filter((sentence) => /[\p{L}\p{N}]/u.test(sentence));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The planning format of a description, if it is in one:
 *
 * - an epic has two of `## Problem`, `## Scope` and `## Requirements`;
 * - a task opens with "I want you to" and has a "Build it by" or a "Don't stop
 *   until" paragraph after it.
 *
 * The interim Story ("As a … I want …", `Covers:`) and Fix (`## Current
 * behavior`, …) formats are none.
 */
export function workItemFormat(text: string | null | undefined): WorkItemFormat | null {
  if (!text?.trim()) return null;
  const { lead, sections } = splitSections(text);
  return formatOf(lead, sections);
}

function formatOf(lead: string, sections: readonly WorkItemSection[]): WorkItemFormat | null {
  if (countSections(sections, EPIC_MARKERS) >= 2) return "epic";
  if (isTask(lead)) return "task";
  return null;
}

/** Whether a description is in one of the planning formats (else: a legacy PRD or plain text). */
export function isPlanningFormat(text: string | null | undefined): boolean {
  return workItemFormat(text) !== null;
}

/** How to read a work item description. */
export interface ParseWorkItemOptions {
  /** Read a draft as this format even when it lacks what would identify it. */
  format?: WorkItemFormat;
  /** The work item's labels: a task is a Fix when one of them is a fix label, else a Story. */
  labels?: readonly string[];
  /** The tracker's fix labels (default `DEFAULT_FIX_LABELS`). */
  fixLabels?: readonly string[];
}

/**
 * A description in one of the planning formats, read into its parts; null when
 * it is in none (see `workItemFormat`). With `format`, a draft is read as that
 * format even when it lacks what would identify it.
 */
export function parseWorkItem(
  text: string | null | undefined,
  options: ParseWorkItemOptions & { format: WorkItemFormat },
): ParsedWorkItem;
export function parseWorkItem(
  text: string | null | undefined,
  options?: ParseWorkItemOptions,
): ParsedWorkItem | null;
export function parseWorkItem(
  text: string | null | undefined,
  options: ParseWorkItemOptions = {},
): ParsedWorkItem | null {
  const source = (text ?? "").replace(/\r\n/g, "\n").trim();
  const { lead, sections } = splitSections(source);
  const detected = options.format ?? formatOf(lead, sections);
  if (!detected) return null;

  if (detected === "epic") {
    const requirementsSection = findSection(sections, EPIC_SECTIONS.requirements);
    return {
      format: "epic",
      description: source,
      approach: "",
      done: "",
      acceptanceCriteria: [],
      paragraphs: {},
      requirements: requirementsSection ? parseRequirements(requirementsSection.body) : [],
      lead,
      sections,
    };
  }

  const { paragraphs } = taskParagraphs(lead);
  const done = paragraphs.done ?? "";
  return {
    format: "task",
    kind: workItemKind(options.labels ?? [], options.fixLabels),
    description: paragraphs.build ?? "",
    approach: paragraphs.approach ?? "",
    done,
    acceptanceCriteria: done ? parseDoneCriteria(done) : [],
    paragraphs,
    requirements: [],
    lead,
    sections,
  };
}
