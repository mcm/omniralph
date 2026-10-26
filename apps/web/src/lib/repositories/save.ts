import "server-only";
import {
  getRepository,
  setRepositorySwitches,
  updateRepositoryCoding,
  withSettingsChanges,
} from "@omniralph/db";
import {
  fieldErrors,
  RepositorySettingsInput,
  RepositoryTaskTypesInput,
  type RepositoryCodingInput,
} from "@omniralph/shared";
import type { RepositoryCoding, RepositoryTaskTypes } from "@/lib/api/repositories";
import type { ActionResult } from "@/lib/action-result";
import type { OrgUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { bumpHarnessHeartbeat } from "@/lib/harnesses/heartbeat-cache";
import {
  settingsActor,
  trackedRepositoryAgents,
  trackedRepositoryCoding,
  trackedRepositoryReviews,
} from "@/lib/settings-history/sections";
import { repositoryCoding } from "./detail";
import { saveRepositorySettings } from "./settings";
import { refusingCodingWithoutMatch } from "./work-item-match";

/**
 * The saves of Repository › Review settings, Coding and Harnesses, for `/api/ui`'s handlers.
 * Each records what it changed in the repository's change history (`withSettingsChanges`).
 */

/** The admin saving, in their active organization. */
type Saver = Pick<OrgUser, "id" | "name" | "email" | "organization">;

const NOT_CONNECTED: ActionResult = { ok: false, error: "That repository isn't connected." };

function invalid(error: Parameters<typeof fieldErrors>[0]): ActionResult {
  return { ok: false, error: "Fix the highlighted fields.", fieldErrors: fieldErrors(error) };
}

/**
 * Saves a repository's review settings, including (when given) its playbook bindings: which
 * review playbooks its review runs fan out to, the playbook correlating their findings, and its
 * story and request playbooks (built-in or the organization's own, of a role the binding takes). Newly pinned harnesses get a `repo.sync`
 * job; the next review job enqueued for the repository uses the new settings.
 */
export async function updateRepositoryReviewSettings(
  user: Saver,
  repositoryId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = RepositorySettingsInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const organizationId = user.organization.id;
  const codingBindings =
    parsed.data.storyPlaybookId !== undefined || parsed.data.requestPlaybookId !== undefined;
  const result = await withSettingsChanges(
    getDb(),
    settingsActor(user),
    [
      trackedRepositoryReviews(organizationId, repositoryId),
      trackedRepositoryAgents(organizationId, repositoryId),
      ...(codingBindings ? [trackedRepositoryCoding(organizationId, repositoryId)] : []),
    ],
    (tx) => saveRepositorySettings(tx, getDispatcher(), organizationId, repositoryId, parsed.data),
  );
  if (result.status === "saved") {
    // The bumps in the transaction ran before its commit: bump again once it's visible.
    for (const id of [...result.pinnedHarnessIds, ...result.unpinnedHarnessIds]) {
      await bumpHarnessHeartbeat(id);
    }
  }
  switch (result.status) {
    case "unknown_repository":
      return NOT_CONNECTED;
    case "unknown_agents":
      return {
        ok: false,
        error: "Some selected harnesses don't exist or were revoked.",
        fieldErrors: { pinnedHarnessIds: "Some selected harnesses don't exist or were revoked." },
      };
    case "invalid_bindings":
      return { ok: false, error: "Fix the highlighted fields.", fieldErrors: result.fieldErrors };
  }
  return { ok: true };
}

/**
 * Saves a repository's switches (`RepositoryTaskTypesInput`): Reviews, Coding and Ask, each on
 * or off. Turning Coding on needs a work item match (409 otherwise; a repository that already
 * has Coding on keeps it). Publishes the repository's change; the next trigger, claim or
 * delegation uses the new values. Answers the saved switches.
 */
export async function updateRepositoryTaskTypes(
  user: Saver,
  repositoryId: string,
  input: unknown,
): Promise<RepositoryTaskTypes | ActionResult> {
  const parsed = RepositoryTaskTypesInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const organizationId = user.organization.id;
  // The reviews switch is part of the review settings; coding and ask of the coding settings.
  const saved = await refusingCodingWithoutMatch(() =>
    withSettingsChanges(
      getDb(),
      settingsActor(user),
      [
        trackedRepositoryReviews(organizationId, repositoryId),
        trackedRepositoryCoding(organizationId, repositoryId),
      ],
      (tx) => setRepositorySwitches(tx, organizationId, repositoryId, parsed.data),
    ),
  );
  return saved ?? NOT_CONNECTED;
}

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
