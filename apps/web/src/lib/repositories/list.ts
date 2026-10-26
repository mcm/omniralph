import "server-only";
import { listConnectedRepositories, type Database } from "@omniralph/db";
import type { ScopedOrganization } from "@/lib/api/scope";
import { loadRepositoryStatuses, type RepositoryStatus } from "./status";
import { repositoryWebUrl } from "./web-url";

/** Most repos the Repos rail lists; more answer `truncated`. */
export const REPOSITORY_LIST_LIMIT = 500;

/** A row of the Repos rail. */
export interface RepositoryListRow {
  id: string;
  /** Its organization, and the user's role there. */
  organization: ScopedOrganization;
  provider: "github" | "gitlab";
  fullPath: string;
  /** The last path segment. */
  name: string;
  /** The path before `name` (the GitHub owner or GitLab group), or null. */
  group: string | null;
  webUrl: string;
  reviewsEnabled: boolean;
  codingEnabled: boolean;
  askEnabled: boolean;
  status: RepositoryStatus;
}

/** The Repos rail: the scope's connected repositories, at most `REPOSITORY_LIST_LIMIT`. */
export interface RepositoryListView {
  repositories: RepositoryListRow[];
  /** More repositories are connected than were listed. */
  truncated: boolean;
}

/** Splits a full path into its last segment and the path before it. */
export function splitRepositoryPath(fullPath: string): { name: string; group: string | null } {
  const slash = fullPath.lastIndexOf("/");
  return slash === -1
    ? { name: fullPath, group: null }
    : { name: fullPath.slice(slash + 1), group: fullPath.slice(0, slash) || null };
}

/**
 * The connected repositories of `organizations` (the user's, with their role), by
 * organization name, then path, with each one's status: a fixed number of queries. Only
 * `repositoryIds` when given (the rows of repos just added).
 */
export async function loadRepositoryList(
  db: Database,
  organizations: readonly ScopedOrganization[],
  now: Date = new Date(),
  { repositoryIds }: { repositoryIds?: readonly string[] } = {},
): Promise<RepositoryListView> {
  const byId = new Map(organizations.map((o) => [o.id, o]));
  const { repositories, truncated } = await listConnectedRepositories(
    db,
    [...byId.keys()],
    REPOSITORY_LIST_LIMIT,
    { repositoryIds },
  );
  const statuses = await loadRepositoryStatuses(db, repositories, now);
  return {
    repositories: repositories.map((repo) => ({
      id: repo.id,
      organization: byId.get(repo.organizationId)!,
      provider: repo.provider,
      fullPath: repo.fullPath,
      ...splitRepositoryPath(repo.fullPath),
      webUrl: repositoryWebUrl(repo.provider, repo.connection.baseUrl, repo.fullPath),
      reviewsEnabled: repo.reviewsEnabled,
      codingEnabled: repo.codingEnabled,
      askEnabled: repo.askEnabled,
      status: statuses.get(repo.id)!,
    })),
    truncated,
  };
}
