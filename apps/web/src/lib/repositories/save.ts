import "server-only";
import { getRepository, setRepositorySwitches, updateRepositoryRalphSettings } from "@omniralph/db";
import {
  fieldErrors,
  RalphSettingsInput,
  ralphSettingsFromInput,
  RepositorySettingsInput,
  RepositoryTaskTypesInput,
} from "@omniralph/shared";
import type { ActionResult } from "@/lib/action-result";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { ralphLinearErrors, ralphTaskErrors, saveRepositorySettings } from "./settings";

/** The saves of Repository › Review settings, Coding and Harnesses, for `/api/ui`'s handlers. */

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
  organizationId: string,
  repositoryId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = RepositorySettingsInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  const result = await saveRepositorySettings(
    getDb(),
    getDispatcher(),
    organizationId,
    repositoryId,
    parsed.data,
  );
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
  organizationId: string,
  repositoryId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = RepositoryTaskTypesInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
  if (!(await setRepositorySwitches(getDb(), organizationId, repositoryId, parsed.data))) {
    return NOT_CONNECTED;
  }
  return { ok: true };
}

/**
 * Saves a repository's Coding tab: whether its runs use the legacy jobs or coding tasks (`coding_path`) and which story and request tasks (built-in
 * or the organization's own), and how its runs work (cyralph's
 * per-repository settings). New Linear values must exist in the connected workspace
 * (`ralphLinearErrors`). The next job and decision of every run pick it up.
 */
export async function updateRepositoryCodingSettings(
  organizationId: string,
  repositoryId: string,
  input: unknown,
): Promise<ActionResult> {
  const parsed = RalphSettingsInput.safeParse(input);
  if (!parsed.success) return invalid(parsed.error);
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
  const saved = await updateRepositoryRalphSettings(db, repositoryId, {
    ralphSettings: ralphSettingsFromInput(parsed.data),
    codingPath,
    storyTaskId,
    requestTaskId,
  });
  return saved ? { ok: true } : NOT_CONNECTED;
}
