/** Client-safe links to the Repos screen. */

/** The Repos screen's list. */
export const REPOS_PATH = "/repos";

/** A repo's page on the Repos screen. */
export function repoHref(repositoryId: string): string {
  return `${REPOS_PATH}/${repositoryId}`;
}
