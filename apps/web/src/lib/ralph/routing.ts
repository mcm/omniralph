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

/** Repository paths named by `[repo=…]` tags in `description`, in order, without duplicates. */
export function parseRepoTags(description: string | null | undefined): string[] {
  if (!description) return [];
  const paths: string[] = [];
  for (const match of description.matchAll(/\\?\[repo=([^\s\]]+?)\\?\]/gi)) {
    const path = match[1]!.replace(/\\(.)/g, "$1");
    if (!paths.some((p) => normalizePath(p) === normalizePath(path))) paths.push(path);
  }
  return paths;
}

function normalizePath(path: string): string {
  return path
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/, "");
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
      const repository = candidates.find((r) => normalizePath(r.fullPath) === normalizePath(tag));
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
