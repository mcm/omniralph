import "server-only";
import {
  getRunIndexEntries,
  getSearchAgents,
  getSearchRepositories,
  listRecentItems,
  loadRunListEntries,
  recordRecentItem,
  searchAgents,
  searchRepositories,
  searchRuns,
  type AgentSearchHit,
  type Database,
  type RecentItemKind,
  type RepositorySearchHit,
  type RunIndexEntry,
  type SearchTier,
} from "@omniralph/db";
import { ApiRouteError } from "@/lib/api/handler";
import {
  SEARCH_GROUP_LABELS,
  SEARCH_KINDS,
  SEARCH_MIN_QUERY_LENGTH,
  SEARCH_RECENT_LIMIT,
  type RecordRecentBody,
  type SearchGroup,
  type SearchKind,
  type SearchResponse,
  type SearchResult,
} from "@/lib/api/search";
import {
  membership,
  requireAgentAccess,
  requireRepositoryAccess,
  requireRunAccess,
  type ScopedOrganization,
} from "@/lib/api/scope";
import type { OrgUser } from "@/lib/auth/session";
import { compactSince } from "@/lib/fleet/status";
import { repoHref } from "@/lib/repositories/hrefs";
import { agentHref, runHref } from "@/lib/runs/hrefs";
import { runRow } from "@/lib/runs/list";
import {
  loadBacklogSearchEntries,
  type BacklogSearchEntry,
  type BacklogDeps,
} from "@/lib/work-items/backlog";
import { parseWorkItemId } from "@/lib/work-items/item";
import { backlogItemHref } from "@/screens/backlog/url";
import { SETTINGS_PAGES, settingsPage, type SettingsPage } from "./settings-pages";

/**
 * Search and jump (`GET /api/ui/search`): runs, Backlog work items, repos and agents of the
 * organizations in scope, and the Settings pages, matching what was typed, best match first;
 * for a short query, the items the user last opened from search (`POST /api/ui/search/recent`).
 */

/** How long a search waits for the Backlog when its cache is cold (the fill goes on, cached). */
export const BACKLOG_SEARCH_BUDGET_MS = 1_000;

export interface SearchDeps extends BacklogDeps {
  /** How long to wait for the Backlog (default `BACKLOG_SEARCH_BUDGET_MS`). */
  backlogBudgetMs?: number;
  now?: Date;
}

/**
 * How well one of `values` matches `query` (case-insensitive): 0 equal, 1 starts with it,
 * 2 contains it; null when none does.
 */
export function matchTier(
  query: string,
  ...values: ReadonlyArray<string | null | undefined>
): SearchTier | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  let best: SearchTier | null = null;
  for (const value of values) {
    if (!value) continue;
    const text = value.toLowerCase();
    const tier: SearchTier | null =
      text === needle ? 0 : text.startsWith(needle) ? 1 : text.includes(needle) ? 2 : null;
    if (tier !== null && (best === null || tier < best)) best = tier;
  }
  return best;
}

/** `promise`'s value, or `fallback` when it fails or takes longer than `ms`. */
async function withinBudget<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise.catch(() => fallback), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const organizationRef = (organization: ScopedOrganization) => ({
  id: organization.id,
  name: organization.name,
  role: organization.role,
});

function agentStatus(hit: AgentSearchHit, now: Date) {
  if (hit.revoked) return { label: "Revoked", tone: "neutral" } as const;
  if (hit.online) return { label: "Online", tone: "good" } as const;
  if (hit.lastHeartbeatAt) {
    return { label: `Offline ${compactSince(hit.lastHeartbeatAt, now)}`, tone: "fail" } as const;
  }
  return { label: "Never connected", tone: "neutral" } as const;
}

function repositoryResult(
  hit: RepositorySearchHit,
  organization: ScopedOrganization,
): SearchResult {
  return {
    kind: "repository",
    id: hit.id,
    href: repoHref(hit.id),
    repository: {
      id: hit.id,
      organization: organizationRef(organization),
      provider: hit.provider,
      fullPath: hit.fullPath,
    },
  };
}

function agentResult(
  hit: AgentSearchHit,
  organization: ScopedOrganization,
  now: Date,
): SearchResult {
  return {
    kind: "agent",
    id: hit.id,
    href: agentHref(hit.id),
    agent: {
      id: hit.id,
      organization: organizationRef(organization),
      name: hit.name,
      status: agentStatus(hit, now),
    },
  };
}

function workItemResult(entry: BacklogSearchEntry): SearchResult {
  return {
    kind: "workItem",
    id: entry.row.id,
    href: backlogItemHref(entry.row.id),
    workItem: entry.row,
  };
}

function settingsResult(page: SettingsPage): SearchResult {
  return {
    kind: "settings",
    id: page.path,
    href: page.path,
    settings: { title: page.title, section: page.section },
  };
}

/** The runs' results, in the order given. */
async function runResults(
  db: Database,
  entries: readonly RunIndexEntry[],
  byId: ReadonlyMap<string, ScopedOrganization>,
): Promise<SearchResult[]> {
  const rows = await loadRunListEntries(db, entries);
  return rows.map((entry) => {
    const run = runRow(entry, byId.get(entry.organizationId)!);
    return { kind: "run", id: run.id, href: runHref(run.id), run };
  });
}

/** Backlog entries matching the query, best first, then most recently updated. */
function matchWorkItems(
  entries: readonly BacklogSearchEntry[],
  query: string,
  limit: number,
): Array<{ entry: BacklogSearchEntry; tier: SearchTier }> {
  return entries
    .flatMap((entry) => {
      const tier = matchTier(query, entry.row.identifier, entry.row.title);
      return tier === null ? [] : [{ entry, tier }];
    })
    .sort((a, b) => a.tier - b.tier || b.entry.updatedAt.localeCompare(a.entry.updatedAt))
    .slice(0, limit);
}

/**
 * Settings pages whose title matches (exact, prefix, substring; a later word of the title
 * starting with the query counts as a prefix), or one of whose keywords contains the query
 * (substring), best first, in the Settings nav's order.
 */
function matchSettings(query: string, limit: number) {
  const needle = query.toLowerCase();
  return SETTINGS_PAGES.flatMap((page, index) => {
    const tiers = [
      matchTier(query, page.title),
      page.title
        .toLowerCase()
        .split(/\s+/)
        .some((word) => word.startsWith(needle))
        ? 1
        : null,
      page.keywords.some((keyword) => keyword.includes(needle)) ? 2 : null,
    ].filter((tier): tier is SearchTier => tier !== null);
    return tiers.length ? [{ page, tier: Math.min(...tiers) as SearchTier, index }] : [];
  })
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .slice(0, limit);
}

/**
 * Search: each kind's best `limit` matches in the organizations, the groups with matches
 * ordered by their best match (then `SEARCH_KINDS` order), so an exact identifier or name
 * match is always first.
 */
export async function searchEverything(
  deps: SearchDeps,
  organizations: readonly ScopedOrganization[],
  query: string,
  limit: number,
): Promise<SearchResponse> {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const organizationIds = organizations.map((o) => o.id);
  const byId = new Map(organizations.map((o) => [o.id, o]));
  const filter = { organizationIds, query, limit };
  const [runHits, repositoryHits, agentHits, backlog] = await Promise.all([
    searchRuns(db, filter),
    searchRepositories(db, filter),
    searchAgents(db, filter),
    withinBudget(
      loadBacklogSearchEntries(deps, organizations),
      deps.backlogBudgetMs ?? BACKLOG_SEARCH_BUDGET_MS,
      [],
    ),
  ]);
  const workItemHits = matchWorkItems(backlog, query, limit);
  const settingsHits = matchSettings(query, limit);

  const runs = await runResults(
    db,
    runHits.map((hit) => hit.entry),
    byId,
  );
  const found: Record<SearchKind, { tier: SearchTier; results: SearchResult[] } | null> = {
    run: runHits.length ? { tier: runHits[0]!.tier, results: runs } : null,
    workItem: workItemHits.length
      ? {
          tier: workItemHits[0]!.tier,
          results: workItemHits.map((hit) => workItemResult(hit.entry)),
        }
      : null,
    repository: repositoryHits.length
      ? {
          tier: repositoryHits[0]!.tier,
          results: repositoryHits.map((hit) =>
            repositoryResult(hit, byId.get(hit.organizationId)!),
          ),
        }
      : null,
    agent: agentHits.length
      ? {
          tier: agentHits[0]!.tier,
          results: agentHits.map((hit) => agentResult(hit, byId.get(hit.organizationId)!, now)),
        }
      : null,
    settings: settingsHits.length
      ? {
          tier: settingsHits[0]!.tier,
          results: settingsHits.map((hit) => settingsResult(hit.page)),
        }
      : null,
  };
  const groups = SEARCH_KINDS.flatMap((kind, index) => {
    const group = found[kind];
    return group ? [{ kind, index, ...group }] : [];
  })
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map(({ kind, results }): SearchGroup => ({
      id: kind,
      label: SEARCH_GROUP_LABELS[kind],
      results,
    }));
  return { mode: "results", groups };
}

/** Each search kind as `user_recent_items.kind` stores it. */
const RECENT_KIND: Readonly<Record<SearchKind, RecentItemKind>> = {
  run: "run",
  workItem: "work_item",
  repository: "repository",
  agent: "agent",
  settings: "settings",
};

/**
 * The user's `SEARCH_RECENT_LIMIT` most recently opened items that are still there, in the
 * organizations in scope (and the Settings pages), newest first, with what their rows show now.
 */
export async function loadRecentResults(
  deps: SearchDeps,
  userId: string,
  organizations: readonly ScopedOrganization[],
): Promise<SearchResponse> {
  const { db } = deps;
  const now = deps.now ?? new Date();
  const organizationIds = organizations.map((o) => o.id);
  const byId = new Map(organizations.map((o) => [o.id, o]));
  const recent = await listRecentItems(db, userId, organizationIds);
  const idsOf = (kind: RecentItemKind) =>
    recent.filter((item) => item.kind === kind).map((item) => item.refId);
  const uuids = (ids: string[]) => ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id));

  const runIds = uuids(idsOf("run"));
  const workItemIds = new Set(idsOf("work_item"));
  const [runEntries, repositoryHits, agentHits, backlog] = await Promise.all([
    getRunIndexEntries(db, runIds),
    getSearchRepositories(db, organizationIds, uuids(idsOf("repository"))),
    getSearchAgents(db, organizationIds, uuids(idsOf("agent"))),
    workItemIds.size
      ? withinBudget(
          loadBacklogSearchEntries(deps, organizations),
          deps.backlogBudgetMs ?? BACKLOG_SEARCH_BUDGET_MS,
          [],
        )
      : Promise.resolve([]),
  ]);
  const runs = await runResults(
    db,
    runEntries.filter((entry) => byId.has(entry.organizationId)),
    byId,
  );

  const results = new Map<string, SearchResult>();
  const key = (kind: RecentItemKind, id: string) => `${kind}:${id}`;
  for (const result of runs) results.set(key("run", result.id), result);
  for (const hit of repositoryHits) {
    results.set(key("repository", hit.id), repositoryResult(hit, byId.get(hit.organizationId)!));
  }
  for (const hit of agentHits) {
    results.set(key("agent", hit.id), agentResult(hit, byId.get(hit.organizationId)!, now));
  }
  for (const entry of backlog) {
    if (workItemIds.has(entry.row.id)) {
      results.set(key("work_item", entry.row.id), workItemResult(entry));
    }
  }
  for (const path of idsOf("settings")) {
    const page = settingsPage(path);
    if (page) results.set(key("settings", path), settingsResult(page));
  }

  const shown = recent
    .flatMap((item) => results.get(key(item.kind, item.refId)) ?? [])
    .slice(0, SEARCH_RECENT_LIMIT);
  return {
    mode: "recent",
    groups: [{ id: "recent", label: SEARCH_GROUP_LABELS.recent, results: shown }],
  };
}

/** `GET /api/ui/search`: the recent items for a short query, else the matches. */
export function search(
  deps: SearchDeps,
  userId: string,
  organizations: readonly ScopedOrganization[],
  query: { q: string; limit: number },
): Promise<SearchResponse> {
  if (query.q.length < SEARCH_MIN_QUERY_LENGTH) {
    return loadRecentResults(deps, userId, organizations);
  }
  return searchEverything(deps, organizations, query.q, query.limit);
}

/**
 * `POST /api/ui/search/recent`: records that the user opened a result. The item must be one
 * of their organizations' (a run, repo or agent by its organization; a work item by the
 * Backlog of their organizations) or a Settings page; anything else is not found.
 */
export async function recordRecent(
  deps: SearchDeps,
  user: OrgUser,
  body: RecordRecentBody,
  organizations: () => Promise<readonly ScopedOrganization[]>,
): Promise<void> {
  const organizationId = await recentOrganization(deps, user, body, organizations);
  await recordRecentItem(deps.db, {
    userId: user.id,
    kind: RECENT_KIND[body.kind],
    refId: body.id,
    organizationId,
  });
}

async function recentOrganization(
  deps: SearchDeps,
  user: OrgUser,
  body: RecordRecentBody,
  organizations: () => Promise<readonly ScopedOrganization[]>,
): Promise<string | null> {
  switch (body.kind) {
    case "run":
      return (await requireRunAccess(user, body.id)).run.organizationId;
    case "repository":
      return (await requireRepositoryAccess(user, body.id)).repository.organizationId;
    case "agent":
      return (await requireAgentAccess(user, body.id)).id;
    case "settings":
      if (!settingsPage(body.id)) throw ApiRouteError.notFound();
      return null;
    case "workItem": {
      if (!parseWorkItemId(body.id)) throw ApiRouteError.notFound();
      const entries = await loadBacklogSearchEntries(deps, await organizations());
      const entry = entries.find((e) => e.row.id === body.id);
      // Only an organization the user is a member of (`organizations` are theirs).
      if (!entry || !(await membership(user, entry.row.organization.id))) {
        throw ApiRouteError.notFound();
      }
      return entry.row.organization.id;
    }
  }
}
