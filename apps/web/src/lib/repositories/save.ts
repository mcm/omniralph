import "server-only";
import {
  getRepository,
  setRepositorySwitches,
  updateRepositoryRalphSettings,
  withSettingsChanges,
} from "@omniralph/db";
import {
  fieldErrors,
  RalphSettingsInput,
  ralphSettingsFromInput,
  RepositorySettingsInput,
  RepositoryTaskTypesInput,
} from "@omniralph/shared";
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
import { ralphLinearErrors, ralphTaskErrors, saveRepositorySettings } from "./settings";

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
 * Saves a repository's review settings, including which review tasks its
 * review runs fan out to and the task correlating their findings (built-in or
 * the organization's own). Newly pinned harnesses get a `repo.sync`
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
  const result = await withSettingsChanges(
    getDb(),
    settingsActor(user),
    [
      trackedRepositoryReviews(organizationId, repositoryId),
      trackedRepositoryAgents(organizationId, repositoryId),
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
    case "unknown_profile":
      return {
        ok: false,
        error: "That profile doesn't exist.",
        fieldErrors: { profileId: "That profile doesn't exist." },
      };
    case "unknown_agents":
      return {
        ok: false,
        error: "Some selected harnesses don't exist or were revoked.",
        fieldErrors: { pinnedHarnessIds: "Some selected harnesses don't exist or were revoked." },
      };
    case "unknown_review_tasks":
      return {
        ok: false,
        error: "Some selected review tasks don't exist.",
        fieldErrors: { reviewTaskIds: "Some selected review tasks don't exist." },
      };
    case "unknown_correlation_task":
      return {
        ok: false,
        error: "That correlation task doesn't exist.",
        fieldErrors: {
          correlationTaskId:
            "Choose a query task of this organization that outputs the correlation's findings and summary.",
        },
      };
  }
  return { ok: true };
}

/**
 * Saves which task types a repository runs: Query (externally triggered queries), Reviews and
 * Coding, each on, off, or `null` to inherit the organization's default. The next trigger,
 * claim or delegation uses the new values.
 */
export async function updateRepositoryTaskTypes(
  user: Saver,
  repositoryId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = RepositoryTaskTypesInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const organizationId = user.organization.id;
  // The review switch is part of the review settings; coding and query of the coding settings.
  const saved = await withSettingsChanges(
    getDb(),
    settingsActor(user),
    [
      trackedRepositoryReviews(organizationId, repositoryId),
      trackedRepositoryCoding(organizationId, repositoryId),
    ],
    (tx) => setRepositorySwitches(tx, organizationId, repositoryId, parsed.data),
  );
  return saved ? { ok: true } : NOT_CONNECTED;
}

/**
 * Saves a repository's Coding tab: whether its runs use the legacy jobs or coding tasks (`coding_path`) and which story and request tasks (built-in
 * or the organization's own), and how its runs work (cyralph's
 * per-repository settings). New Linear values must exist in the connected workspace
 * (`ralphLinearErrors`). The next job and decision of every run pick it up.
 */
export async function updateRepositoryCodingSettings(
  user: Saver,
  repositoryId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = RalphSettingsInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const organizationId = user.organization.id;
  const { codingPath, storyTaskId, requestTaskId } = parsed.data;
  const db = getDb();
  const repository = await getRepository(db, repositoryId, organizationId);
  if (!repository) return NOT_CONNECTED;
  const [taskErrors, linearErrors] = await Promise.all([
    ralphTaskErrors(db, organizationId, parsed.data),
    ralphLinearErrors(organizationId, repository, parsed.data),
  ]);
  if (linearErrors === "unavailable") {
    return {
      ok: false,
      error: "Couldn't check the Linear values against your workspace. Try again in a moment.",
    };
  }
  const errors = { ...taskErrors, ...linearErrors };
  if (Object.keys(errors).length > 0) {
    return { ok: false, error: "Fix the highlighted fields.", fieldErrors: errors };
  }
  const saved = await withSettingsChanges(
    db,
    settingsActor(user),
    trackedRepositoryCoding(organizationId, repositoryId),
    (tx) =>
      updateRepositoryRalphSettings(tx, repositoryId, {
        ralphSettings: ralphSettingsFromInput(parsed.data),
        codingPath,
        storyTaskId,
        requestTaskId,
      }),
  );
  return saved ? { ok: true } : NOT_CONNECTED;
}
