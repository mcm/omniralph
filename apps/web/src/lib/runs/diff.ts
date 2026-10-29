import "server-only";
import {
  getRalphRunDetailFacts,
  getRepositoryWithConnection,
  type Database,
  type RunIndexEntry,
  type ScmConnection,
} from "@omniralph/db";
import {
  CommitNotFoundError,
  DEFAULT_COMMIT_DIFF_MAX_FILES,
  type ScmAdapter,
} from "@omniralph/scm";
import { ApiRouteError } from "@/lib/api/handler";
import type { StoryDiff } from "@/lib/api/runs";
import { scmAdapterFor } from "@/lib/scm/adapters";

const PROVIDER_NAMES = { github: "GitHub", gitlab: "GitLab" } as const;

export const STORY_DIFF_NOT_FOUND = "That story has no commit.";

/**
 * The diff of an epic story's commit, read from its lane's repository (the run's own
 * repository when the story has no lane). A step that isn't a story of this epic, or a
 * story without a commit, is not found (404); a commit the code host doesn't have yet
 * answers 409.
 */
export async function loadStoryDiff(
  db: Database,
  run: RunIndexEntry,
  stepId: string,
  adapterFor: (
    db: Database,
    connection: ScmConnection,
  ) => Pick<ScmAdapter, "getCommitDiff"> = scmAdapterFor,
): Promise<StoryDiff> {
  const facts = run.kind === "epic" ? await getRalphRunDetailFacts(db, run.id) : null;
  const story = facts?.stories.find((s) => s.id === stepId);
  if (!facts || !story?.commitSha) throw ApiRouteError.notFound(STORY_DIFF_NOT_FOUND);
  const lane =
    (story.laneId && facts.lanes.find((l) => l.id === story.laneId)) ||
    facts.lanes.find((l) => l.main) ||
    null;
  const found =
    lane && (await getRepositoryWithConnection(db, lane.repository.id, run.organizationId));
  if (!found) throw ApiRouteError.notFound(STORY_DIFF_NOT_FOUND);
  const { repository, connection } = found;
  try {
    const diff = await adapterFor(db, connection).getCommitDiff(
      { fullPath: repository.fullPath, externalId: repository.externalId },
      story.commitSha,
      { maxFiles: DEFAULT_COMMIT_DIFF_MAX_FILES },
    );
    return { ...diff, provider: repository.provider };
  } catch (error) {
    if (error instanceof CommitNotFoundError) {
      throw new ApiRouteError(
        409,
        `This commit isn't on ${PROVIDER_NAMES[repository.provider]} yet.`,
        "commit_not_found",
      );
    }
    throw error;
  }
}
