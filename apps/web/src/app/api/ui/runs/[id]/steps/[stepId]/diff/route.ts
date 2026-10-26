import { apiHandler } from "@/lib/api/handler";
import type { StoryDiff } from "@/lib/api/runs";
import { requireRunAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { loadStoryDiff } from "@/lib/runs/diff";

type Params = { id: string; stepId: string };

/**
 * The diff of an epic story's commit (at most 100 files, 2,000 lines per file), in any of
 * the user's organizations. A run outside the user's memberships, a step that isn't one of
 * its stories or a story without a commit is not found; a commit the code host doesn't have
 * yet answers 409. A commit's diff never changes, so this publishes and maps no change event.
 */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<StoryDiff> => {
    const { run } = await requireRunAccess(user, params.id, {
      notFoundMessage: "That run doesn't exist.",
    });
    return loadStoryDiff(getDb(), run, params.stepId);
  },
);
