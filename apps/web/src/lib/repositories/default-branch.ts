import "server-only";
import {
  setRepositoryDefaultBranch,
  type Database,
  type Repository,
  type ScmConnection,
} from "@omniralph/db";
import type { ScmAdapter } from "@omniralph/scm";

/**
 * A repository's default branch: every read from the code host goes through
 * {@link fetchDefaultBranch}, which also stores it (`repositories.default_branch`, shown in the
 * Repos header). Storing records the live `repository` change only when the value changed.
 */

export interface DefaultBranchDeps {
  db: Database;
  adapterFor: (db: Database, connection: ScmConnection) => ScmAdapter;
}

/**
 * Stores a default branch read elsewhere (a webhook payload). Best effort: a failed write is
 * logged, never thrown. Returns whether the stored value changed.
 */
export async function storeDefaultBranch(
  db: Database,
  repository: Pick<Repository, "id" | "fullPath">,
  branch: string,
): Promise<boolean> {
  try {
    return await setRepositoryDefaultBranch(db, repository.id, branch);
  } catch (error) {
    console.error(`Storing the default branch of ${repository.fullPath} failed`, error);
    return false;
  }
}

/**
 * Reads the repository's default branch from its code host and stores it. Throws the code
 * host's error; storing is best effort (the caller gets the branch either way).
 */
export async function fetchDefaultBranch(
  deps: DefaultBranchDeps,
  connection: ScmConnection,
  repository: Pick<Repository, "id" | "fullPath" | "externalId">,
): Promise<string> {
  const branch = await deps.adapterFor(deps.db, connection).getDefaultBranch({
    fullPath: repository.fullPath,
    externalId: repository.externalId,
  });
  await storeDefaultBranch(deps.db, repository, branch);
  return branch;
}
