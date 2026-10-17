/**
 * Loads a delegated Linear issue as a ralph epic (ported from cyralph's
 * `src/linear/epic-loader.ts`; the pure builders live in `@omniralph/ralph`):
 *
 *  1. The issue has sub-issues         -> `children`: each sub-issue is a story. Only
 *                                         canceled ones (an epic turned back into a plain
 *                                         issue) don't count: it loads as below.
 *  2. It is a sub-issue itself         -> its parent's epic, focused on this story.
 *  3. Its description holds a PRD      -> `prd`: each PRD story is created as a sub-issue
 *                                         (priority, order, blocks relations, manual label),
 *                                         then the issue loads as `children`. With
 *                                         `completePrd`, a PRD issue that already has
 *                                         sub-issues (a materialization that failed half
 *                                         way) gets the missing ones, matched by title.
 *  4. Anything else                    -> `single`: the issue itself is the only story.
 */
import {
  childrenEpic,
  DEFAULT_MANUAL_LABELS,
  materializationPlan,
  parsePrd,
  prdEpic,
  singleIssueEpic,
  type Epic,
  type EpicOptions,
  type MaterializationPlan,
  type ParsedPrd,
} from "@omniralph/ralph";
import { getRepository, type Database } from "@omniralph/db";
import type { IssueSummary, LinearGateway } from "@/lib/linear/gateway";

export interface LoadedEpic {
  epic: Epic;
  /** The epic's own issue (the delegated issue, or its parent for a delegated sub-issue). */
  root: IssueSummary;
  /** `prd` when this load created the epic's sub-issues from its PRD, else the epic's kind. */
  kind: "children" | "prd" | "single";
  /** Linear issue ID of the delegated story, when a sub-issue of an epic was delegated. */
  focusStoryId?: string;
  /** Sub-issues created from the PRD during this load. */
  materialized: number;
}

export interface LoadEpicOptions {
  /**
   * Labels marking a story as a manual step; the first one labels materialized
   * manual stories. A function gets the epic's root issue (to route it first).
   */
  manualLabels?:
    readonly string[] | ((root: IssueSummary) => readonly string[] | Promise<readonly string[]>);
  /**
   * Read manual stories' ```cyralph-prepare blocks (default); off, they're
   * plain text. A function gets the epic's root issue.
   */
  allowPreparation?: boolean | ((root: IssueSummary) => boolean | Promise<boolean>);
  /**
   * Create the PRD stories a PRD issue with sub-issues is missing. Only for an
   * issue that was never run: a run's epic is what people curate afterwards.
   */
  completePrd?: boolean;
  /**
   * Create a PRD's stories as sub-issues (default). Off (a mention only reads
   * the epic for context), a PRD without sub-issues loads as a `prd` epic of
   * its PRD stories and nothing is created.
   */
  materialize?: boolean;
}

/**
 * The labels marking a repository's stories as manual (`ralph_settings.manualLabels`),
 * `manual` when none are set.
 */
export function repositoryManualLabels(repository: {
  ralphSettings: { manualLabels?: readonly string[] | null };
}): string[] {
  const labels = repository.ralphSettings.manualLabels?.filter((l) => l.trim()) ?? [];
  return labels.length > 0 ? [...labels] : [...DEFAULT_MANUAL_LABELS];
}

/** Whether a repository offers manual stories' preparation (`ralph_settings.allowPreparation`). */
export function repositoryAllowsPreparation(repository: {
  ralphSettings: { allowPreparation?: boolean | null };
}): boolean {
  return repository.ralphSettings.allowPreparation !== false;
}

/** The manual labels of a run's repository (`manual` when the repository is gone). */
export async function runManualLabels(
  db: Database,
  run: { repositoryId: string | null },
): Promise<string[]> {
  const repository = run.repositoryId ? await getRepository(db, run.repositoryId) : null;
  return repository ? repositoryManualLabels(repository) : [...DEFAULT_MANUAL_LABELS];
}

/** How a run's repository reads its epic: the manual labels and whether preparation is offered. */
export async function runEpicOptions(
  db: Database,
  run: { repositoryId: string | null },
): Promise<Pick<LoadEpicOptions, "manualLabels" | "allowPreparation">> {
  const repository = run.repositoryId ? await getRepository(db, run.repositoryId) : null;
  if (!repository) return { manualLabels: [...DEFAULT_MANUAL_LABELS] };
  return {
    manualLabels: repositoryManualLabels(repository),
    allowPreparation: repositoryAllowsPreparation(repository),
  };
}

async function epicOptionsFor(
  options: LoadEpicOptions,
  root: IssueSummary,
): Promise<Required<EpicOptions>> {
  const labels =
    typeof options.manualLabels === "function"
      ? await options.manualLabels(root)
      : options.manualLabels;
  const allowPreparation =
    typeof options.allowPreparation === "function"
      ? await options.allowPreparation(root)
      : options.allowPreparation;
  return {
    manualLabels: labels?.length ? labels : DEFAULT_MANUAL_LABELS,
    allowPreparation: allowPreparation !== false,
  };
}

/** The children epic of `parent`: its sub-issues with their blockers. */
async function loadChildrenEpic(
  linear: LinearGateway,
  parent: IssueSummary,
  children: readonly IssueSummary[],
  options: EpicOptions,
): Promise<Epic> {
  const stories = await Promise.all(
    children.map(async (issue) => ({ issue, blockers: await linear.getBlockers(issue.id) })),
  );
  return childrenEpic(parent, stories, options);
}

/**
 * Creates one sub-issue per PRD story: priority, sub-issue order and "blocks"
 * relations come from the PRD; stories that already pass are completed and
 * manual ones get the manual label. A story with the title of one of
 * `existing` (sub-issues created by an earlier, interrupted materialization)
 * isn't created again; relations are only added for new issues. Returns the
 * created issues.
 */
export function materializePrd(
  linear: LinearGateway,
  parent: IssueSummary,
  prd: ParsedPrd,
  manualLabel: string,
  existing: readonly IssueSummary[] = [],
): Promise<IssueSummary[]> {
  return createPlannedSubIssues(linear, parent, materializationPlan(prd), manualLabel, existing);
}

/**
 * Creates `plan`'s sub-issues of `parent` in order (the helper behind
 * `materializePrd`, also used by triage): priority, sub-issue order, project,
 * the manual label and completion, then the plan's "blocks" relations. Planned
 * issues titled like one of `existing` are reused, not created; relations are
 * only added for new issues. Returns the created issues, in plan order.
 */
export async function createPlannedSubIssues(
  linear: LinearGateway,
  parent: IssueSummary,
  plan: MaterializationPlan,
  manualLabel: string,
  existing: readonly IssueSummary[] = [],
): Promise<IssueSummary[]> {
  const byTitle = new Map(existing.map((issue) => [issue.title.trim(), issue]));
  const issues = new Map<string, IssueSummary>();
  const created = new Map<string, IssueSummary>();
  for (const planned of plan.issues) {
    const found = byTitle.get(planned.title.trim());
    if (found) {
      issues.set(planned.storyId, found);
      continue;
    }
    const issue = await linear.createIssue({
      teamId: parent.teamId,
      parentId: parent.id,
      title: planned.title,
      description: planned.description,
      priority: planned.priority,
      subIssueSortOrder: planned.subIssueSortOrder,
      ...(parent.projectName && { projectName: parent.projectName }),
      ...(planned.manual && { labels: [manualLabel] }),
    });
    issues.set(planned.storyId, issue);
    created.set(planned.storyId, issue);
    if (planned.completed) await linear.setIssueState(issue.id, { type: "completed" });
  }
  for (const { blocker, blocked } of plan.relations) {
    const from = issues.get(blocker);
    const to = issues.get(blocked);
    if (!from || !to || !(created.has(blocker) || created.has(blocked))) continue;
    await linear.createBlocksRelation(from.id, to.id);
  }
  return [...created.values()];
}

/** Loads the delegated issue `issueId` as an epic, materializing a PRD's stories first. */
export async function loadEpic(
  linear: LinearGateway,
  issueId: string,
  options: LoadEpicOptions = {},
): Promise<LoadedEpic> {
  const issue = await linear.getIssue(issueId);

  const children = await linear.getChildren(issue.id);
  if (children.some((child) => child.stateType !== "canceled")) {
    const epicOptions = await epicOptionsFor(options, issue);
    const prd = options.completePrd ? parsePrd(issue.description) : null;
    const created = prd
      ? await materializePrd(linear, issue, prd, epicOptions.manualLabels[0] ?? "manual", children)
      : [];
    if (created.length > 0) {
      const all = await linear.getChildren(issue.id);
      const epic = await loadChildrenEpic(linear, issue, all, epicOptions);
      return { epic, root: issue, kind: "prd", materialized: created.length };
    }
    const epic = await loadChildrenEpic(linear, issue, children, epicOptions);
    return { epic, root: issue, kind: "children", materialized: 0 };
  }

  // A sub-issue delegated on its own is one story of its parent's epic.
  if (issue.parentId) {
    const parent = await linear.getIssue(issue.parentId);
    const siblings = await linear.getChildren(parent.id);
    const epic = await loadChildrenEpic(
      linear,
      parent,
      siblings,
      await epicOptionsFor(options, parent),
    );
    return { epic, root: parent, kind: "children", focusStoryId: issue.id, materialized: 0 };
  }

  const prd = parsePrd(issue.description);
  if (prd && options.materialize === false) {
    return { epic: prdEpic(issue, prd), root: issue, kind: "prd", materialized: 0 };
  }
  if (prd) {
    const epicOptions = await epicOptionsFor(options, issue);
    const created = await materializePrd(
      linear,
      issue,
      prd,
      epicOptions.manualLabels[0] ?? "manual",
    );
    const epic = await loadChildrenEpic(
      linear,
      issue,
      await linear.getChildren(issue.id),
      epicOptions,
    );
    return { epic, root: issue, kind: "prd", materialized: created.length };
  }

  return { epic: singleIssueEpic(issue), root: issue, kind: "single", materialized: 0 };
}

/**
 * Re-reads a run's stories from Linear: the epic issue's sub-issues (in
 * request mode, its PRD's stories while it has none), or the issue itself for
 * a `single` run. Never creates issues.
 */
export async function reloadEpic(
  linear: LinearGateway,
  run: { linearIssueId: string; kind: "children" | "prd" | "single"; mode?: "epic" | "request" },
  options: LoadEpicOptions = {},
): Promise<Epic> {
  const issue = await linear.getIssue(run.linearIssueId);
  if (run.kind === "single") return singleIssueEpic(issue);
  const children = await linear.getChildren(issue.id);
  // A mention's PRD whose stories were never created: its PRD stories, for context.
  const prd = run.mode === "request" && children.length === 0 ? parsePrd(issue.description) : null;
  if (prd) return prdEpic(issue, prd);
  return loadChildrenEpic(linear, issue, children, await epicOptionsFor(options, issue));
}
