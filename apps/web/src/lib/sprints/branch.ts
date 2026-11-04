import "server-only";
import {
  findStartedSprintEpic,
  getRepositoryWithConnection,
  setSprintBranch,
  type Repository,
  type ScmConnection,
  type SprintWithEpics,
  type WorkItemTracker,
} from "@omniralph/db";
import { fetchDefaultBranch, type DefaultBranchDeps } from "@/lib/repositories/default-branch";

/**
 * A merge-together sprint's branch: Om creates it from the repo's default branch when the
 * sprint starts its first epic, and brings it up to date with the default branch before each
 * next epic starts (`prepareSprintBranch`). Every lane of a sprint epic's run in the sprint's
 * repo is based on it (`laneBaseBranch`), so the epic's PR targets it.
 */

/** The longest name part of a sprint branch. */
const MAX_SLUG_CHARS = 40;

/** The sprint's branch: `sprint/<name>-<ID prefix>`, unique to the sprint. */
export function sprintBranchName(sprint: { id: string; name: string }): string {
  const slug = sprint.name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_SLUG_CHARS)
    .replace(/^-+|-+$/g, "");
  const suffix = sprint.id.replace(/-/g, "").slice(0, 8);
  return `sprint/${slug ? `${slug}-` : ""}${suffix}`;
}

/** The pause reason of a sprint branch that conflicts with the default branch. */
export const sprintBranchConflictReason = (
  branch: string,
  defaultBranch: string,
  hostMessage: string,
) =>
  `The sprint branch ${branch} conflicts with ${defaultBranch}, so Om didn't start the next epic. Merge ${defaultBranch} into ${branch} by hand, then resume. (${hostMessage})`;

/** The pause reason of a sprint branch the code host wouldn't update or create. */
export const sprintBranchFailedReason = (what: string, why: string) =>
  `Om couldn't ${what}, so it didn't start the next epic: ${why}`;

export type SprintBranchPrepared =
  | { status: "ready"; branch: string }
  /** The branch couldn't be created or brought up to date: the sprint pauses with `reason`. */
  | { status: "failed"; reason: string };

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Makes the merge-together sprint's branch ready for its next epic: creates it from the repo's
 * default branch (and records it on the sprint) the first time, else merges the default branch
 * into it. A conflict, or a branch the code host refuses to create or update, fails with the
 * reason the sprint pauses with.
 */
export async function prepareSprintBranch(
  deps: DefaultBranchDeps & { organizationId: string },
  sprint: Pick<
    SprintWithEpics,
    "id" | "name" | "repositoryId" | "repositoryFullPath" | "sprintBranch"
  >,
): Promise<SprintBranchPrepared> {
  const found = await getRepositoryWithConnection(deps.db, sprint.repositoryId);
  if (!found || found.repository.disconnectedAt) {
    return {
      status: "failed",
      reason: sprintBranchFailedReason(
        "prepare the sprint branch",
        `${sprint.repositoryFullPath} isn't connected.`,
      ),
    };
  }
  const { repository, connection } = found;
  const repo = { fullPath: repository.fullPath, externalId: repository.externalId };
  const branch = sprint.sprintBranch ?? sprintBranchName(sprint);
  try {
    const adapter = deps.adapterFor(deps.db, connection);
    const defaultBranch = await fetchDefaultBranch(deps, connection, repository);
    if (!sprint.sprintBranch) {
      const head = await adapter.getBranchHead(repo, defaultBranch);
      if (!head) throw new Error(`${defaultBranch} doesn't exist in ${repository.fullPath}.`);
      await adapter.createBranch(repo, branch, head);
      const saved = await setSprintBranch(deps.db, deps.organizationId, sprint.id, branch);
      return { status: "ready", branch: saved?.sprintBranch ?? branch };
    }
    const merged = await adapter.mergeBranch(repo, {
      into: branch,
      from: defaultBranch,
      message: `Update ${branch} from ${defaultBranch}`,
    });
    if (merged.status === "conflicts") {
      return {
        status: "failed",
        reason: sprintBranchConflictReason(branch, defaultBranch, merged.hostMessage),
      };
    }
    if (merged.status === "refused") {
      return {
        status: "failed",
        reason: sprintBranchFailedReason(
          `bring ${branch} up to date with ${defaultBranch}`,
          merged.hostMessage,
        ),
      };
    }
    return { status: "ready", branch };
  } catch (error) {
    console.error(`Preparing sprint branch ${branch} of ${repository.fullPath} failed`, error);
    const what = sprint.sprintBranch
      ? `bring ${branch} up to date`
      : `create the sprint branch ${branch}`;
    return { status: "failed", reason: sprintBranchFailedReason(what, errorText(error)) };
  }
}

/**
 * The sprint branch a work item's lane in `repositoryId` is based on: its merge-together
 * sprint's branch when the item is an epic of a started sprint building in that repo, else null.
 */
export async function sprintBaseBranch(
  deps: Pick<DefaultBranchDeps, "db"> & { organizationId: string },
  input: { tracker: WorkItemTracker; issueId: string; repositoryId: string },
): Promise<string | null> {
  const found = await findStartedSprintEpic(
    deps.db,
    deps.organizationId,
    input.tracker,
    input.issueId,
  );
  if (!found?.sprint.mergeTogether || !found.sprint.sprintBranch) return null;
  return found.sprint.repositoryId === input.repositoryId ? found.sprint.sprintBranch : null;
}

/**
 * The branch a work item's new lane in a repository is based on: its sprint's branch
 * (`sprintBaseBranch`), else the repository's default branch, read from its code host.
 */
export async function laneBaseBranch(
  deps: DefaultBranchDeps & { organizationId: string },
  input: {
    tracker: WorkItemTracker;
    issueId: string;
    connection: ScmConnection;
    repository: Pick<Repository, "id" | "fullPath" | "externalId">;
  },
): Promise<string> {
  const sprintBranch = await sprintBaseBranch(deps, {
    tracker: input.tracker,
    issueId: input.issueId,
    repositoryId: input.repository.id,
  });
  return sprintBranch ?? fetchDefaultBranch(deps, input.connection, input.repository);
}
