import "server-only";
import {
  latestTriageSizes,
  listLatestIssueRuns,
  listRoutingRepositories,
  listRoutingRules,
  listWorkItemMatches,
  listWorkItemOverrides,
  workItemUrlId,
  type Database,
  type Repository,
  type RoutingRule,
  type WorkItemMatchFields,
} from "@omniralph/db";
import { isRoutingGroup, type RoutingQuery } from "@omniralph/shared";
import type { Backlog, BacklogCounts, BacklogQuery, BacklogUpNext } from "@/lib/api/backlog";
import { workItemSourceValue, type WorkItemRow } from "@/lib/api/work-items";
import type { ScopedOrganization } from "@/lib/api/scope";
import { createRouter, type RouteWorkItemMatch } from "@/lib/routing/resolve";
import { cachedBacklog } from "./backlog-cache";
import { getWorkItemTracker } from "./get-tracker";
import { groupFor } from "./group";
import {
  LIST_CANDIDATES_MAX_LIMIT,
  TrackerNotConnectedError,
  type ListCandidatesInput,
  type WorkItem,
  type WorkItemRouting,
  type WorkItemTracker,
} from "./tracker";

/**
 * The Backlog: every top-level work item that routes to a repo with Coding on (or that routing
 * can't decide, a tie), is Ready to start or Needs refining by its tracker's state mapping,
 * has no run and isn't delegated to another agent. One organization's list is computed once
 * (`loadOrganizationBacklog`) and kept in the Backlog cache, which the list, its counts and
 * Up next all read.
 */

/** Most candidates read per organization; past it the list is cut (`truncated`). */
export const BACKLOG_CANDIDATE_CAP = 500;

/** Up next's rows per group. */
export const UP_NEXT_READY = 3;
export const UP_NEXT_REFINING = 2;

/** One tracker query for candidates: the conditions of a work item match or a rule's team. */
export type CandidateFilter = Pick<
  ListCandidatesInput,
  "teamKey" | "projectName" | "withoutProject" | "labelNames"
>;

/** A listed item of one organization, as the cache keeps it (its organization added on read). */
export interface BacklogEntry {
  row: Omit<WorkItemRow, "organization">;
  /** The tracker priority: 0 No priority, 1 Urgent … 4 Low. */
  priority: number;
  /** ISO 8601. */
  updatedAt: string;
}

/** One organization's Backlog, in list order. */
export interface OrganizationBacklog {
  entries: BacklogEntry[];
  /** More than `BACKLOG_CANDIDATE_CAP` candidates: the list is cut. */
  truncated: boolean;
  /**
   * False when nothing picks up work items (no work item match or routing rule of a
   * connected repo with Coding on), so the tracker wasn't asked; absent means something does.
   */
  picksUp?: boolean;
}

/**
 * The team a rule's top-level "Team is" condition names (the team key), else null (the rule
 * may match any team). Only a condition the whole rule requires counts: in an "and" group
 * (or a group of that one condition) that isn't negated.
 */
export function ruleTeam(query: RoutingQuery): string | null {
  if (query.not) return null;
  if (query.combinator !== "and" && query.rules.length !== 1) return null;
  for (const rule of query.rules) {
    if (isRoutingGroup(rule)) continue;
    if (rule.field === "team" && rule.operator === "=" && typeof rule.value === "string") {
      return rule.value;
    }
  }
  return null;
}

const lower = (value: string | undefined) => value?.toLowerCase();

/** Whether every item `narrow` lists, `wide` lists too. */
function covers(wide: CandidateFilter, narrow: CandidateFilter): boolean {
  if (wide.teamKey !== undefined && lower(wide.teamKey) !== lower(narrow.teamKey)) return false;
  if (wide.projectName !== undefined && lower(wide.projectName) !== lower(narrow.projectName)) {
    return false;
  }
  if (wide.withoutProject && !narrow.withoutProject) return false;
  if (wide.labelNames?.length) {
    // `wide` takes any of its labels: `narrow` must want only labels among them.
    if (!narrow.labelNames?.length) return false;
    const wanted = new Set(wide.labelNames.map((name) => name.toLowerCase()));
    if (!narrow.labelNames.every((name) => wanted.has(name.toLowerCase()))) return false;
  }
  return true;
}

/**
 * The tracker queries that find an organization's candidates: one per work item match of a
 * connected repo with Coding on (its team, project or "no project", and labels), and one per
 * routing rule of such a repo (the team of its top-level "Team is" condition, else every
 * team; its other conditions aren't translated, routing decides afterwards). A query another
 * one already covers is left out.
 */
export function candidateFilters(input: {
  repositories: readonly Pick<Repository, "id" | "codingEnabled">[];
  matches: readonly RouteWorkItemMatch[];
  rules: readonly Pick<RoutingRule, "repositoryId" | "query">[];
}): CandidateFilter[] {
  const coding = new Set(input.repositories.filter((r) => r.codingEnabled).map((r) => r.id));
  const filters: CandidateFilter[] = [];
  for (const match of input.matches) {
    if (!coding.has(match.repositoryId) || match.tracker !== "linear") continue;
    filters.push(matchFilter(match));
  }
  for (const rule of input.rules) {
    if (!coding.has(rule.repositoryId)) continue;
    const team = ruleTeam(rule.query);
    filters.push(team ? { teamKey: team } : {});
  }
  return filters.filter(
    (filter, index) =>
      !filters.some(
        (other, i) => i !== index && covers(other, filter) && (i < index || !covers(filter, other)),
      ),
  );
}

function matchFilter(match: WorkItemMatchFields): CandidateFilter {
  return {
    teamKey: match.team,
    ...(match.withoutProject
      ? { withoutProject: true }
      : match.project !== null && { projectName: match.project }),
    ...(match.labels.length > 0 && { labelNames: [...match.labels] }),
  };
}

/** Candidates of every filter (each item once), at most `BACKLOG_CANDIDATE_CAP`. */
async function readCandidates(
  tracker: WorkItemTracker,
  filters: readonly CandidateFilter[],
): Promise<{ items: WorkItem[]; truncated: boolean }> {
  const byId = new Map<string, WorkItem>();
  let read = 0;
  for (const filter of filters) {
    let cursor: string | undefined;
    do {
      if (read >= BACKLOG_CANDIDATE_CAP) return { items: [...byId.values()], truncated: true };
      const page = await tracker.listCandidates({
        ...filter,
        readiness: ["ready", "needs_refining"],
        withRoutingFields: true,
        limit: Math.min(LIST_CANDIDATES_MAX_LIMIT, BACKLOG_CANDIDATE_CAP - read),
        ...(cursor && { cursor }),
      });
      read += page.items.length;
      for (const item of page.items) if (!byId.has(item.id)) byId.set(item.id, item);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }
  return { items: [...byId.values()], truncated: false };
}

/** Urgent (1) first, No priority (0) last. */
const priorityRank = (priority: number) => (priority === 0 ? 5 : priority);

/** List order: tracker priority, then most recently updated. */
export function compareBacklogEntries(a: BacklogEntry, b: BacklogEntry): number {
  return (
    priorityRank(a.priority) - priorityRank(b.priority) ||
    b.updatedAt.localeCompare(a.updatedAt) ||
    a.row.identifier.localeCompare(b.row.identifier)
  );
}

/**
 * Computes one organization's Backlog from its tracker (`tracker`): the candidates of each
 * candidate filter (with their routing fields, so routing them asks the tracker nothing
 * more), less sub-issues, items of no listed readiness, items delegated to another agent and
 * items with a run; each routed with the saved settings, keeping those that route to a repo
 * with Coding on or ask (a tie); sized from their newest triage. In list order.
 */
export async function loadOrganizationBacklog(deps: {
  db: Database;
  organizationId: string;
  tracker: WorkItemTracker;
}): Promise<OrganizationBacklog> {
  const { db, organizationId, tracker } = deps;
  const [repositories, matches, rules] = await Promise.all([
    listRoutingRepositories(db, organizationId),
    listWorkItemMatches(db, organizationId),
    listRoutingRules(db, organizationId),
  ]);
  const filters = candidateFilters({ repositories, matches, rules });
  if (filters.length === 0) return { entries: [], truncated: false, picksUp: false };

  const { items: candidates, truncated } = await readCandidates(tracker, filters);
  const listed = candidates.flatMap((item) => {
    const group = groupFor(item);
    if (!group || item.parentId) return [];
    if (item.delegate && !item.delegate.isOmniralph) return [];
    return [{ item, group }];
  });
  const ids = listed.map(({ item }) => item.id);
  const [runs, choices, sizes] = await Promise.all([
    listLatestIssueRuns(db, organizationId, ids),
    listWorkItemOverrides(db, organizationId, "linear", ids),
    latestTriageSizes(db, organizationId, ids),
  ]);
  const unstarted = listed.filter(({ item }) => !runs.has(item.id));

  const prefetched = new Map<string, WorkItemRouting>();
  for (const { item } of listed) {
    if (!item.routingFields) continue;
    prefetched.set(item.id, item.routingFields);
    prefetched.set(item.identifier, item.routingFields);
  }
  const router = await createRouter({
    db,
    organizationId,
    // A candidate's fields came with its page; anything else (a follow-up's source) is read.
    linear: {
      getRoutingFields: async (ref) => prefetched.get(ref) ?? tracker.routingFields(ref),
    },
    rules,
    matches,
    choices: new Map(ids.map((id) => [id, choices.get(id) ?? null])),
  });

  const entries = (
    await Promise.all(
      unstarted.map(async ({ item, group }): Promise<BacklogEntry | null> => {
        const route = await router.resolve(item.id);
        // Routed to a repo with Coding off: a person's job.
        if ("manual" in route) return null;
        const repository = "repository" in route ? route.repository : null;
        return {
          row: {
            id: workItemUrlId("linear", item.id),
            tracker: item.tracker,
            identifier: item.identifier,
            title: item.title,
            url: item.url,
            repository: repository && {
              id: repository.id,
              provider: repository.provider,
              fullPath: repository.fullPath,
            },
            size: sizes.get(item.id) ?? null,
            group,
            blocked: item.blocked,
            source: item.project
              ? {
                  kind: "project",
                  id: item.project.id ?? item.project.name,
                  name: item.project.name,
                }
              : { kind: "team", id: item.team.id, name: item.team.key },
          },
          priority: item.priority,
          updatedAt: item.updatedAt,
        };
      }),
    )
  ).filter((entry): entry is BacklogEntry => entry !== null);
  return { entries: entries.sort(compareBacklogEntries), truncated };
}

/** One organization's Backlog from the cache, computed with `tracker` on a miss. */
export function organizationBacklog(deps: {
  db: Database;
  organizationId: string;
  tracker: () => Promise<WorkItemTracker>;
}): Promise<OrganizationBacklog> {
  return cachedBacklog(deps.organizationId, async () =>
    loadOrganizationBacklog({
      db: deps.db,
      organizationId: deps.organizationId,
      tracker: await deps.tracker(),
    }),
  );
}

/** Shown when an organization's tracker couldn't be read. */
export const TRACKER_UNAVAILABLE_REASON = "Linear didn't answer. Try again in a moment.";

/** The Backlog of every organization in scope, in list order, before filters. */
interface ScopedBacklog {
  rows: WorkItemRow[];
  unavailable: Backlog["unavailable"];
  truncatedOrganizations: Backlog["truncatedOrganizations"];
  setup: Backlog["setup"];
}

export interface BacklogDeps {
  db: Database;
  /** The organization's tracker (default `getWorkItemTracker`). */
  getTracker?: (organizationId: string) => Promise<WorkItemTracker>;
}

/**
 * The scope's Backlog: each organization's from the cache (computed on a miss). An
 * organization without a tracker is skipped; one whose tracker fails is `unavailable` while
 * the others load.
 */
async function loadScope(
  deps: BacklogDeps,
  organizations: readonly ScopedOrganization[],
): Promise<ScopedBacklog> {
  const getTracker =
    deps.getTracker ??
    ((organizationId: string) => getWorkItemTracker({ db: deps.db, organizationId }));
  const results = await Promise.all(
    organizations.map(async (organization) => {
      try {
        const backlog = await organizationBacklog({
          db: deps.db,
          organizationId: organization.id,
          tracker: () => getTracker(organization.id),
        });
        return { organization, backlog };
      } catch (error) {
        if (error instanceof TrackerNotConnectedError) return { organization, backlog: null };
        console.error(`Loading the Backlog of organization ${organization.id} failed`, error);
        return { organization, backlog: null, failed: true };
      }
    }),
  );
  const scoped: ScopedBacklog = {
    rows: [],
    unavailable: [],
    truncatedOrganizations: [],
    setup: backlogSetup(results),
  };
  const entries: Array<{ entry: BacklogEntry; organization: WorkItemRow["organization"] }> = [];
  for (const result of results) {
    const organization = {
      id: result.organization.id,
      name: result.organization.name,
      role: result.organization.role,
    };
    if ("failed" in result) {
      scoped.unavailable.push({
        organization,
        tracker: "linear",
        reason: TRACKER_UNAVAILABLE_REASON,
      });
    }
    if (!result.backlog) continue;
    if (result.backlog.truncated) scoped.truncatedOrganizations.push(organization);
    for (const entry of result.backlog.entries) entries.push({ entry, organization });
  }
  scoped.rows = entries
    .sort((a, b) => compareBacklogEntries(a.entry, b.entry))
    .map(({ entry, organization }) => ({ ...entry.row, organization }));
  return scoped;
}

/**
 * Why a list may be empty: no organization in scope has a tracker connected
 * (`no_tracker`); else none picks up work items and none failed to load
 * (`no_work_item_match`); else `ready`.
 */
function backlogSetup(
  results: ReadonlyArray<{ backlog: OrganizationBacklog | null; failed?: boolean }>,
): Backlog["setup"] {
  const connected = results.filter((result) => result.backlog !== null || result.failed);
  if (connected.length === 0) return "no_tracker";
  if (connected.every((result) => result.backlog?.picksUp === false)) return "no_work_item_match";
  return "ready";
}

/** `GET /api/ui/backlog`: the groups (filtered), the filters' options and what didn't load. */
export async function loadBacklog(
  deps: BacklogDeps,
  organizations: readonly ScopedOrganization[],
  filters: Pick<BacklogQuery, "source" | "repo"> = {},
): Promise<Backlog> {
  const scope = await loadScope(deps, organizations);
  const sources = new Map<string, Backlog["filters"]["sources"][number]>();
  const repos = new Map<string, Backlog["filters"]["repos"][number]>();
  for (const row of scope.rows) {
    const value = workItemSourceValue(row);
    if (!sources.has(value)) sources.set(value, { ...row.source, value, tracker: row.tracker });
    if (row.repository && !repos.has(row.repository.id)) {
      repos.set(row.repository.id, {
        value: row.repository.id,
        provider: row.repository.provider,
        fullPath: row.repository.fullPath,
      });
    }
  }
  const rows = scope.rows.filter(
    (row) =>
      (!filters.source || workItemSourceValue(row) === filters.source) &&
      (!filters.repo || row.repository?.id === filters.repo),
  );
  return {
    groups: {
      readyToStart: rows.filter((row) => row.group === "ready"),
      needsRefining: rows.filter((row) => row.group === "refine"),
    },
    filters: {
      sources: [...sources.values()].sort(
        (a, b) => a.tracker.localeCompare(b.tracker) || a.name.localeCompare(b.name),
      ),
      repos: [...repos.values()].sort((a, b) => a.fullPath.localeCompare(b.fullPath)),
    },
    unavailable: scope.unavailable,
    truncated: scope.truncatedOrganizations.length > 0,
    truncatedOrganizations: scope.truncatedOrganizations,
    setup: scope.setup,
  };
}

/** `GET /api/ui/backlog/counts`: the unfiltered list's group sizes (the nav count). */
export async function loadBacklogCounts(
  deps: BacklogDeps,
  organizations: readonly ScopedOrganization[],
): Promise<BacklogCounts> {
  const { rows } = await loadScope(deps, organizations);
  const readyToStart = rows.filter((row) => row.group === "ready").length;
  return { readyToStart, needsRefining: rows.length - readyToStart, total: rows.length };
}

/** `GET /api/ui/backlog/up-next`: the first Ready to start and Needs refining rows. */
export async function loadBacklogUpNext(
  deps: BacklogDeps,
  organizations: readonly ScopedOrganization[],
): Promise<BacklogUpNext> {
  const { rows } = await loadScope(deps, organizations);
  return {
    readyToStart: rows.filter((row) => row.group === "ready").slice(0, UP_NEXT_READY),
    needsRefining: rows.filter((row) => row.group === "refine").slice(0, UP_NEXT_REFINING),
  };
}
