import "server-only";
import { getRepository, updateRepositoryCoding, withSettingsChanges } from "@omniralph/db";
import type { RepositoryCodingInput } from "@omniralph/shared";
import type { RepositoryCoding } from "@/lib/api/repositories";
import type { ActionResult } from "@/lib/action-result";
import type { OrgUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { settingsActor, trackedRepositoryCoding } from "@/lib/settings-history/sections";
import { repositoryCoding } from "./detail";
import { refusingCodingWithoutMatch } from "./work-item-match";

/**
 * The Coding policy save, for `/api/ui`'s handler (the Repos page's other cards save in
 * `./cards`). It records what it changed in the repository's change history (`withSettingsChanges`).
 */

/** The admin saving, in their active organization. */
type Saver = Pick<OrgUser, "id" | "name" | "email" | "organization">;

const NOT_CONNECTED: ActionResult = { ok: false, error: "That repository isn't connected." };

/**
 * Saves a repository's coding policy (`RepositoryCodingInput`, validated by the handler): the
 * coding switch, extra instructions, open PR early, history rewrite, and responding to reviews
 * and CI. Turning Coding on needs a work item match (409 otherwise). Publishes the repository's `repository.coding` change; the next job and decision of
 * every run pick it up. Answers the saved policy, or why there's none.
 */
export async function updateRepositoryCodingSettings(
  user: Saver,
  repositoryId: string,
  input: RepositoryCodingInput,
): Promise<RepositoryCoding | ActionResult> {
  const organizationId = user.organization.id;
  const db = getDb();
  const repository = await getRepository(db, repositoryId, organizationId);
  if (!repository || repository.disconnectedAt) return NOT_CONNECTED;
  const saved = await refusingCodingWithoutMatch(() =>
    withSettingsChanges(
      db,
      settingsActor(user),
      trackedRepositoryCoding(organizationId, repositoryId),
      (tx) =>
        updateRepositoryCoding(tx, repositoryId, {
          codingEnabled: input.codingEnabled,
          codingInstructions: input.codingInstructions,
          openPullRequestEarly: input.openPullRequestEarly,
          historyRewrite: input.historyRewrite,
          respondToReviewsAndCi: input.respondToReviewsAndCi,
        }),
    ),
  );
  if (!saved) return NOT_CONNECTED;
  return repositoryCoding(db, saved);
}
