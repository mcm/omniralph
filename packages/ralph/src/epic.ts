/**
 * Turn Linear issues into a ralph epic (the pure part of cyralph's epic loader; the caller
 * fetches the issues). Detection order:
 *
 *  1. Issue has sub-issues             -> "children" epic: each sub-issue is a story (`childrenEpic`).
 *  2. Description contains a PRD       -> "prd" epic (`prdEpic`), or materialized into sub-issues
 *     (markdown user stories or prd.json)  (`materializationPlan`) and then loaded as a children epic.
 *  3. Otherwise                        -> "single" epic: the issue itself is the only story.
 *
 * A delegated *story* issue (sub-issue of an epic) yields that epic, focused on the one story.
 *
 * Stories are described by Linear's own fields only: identifier, title, priority, sub-issue order,
 * state, labels and "blocks" relations. Title prefixes (`US-001: …`) and body metadata are not parsed.
 */
import { type ParsedPrd, parseBranchLine, parsePrd, parseQualityGates } from "./prd.js";
import {
  buildStoryIssueBody,
  linearPriorityFor,
  parseStoryBody,
  storyRank,
  stripLegacyMetadata,
} from "./story-body.js";
import { EXTERNAL_DEP_PREFIX, type Epic, type Story, type StoryStatus } from "./types.js";

/** The fields of a Linear issue an epic is built from. */
export interface EpicIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url?: string;
  /** Linear's suggested branch name. */
  branchName: string;
  teamId?: string;
  teamKey?: string;
  /** Workflow state type: `backlog`, `unstarted`, `started`, `completed`, `canceled`, … */
  stateType: string;
  labels: string[];
  /** Linear priority: 0 No priority, 1 Urgent … 4 Low. */
  priority?: number;
  /** Manual position among its parent's sub-issues. */
  subIssueSortOrder?: number;
  projectName?: string;
  parentId?: string;
}

/** An issue blocking another ("blocks" relation). */
export interface IssueBlocker {
  id: string;
  identifier: string;
  stateType: string;
}

/** Labels marking a story issue as a manual step when none are configured. */
export const DEFAULT_MANUAL_LABELS = ["manual"];

const DONE_TYPES = new Set(["completed", "canceled"]);

/** Whether a Linear workflow state type counts as done (completed or canceled). */
export function isDoneStateType(stateType: string): boolean {
  return DONE_TYPES.has(stateType);
}

export function statusFromStateType(stateType: string): StoryStatus {
  switch (stateType) {
    case "completed":
      return "completed";
    case "canceled":
      return "cancelled";
    case "started":
      return "in_progress";
    default:
      return "open";
  }
}

export function isManualIssue(
  issue: Pick<EpicIssue, "labels">,
  manualLabels: readonly string[] = DEFAULT_MANUAL_LABELS,
): boolean {
  const wanted = new Set(manualLabels.map((l) => l.toLowerCase()));
  return issue.labels.some((l) => wanted.has(l.toLowerCase()));
}

const PREPARE_INFO = "cyralph-prepare";

/**
 * The commands in every ```cyralph-prepare fenced block of a markdown text, in order: one per non-empty
 * line, trimmed. Fences follow CommonMark (``` or ~~~, at least three, closed by the same character at
 * least as long); an unclosed block runs to the end of the text.
 */
export function parsePrepareBlocks(text: string): string[] {
  const commands: string[] = [];
  let fence: { char: string; length: number; prepare: boolean } | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!fence) {
      const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
      if (open?.[1]) {
        fence = {
          char: open[1][0] ?? "`",
          length: open[1].length,
          prepare: open[2]?.toLowerCase() === PREPARE_INFO,
        };
      }
      continue;
    }
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (close?.[1] && close[1][0] === fence.char && close[1].length >= fence.length) {
      fence = undefined;
      continue;
    }
    const command = line.trim();
    if (fence.prepare && command) commands.push(command);
  }
  return commands;
}

/** The fields of a story that come straight from its Linear issue. */
function linearStory(issue: EpicIssue, body = parseStoryBody(issue.description)) {
  return {
    key: issue.id,
    storyId: issue.identifier,
    title: issue.title.trim(),
    description: body.description,
    acceptanceCriteria: body.acceptanceCriteria,
    priority: storyRank(issue.priority, body.legacyRalphPriority),
    ...(issue.subIssueSortOrder !== undefined && { sortOrder: issue.subIssueSortOrder }),
    issueId: issue.id,
    identifier: issue.identifier,
    ...(issue.url !== undefined && { url: issue.url }),
    sourceText: issue.description,
    ...(issue.projectName !== undefined && { projectName: issue.projectName }),
    ...(issue.teamKey !== undefined && { teamKey: issue.teamKey }),
    labels: issue.labels,
  };
}

/** A sub-issue of an epic with the issues blocking it. */
export interface StoryIssue {
  issue: EpicIssue;
  blockers: readonly IssueBlocker[];
}

export interface EpicOptions {
  /** Labels marking a story issue as a manual step (case-insensitive). */
  manualLabels?: readonly string[];
  /**
   * Read manual stories' ```cyralph-prepare blocks as preparation commands
   * (default). Off (`allowPreparation: false`), they're plain text.
   */
  allowPreparation?: boolean;
}

function storyFromIssue(
  { issue, blockers }: StoryIssue,
  epicKeys: ReadonlySet<string>,
  external: Record<string, string>,
  opts: EpicOptions,
): Story {
  const dependsOn: string[] = [];
  for (const b of blockers) {
    if (epicKeys.has(b.id)) dependsOn.push(b.id);
    // External blockers only matter while they are still open.
    else if (!isDoneStateType(b.stateType)) {
      dependsOn.push(`${EXTERNAL_DEP_PREFIX}${b.id}`);
      external[b.id] = b.identifier;
    }
  }
  const manual = isManualIssue(issue, opts.manualLabels);
  // Preparation is only ever offered for manual stories: blocks anywhere else are plain text.
  const preparation =
    manual && opts.allowPreparation !== false
      ? parsePrepareBlocks(stripLegacyMetadata(issue.description))
      : [];
  return {
    ...linearStory(issue),
    dependsOn,
    status: statusFromStateType(issue.stateType),
    ...(manual && { manual: true }),
    ...(preparation.length > 0 && { preparation }),
  };
}

/** The branch an epic builds on: the PRD's branch name, else a `Branch:` line, else Linear's suggestion. */
export function epicBranchName(
  issue: Pick<EpicIssue, "description" | "branchName">,
  prd: ParsedPrd | null = parsePrd(issue.description),
): string {
  return prd?.branchName || parseBranchLine(issue.description) || issue.branchName;
}

function epicBase(issue: EpicIssue, prd: ParsedPrd | null): Omit<Epic, "kind" | "stories"> {
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    title: prd?.name && prd.name !== "Untitled PRD" ? prd.name : issue.title,
    // The full PRD document is the epic's context in every story prompt.
    description: issue.description || prd?.description || "",
    ...(issue.url !== undefined && { url: issue.url }),
    ...(issue.teamId !== undefined && { teamId: issue.teamId }),
    ...(issue.projectName !== undefined && { projectName: issue.projectName }),
    ...(issue.teamKey !== undefined && { teamKey: issue.teamKey }),
    branchName: epicBranchName(issue, prd),
    qualityGates: prd?.qualityGates.length
      ? prd.qualityGates
      : parseQualityGates(issue.description),
  };
}

/** A parent issue with sub-issues: each sub-issue is a story. */
export function childrenEpic(
  parent: EpicIssue,
  children: readonly StoryIssue[],
  opts: EpicOptions = {},
): Epic {
  const keys = new Set(children.map((c) => c.issue.id));
  const externalIssues: Record<string, string> = {};
  const stories = children.map((c) => storyFromIssue(c, keys, externalIssues, opts));
  return {
    ...epicBase(parent, parsePrd(parent.description)),
    kind: "children",
    stories,
    externalIssues,
  };
}

/** A PRD issue whose stories live only in its description (not materialized). */
export function prdEpic(issue: EpicIssue, prd: ParsedPrd): Epic {
  const stories: Story[] = prd.stories.map((s) => ({
    key: s.id,
    storyId: s.id,
    title: s.title,
    description: s.description,
    acceptanceCriteria: s.acceptanceCriteria,
    priority: s.priority,
    dependsOn: s.dependsOn,
    status: s.passes ? "completed" : "open",
    ...(s.notes !== undefined && { notes: s.notes }),
  }));
  return { ...epicBase(issue, prd), kind: "prd", stories };
}

/** A plain issue: the issue itself is the only story. */
export function singleIssueEpic(issue: EpicIssue): Epic {
  return {
    ...epicBase(issue, null),
    kind: "single",
    // The delegated issue is the work item; never treat it as already done.
    stories: [{ ...linearStory(issue), dependsOn: [], status: "open" }],
  };
}

/** A sub-issue to create for a PRD story. */
export interface PlannedStoryIssue {
  /** The PRD story id (e.g. `US-001`); not written to Linear. */
  storyId: string;
  title: string;
  description: string;
  /** Linear priority (1 Urgent … 4 Low). */
  priority: number;
  subIssueSortOrder: number;
  /** The story already passes (prd.json `passes`): create it completed. */
  completed: boolean;
  /** A step for a person: create it with the manual label. */
  manual: boolean;
}

export interface MaterializationPlan {
  issues: PlannedStoryIssue[];
  /** "blocks" relations between the planned issues, by PRD story id. */
  relations: Array<{ blocker: string; blocked: string }>;
}

/**
 * The sub-issues to create for a PRD's stories. Its ids, priorities and order become Linear
 * metadata: priority, sub-issue order and "blocks" relations. Titles and bodies carry no ralph markers.
 */
export function materializationPlan(prd: ParsedPrd): MaterializationPlan {
  const ids = new Set(prd.stories.map((s) => s.id));
  return {
    issues: prd.stories.map((s, i) => ({
      storyId: s.id,
      title: s.title,
      description: buildStoryIssueBody({
        description: s.description,
        acceptanceCriteria: s.acceptanceCriteria,
      }),
      priority: linearPriorityFor(s.priority),
      subIssueSortOrder: i,
      completed: s.passes,
      manual: s.manual === true,
    })),
    relations: prd.stories.flatMap((s) =>
      s.dependsOn.filter((dep) => ids.has(dep)).map((dep) => ({ blocker: dep, blocked: s.id })),
    ),
  };
}

/**
 * Open issues blocking the epic issue itself (or the plain issue, for single-issue epics), from
 * its blockers. Its own stories never count: "parent blocked by child" just means "do the children first".
 */
export function openRootBlockers(
  epic: Epic,
  blockers: readonly IssueBlocker[],
): Array<{ id: string; identifier: string }> {
  const own = new Set(epic.stories.map((s) => s.issueId).filter(Boolean));
  return blockers
    .filter((b) => !own.has(b.id) && !isDoneStateType(b.stateType))
    .map(({ id, identifier }) => ({ id, identifier }));
}
