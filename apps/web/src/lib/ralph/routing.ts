/**
 * Which repository a delegated Linear issue builds in. Only repositories with
 * ralph enabled are candidates; the rules are tried in order and the first
 * one that matches wins:
 *
 *   1. tag      a `[repo=<fullPath>]` tag in the description (Linear may escape it as `\[repo=…\]`)
 *   2. label    one of the issue's labels is in the repository's `linear_labels`
 *   3. project  the issue's project is in its `linear_project_names`
 *   4. team     the issue's team key is in its `linear_team_keys`
 *
 * Matching ignores case. When several repositories match the same rule, the
 * one with the first `full_path` wins. A tag is authoritative: an issue whose
 * tags name no enabled repository isn't routed by its labels, project or team.
 */
import { normalizeRepoPath, parseRepoTags } from "@omniralph/ralph";

export { parseRepoTags };

export interface RoutableIssue {
  description?: string | null;
  /** Label names. */
  labels: readonly string[];
  projectName?: string | null;
  teamKey?: string | null;
}

export interface RoutableRepository {
  fullPath: string;
  ralphEnabled: boolean;
  linearTeamKeys: readonly string[];
  linearProjectNames: readonly string[];
  linearLabels: readonly string[];
}

export type RoutingRule = "tag" | "label" | "project" | "team";

export interface RouteMatch<R extends RoutableRepository> {
  repository: R;
  rule: RoutingRule;
  /** What matched: the tagged path, the label, the project name or the team key (as on the issue). */
  value: string;
}

const RULE_LABEL: Record<RoutingRule, string> = {
  tag: "`[repo=…]` tag",
  label: "label",
  project: "project",
  team: "team",
};

/** How a route chose its repository, as `routed_by` stores it (e.g. "team `ENG`"). */
export function describeRoute(route: Pick<RouteMatch<RoutableRepository>, "rule" | "value">): string {
  return `${RULE_LABEL[route.rule]} \`${route.value}\``;
}

const lower = (values: readonly string[]) => values.map((v) => v.trim().toLowerCase());

/** The repository `issue` routes to and the rule that matched, or null when none does. */
export function routeIssue<R extends RoutableRepository>(
  issue: RoutableIssue,
  repositories: readonly R[],
): RouteMatch<R> | null {
  const candidates = repositories
    .filter((r) => r.ralphEnabled)
    .sort((a, b) => (a.fullPath < b.fullPath ? -1 : a.fullPath > b.fullPath ? 1 : 0));

  const tags = parseRepoTags(issue.description);
  if (tags.length > 0) {
    for (const tag of tags) {
      const repository = candidates.find(
        (r) => normalizeRepoPath(r.fullPath) === normalizeRepoPath(tag),
      );
      if (repository) return { repository, rule: "tag", value: tag };
    }
    return null;
  }

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
 * signals count, in the usual order: a repo tag, a routing label, a project
 * other than the epic's, a team other than the epic's. A story without any
 * stays in the epic's repository. A repo tag or a different project that no
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
    .filter((r) => r.ralphEnabled)
    .sort((a, b) => (a.fullPath < b.fullPath ? -1 : a.fullPath > b.fullPath ? 1 : 0));

  const tags = parseRepoTags(story.description);
  for (const tag of tags) {
    const repository = candidates.find(
      (r) => normalizeRepoPath(r.fullPath) === normalizeRepoPath(tag),
    );
    if (repository) return { type: "selected", repository, rule: "tag", value: tag };
  }
  if (tags.length > 0) {
    return {
      type: "unroutable",
      reason: `its \`[repo=${tags.join(",")}]\` tag names no repository here`,
    };
  }

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

/** Whether `tag` names the repository: its full path or the last segment of it. */
function tagNamesRepository(
  tag: string,
  repository: Pick<RoutableRepository, "fullPath">,
): boolean {
  const t = normalizeRepoPath(tag);
  return t === normalizeRepoPath(repository.fullPath) || t === lastSegment(repository.fullPath);
}

/**
 * Matches a reply to the repository question (cyralph's `matchSelection`), in
 * order: a 1-based option number, the option text (the full path), a
 * tag-style name (the full path or its last segment), then a reply that
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
    candidates.find((r) => tagNamesRepository(text, r)) ??
    candidates.find((r) => said.includes(normalizeRepoPath(r.fullPath)))
  );
}
