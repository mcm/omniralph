/**
 * Which repository a delegated Linear issue builds in. Only repositories with
 * coding effectively enabled (their own switch, else the organization's
 * allowed task types) are candidates; the rules are tried in order and the first
 * one that matches wins:
 *
 *   1. label    one of the issue's labels is in the repository's `linear_labels`
 *   2. project  the issue's project is in its `linear_project_names`
 *   3. team     the issue's team key is in its `linear_team_keys`
 *
 * Matching ignores case. When several repositories match the same rule, the
 * one with the first `full_path` wins. Routing comes only from these settings,
 * never from the issue's description.
 */
import { normalizeRepoPath } from "@omniralph/ralph";

export interface RoutableIssue {
  /** Label names. */
  labels: readonly string[];
  projectName?: string | null;
  teamKey?: string | null;
}

export interface RoutableRepository {
  fullPath: string;
  /** Its effective switches; only `coding` matters here (`effectiveRepositorySwitches`). */
  effective: { coding: boolean };
  linearTeamKeys: readonly string[];
  linearProjectNames: readonly string[];
  linearLabels: readonly string[];
}

export type RoutingRule = "label" | "project" | "team";

export interface RouteMatch<R extends RoutableRepository> {
  repository: R;
  rule: RoutingRule;
  /** What matched: the label, the project name or the team key (as on the issue). */
  value: string;
}

const RULE_LABEL: Record<RoutingRule, string> = {
  label: "label",
  project: "project",
  team: "team",
};

/** How a route chose its repository, as `routed_by` stores it (e.g. "team `ENG`"). */
export function describeRoute(
  route: Pick<RouteMatch<RoutableRepository>, "rule" | "value">,
): string {
  return `${RULE_LABEL[route.rule]} \`${route.value}\``;
}

const lower = (values: readonly string[]) => values.map((v) => v.trim().toLowerCase());

/** The repository `issue` routes to and the rule that matched, or null when none does. */
export function routeIssue<R extends RoutableRepository>(
  issue: RoutableIssue,
  repositories: readonly R[],
): RouteMatch<R> | null {
  const candidates = repositories
    .filter((r) => r.effective.coding)
    .sort((a, b) => (a.fullPath < b.fullPath ? -1 : a.fullPath > b.fullPath ? 1 : 0));

  for (const repository of candidates) {
    const routed = lower(repository.linearLabels);
    const label = issue.labels.find((l) => routed.includes(l.trim().toLowerCase()));
    if (label !== undefined) return { repository, rule: "label", value: label };
  }

  const project = issue.projectName?.trim();
  if (project) {
    const repository = candidates.find((r) =>
      lower(r.linearProjectNames).includes(project.toLowerCase()),
    );
    if (repository) return { repository, rule: "project", value: project };
  }

  const team = issue.teamKey?.trim();
  if (team) {
    const repository = candidates.find((r) => lower(r.linearTeamKeys).includes(team.toLowerCase()));
    if (repository) return { repository, rule: "team", value: team };
  }

  return null;
}

/** Where one story of an epic goes, judged by the routing signals it doesn't share with the epic. */
export type StoryRoute<R extends RoutableRepository> =
  | { type: "epic" }
  | ({ type: "selected" } & RouteMatch<R>)
  | { type: "unroutable"; reason: string };

/**
 * Routes a story of an epic (cyralph's `routeStory`). Only the story's own
 * signals count, in the usual order: a routing label, a project other than
 * the epic's, a team other than the epic's. A story without any stays in the
 * epic's repository. A different project that no
 * repository here matches means the story belongs to a repository Omniralph
 * doesn't have (teams and labels often span repositories, so they never make a
 * story unroutable).
 */
export function routeStory<R extends RoutableRepository>(
  repositories: readonly R[],
  story: Partial<RoutableIssue>,
  epic: { projectName?: string | null; teamKey?: string | null },
): StoryRoute<R> {
  const candidates = repositories
    .filter((r) => r.effective.coding)
    .sort((a, b) => (a.fullPath < b.fullPath ? -1 : a.fullPath > b.fullPath ? 1 : 0));

  const labels = story.labels ?? [];
  for (const repository of candidates) {
    const routed = lower(repository.linearLabels);
    const label = labels.find((l) => routed.includes(l.trim().toLowerCase()));
    if (label !== undefined) return { type: "selected", repository, rule: "label", value: label };
  }

  const project = story.projectName?.trim();
  if (project && project.toLowerCase() !== epic.projectName?.trim().toLowerCase()) {
    const repository = candidates.find((r) =>
      lower(r.linearProjectNames).includes(project.toLowerCase()),
    );
    if (repository) return { type: "selected", repository, rule: "project", value: project };
    return {
      type: "unroutable",
      reason: `it's in project ${project}, which no repository here is set up for`,
    };
  }

  const team = story.teamKey?.trim();
  if (team && team.toLowerCase() !== epic.teamKey?.trim().toLowerCase()) {
    const repository = candidates.find((r) => lower(r.linearTeamKeys).includes(team.toLowerCase()));
    if (repository) return { type: "selected", repository, rule: "team", value: team };
  }
  return { type: "epic" };
}

const lastSegment = (path: string) => normalizeRepoPath(path).split("/").pop() ?? "";

/** Whether `name` names the repository: its full path or the last segment of it. */
function namesRepository(name: string, repository: Pick<RoutableRepository, "fullPath">): boolean {
  const t = normalizeRepoPath(name);
  return t === normalizeRepoPath(repository.fullPath) || t === lastSegment(repository.fullPath);
}

/**
 * Matches a reply to the repository question (cyralph's `matchSelection`), in
 * order: a 1-based option number, the option text (the full path), a
 * repository name (the full path or its last segment), then a reply that
 * contains a repository's full path.
 */
export function matchSelection<R extends Pick<RoutableRepository, "fullPath">>(
  reply: string,
  candidates: readonly R[],
): R | undefined {
  const text = reply.trim();
  const n = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (n >= 1 && n <= candidates.length) return candidates[n - 1];
  const said = text.toLowerCase();
  return (
    candidates.find((r) => r.fullPath.trim().toLowerCase() === said) ??
    candidates.find((r) => namesRepository(text, r)) ??
    mentionedRepository(said, candidates)
  );
}

/**
 * The repository whose full path a reply contains (e.g. its URL), as a whole
 * path: `platform/api` doesn't match `platform/api-v2`, and the longest path
 * wins, so the URL of `group/platform/api` picks it over `platform/api`.
 */
function mentionedRepository<R extends Pick<RoutableRepository, "fullPath">>(
  said: string,
  candidates: readonly R[],
): R | undefined {
  let best: { repository: R; length: number } | undefined;
  for (const repository of candidates) {
    const path = normalizeRepoPath(repository.fullPath);
    if (!path || (best && path.length <= best.length)) continue;
    const whole = new RegExp(`(?:^|[^\\w.-])${escapeRegExp(path)}(?![\\w-])`);
    if (whole.test(said)) best = { repository, length: path.length };
  }
  return best?.repository;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
