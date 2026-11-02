/**
 * Turn tracker work items into a ralph epic (the pure part of cyralph's epic loader; the caller
 * fetches the issues). Detection order:
 *
 *  1. Issue has child issues           -> "children" epic: each child is a story (`childrenEpic`).
 *  2. Description contains a PRD       -> "prd" epic (`prdEpic`), or materialized into sub-issues
 *     (markdown user stories or prd.json)  (`materializationPlan`) and then loaded as a children epic.
 *  3. Otherwise                        -> "single" epic: the issue itself is the only story.
 *
 * A delegated *story* issue (child of an epic) yields that epic, focused on the one story.
 *
 * Stories are described by the tracker's own fields only: identifier, title, priority, child order,
 * state, labels and "blocks" relations. Title prefixes (`US-001: …`) and body metadata are not parsed.
 *
 * A description in one of the planning formats (an epic, story or fix, see `@omniralph/planning`)
 * is read with `parseWorkItem`; any other is read as before, as a legacy PRD or story body.
 */
import {
  parseCriteria,
  parseRequirements,
  parseWorkItem,
  workItemFormat,
} from "@omniralph/planning";
import { type ParsedPrd, parseBranchLine, parsePrd, prdQualityGates } from "./prd.js";
import {
  buildStoryIssueBody,
  trackerPriorityFor,
  parseStoryBody,
  storyRank,
  stripLegacyMetadata,
  type StoryBody,
} from "./story-body.js";
import { EXTERNAL_DEP_PREFIX, type Epic, type Story, type StoryStatus } from "./types.js";

/** The fields of a tracker work item an epic is built from. */
export interface EpicIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url?: string;
  /** The tracker's suggested branch name. */
  branchName: string;
  teamId?: string;
  teamKey?: string;
  /** Workflow state type: `backlog`, `unstarted`, `started`, `completed`, `canceled`, … */
  stateType: string;
  labels: string[];
  /** Tracker priority: 0 No priority, 1 Urgent … 4 Low. */
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

/** Whether a workflow state type counts as done (completed or canceled). */
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

/**
 * The legacy PRD of a description (markdown user stories or prd.json), or null. A description in
 * one of the planning formats is never read as one: it has no PRD stories and no PRD quality gates.
 */
export function parseLegacyPrd(text: string | undefined | null): ParsedPrd | null {
  return workItemFormat(text) ? null : parsePrd(text);
}

/** An epic requirement an audit checks (`FR-1` and its text). */
export interface EpicRequirement {
  id: string;
  text: string;
}

const FUNCTIONAL_REQUIREMENTS = /^##\s+Functional Requirements\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/im;

/**
 * The requirements an epic's description lists: a planning-format epic's `## Requirements`,
 * else a legacy PRD's `## Functional Requirements` (its `FR-n:` lines, or each list item
 * numbered `FR-1`, `FR-2`... when none has an identifier). Empty when it has neither.
 */
export function epicRequirements(text: string | undefined | null): EpicRequirement[] {
  const item = parseWorkItem(text);
  if (item?.format === "epic") return item.requirements;
  if (item) return [];
  const source = (text ?? "").replace(/\r\n/g, "\n");
  const body = /\[PRD\]([\s\S]*?)\[\/PRD\]/.exec(source)?.[1] ?? source;
  const section = FUNCTIONAL_REQUIREMENTS.exec(body)?.[1]?.trim();
  if (!section) return [];
  const listed = parseRequirements(section);
  if (listed.length > 0) return listed;
  return parseCriteria(section).map((text, i) => ({ id: `FR-${i + 1}`, text }));
}

/** What a story's work item body says: a story or fix in the planning formats, else a legacy body. */
export interface StoryIssueBody extends StoryBody {
  kind?: "fix" | "story";
  covers?: string[];
}

/**
 * A story work item's body: a new-format story or fix (`parseWorkItem`: its kind and `Covers:`
 * requirements too), else the legacy body (`parseStoryBody`). A body in the epic format is a legacy
 * body here: a story is a task. A legacy `## Ralph Metadata` section is never part of the story.
 */
export function storyIssueBody(text: string | undefined | null): StoryIssueBody {
  const legacy = parseStoryBody(text);
  const item = parseWorkItem(stripLegacyMetadata(text ?? ""));
  if (!item || item.format === "epic") return legacy;
  return {
    description: item.description,
    acceptanceCriteria: item.acceptanceCriteria,
    kind: item.format,
    ...(item.covers.length > 0 && { covers: item.covers }),
    ...(legacy.legacyRalphPriority !== undefined && {
      legacyRalphPriority: legacy.legacyRalphPriority,
    }),
  };
}

/** The fields of a story that come straight from its work item. */
function issueStory(issue: EpicIssue, body = storyIssueBody(issue.description)) {
  return {
    key: issue.id,
    storyId: issue.identifier,
    title: issue.title.trim(),
    description: body.description,
    acceptanceCriteria: body.acceptanceCriteria,
    ...(body.kind !== undefined && { kind: body.kind }),
    ...(body.covers !== undefined && { covers: body.covers }),
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
  return withManualOptions(
    { ...issueStory(issue), dependsOn, status: statusFromStateType(issue.stateType) },
    opts,
  );
}

/**
 * `story` (of a sub-issue) read with `opts`: manual when one of its labels is
 * one of `opts.manualLabels`, with the preparation of its description when
 * manual and `opts.allowPreparation` isn't off. Used again once a story is
 * routed to a repository whose manual labels and preparation setting differ.
 */
export function withManualOptions<S extends Story>(story: S, opts: EpicOptions): S {
  const { manual: _manual, preparation: _preparation, ...rest } = story;
  const manual = isManualIssue({ labels: story.labels ?? [] }, opts.manualLabels);
  // Preparation is only ever offered for manual stories: blocks anywhere else are plain text.
  const preparation =
    manual && opts.allowPreparation !== false
      ? parsePrepareBlocks(stripLegacyMetadata(story.sourceText ?? ""))
      : [];
  return {
    ...rest,
    ...(manual && { manual: true }),
    ...(preparation.length > 0 && { preparation }),
  } as S;
}

/** The branch an epic builds on: the PRD's branch name, else a `Branch:` line, else the tracker's suggestion. */
export function epicBranchName(
  issue: Pick<EpicIssue, "description" | "branchName">,
  prd: ParsedPrd | null = parseLegacyPrd(issue.description),
): string {
  return prd?.branchName || parseBranchLine(issue.description) || issue.branchName;
}

function epicBase(issue: EpicIssue, prd: ParsedPrd | null): Omit<Epic, "kind" | "stories"> {
  const item = parseWorkItem(issue.description);
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
    ...(item?.format === "epic" && { requirements: item.requirements }),
    ...epicQualityGates(issue.description, prd, item !== null),
  };
}

/**
 * The PRD quality gates of an epic: none for a description in the planning formats (its stories
 * run only the repo's checks), else the legacy PRD's `## Quality Gates`.
 */
function epicQualityGates(
  description: string,
  prd: ParsedPrd | null,
  planningFormat: boolean,
): Pick<Epic, "qualityGates" | "repositoryQualityGates"> {
  if (planningFormat) return { qualityGates: [] };
  if (prd?.qualityGates.length || prd?.repositoryQualityGates) {
    return {
      qualityGates: prd.qualityGates,
      ...(prd.repositoryQualityGates && { repositoryQualityGates: prd.repositoryQualityGates }),
    };
  }
  return prdQualityGates(description);
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
    ...epicBase(parent, parseLegacyPrd(parent.description)),
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
    stories: [{ ...issueStory(issue), dependsOn: [], status: "open" }],
  };
}

/** A sub-issue to create for a PRD story. */
export interface PlannedStoryIssue {
  /** The PRD story id (e.g. `US-001`); not written to the tracker. */
  storyId: string;
  title: string;
  description: string;
  /** Tracker priority (1 Urgent … 4 Low). */
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
 * The child work items to create for a PRD's stories. Its ids, priorities and order become
 * tracker metadata: priority, sub-issue order and "blocks" relations. Titles and bodies carry no ralph markers.
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
      priority: trackerPriorityFor(s.priority),
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
