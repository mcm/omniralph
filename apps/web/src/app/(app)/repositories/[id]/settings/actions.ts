"use server";

import { getRepository, setRepositorySwitches, updateRepositoryRalphSettings } from "@omniralph/db";
import {
  fieldErrors,
  RalphSettingsInput,
  ralphSettingsFromInput,
  RepositorySettingsInput,
  RepositoryTaskTypesInput,
} from "@omniralph/shared";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { ralphTaskErrors, saveRepositorySettings } from "@/lib/repositories/settings";

/** Refreshes a repository's settings tabs (Review settings, Coding and Harnesses). */
function revalidateRepositorySettings(repositoryId: string) {
  for (const tab of ["settings", "coding", "harnesses"]) {
    revalidatePath(`/repositories/${repositoryId}/${tab}`);
  }
}

/**
 * Saves a repository's review settings, including which review tasks its
 * review runs fan out to and the task correlating their findings (built-in or
 * the organization's own). Newly pinned harnesses get a `repo.sync`
 * job; the next review job enqueued for the repository uses the new settings.
 */
export async function updateRepositorySettings(
  repositoryId: string,
  input: RepositorySettingsInput,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const parsed = RepositorySettingsInput.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Fix the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    const result = await saveRepositorySettings(
      getDb(),
      getDispatcher(),
      admin.organization.id,
      repositoryId,
      parsed.data,
    );
    switch (result.status) {
      case "unknown_repository":
        return { ok: false, error: "That repository isn't connected." };
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
    revalidateRepositorySettings(repositoryId);
    revalidatePath("/repositories");
    revalidatePath("/harnesses", "layout");
  });
}

/**
 * Saves which task types a repository runs: Query (externally triggered queries), Reviews and
 * Coding, each on, off, or `null` to inherit the organization's default. The next trigger,
 * claim or delegation uses the new values.
 */
export async function updateRepositoryTaskTypes(
  repositoryId: string,
  input: RepositoryTaskTypesInput,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const parsed = RepositoryTaskTypesInput.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Fix the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    if (!(await setRepositorySwitches(getDb(), admin.organization.id, repositoryId, parsed.data))) {
      return { ok: false, error: "That repository isn't connected." };
    }
    revalidateRepositorySettings(repositoryId);
    revalidatePath("/repositories");
  });
}

/**
 * Saves a repository's Coding tab: which Linear issues route to it, whether its runs use the legacy jobs or
 * coding tasks (`coding_path`) and which story and request tasks (built-in
 * or the organization's own), and how its runs work (cyralph's
 * per-repository settings). The next job and decision of every run pick it up.
 */
export async function updateRalphSettings(
  repositoryId: string,
  input: RalphSettingsInput,
): Promise<ActionResult> {
  return runAdminAction(async (admin) => {
    const parsed = RalphSettingsInput.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Fix the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    const {
      linearTeamKeys,
      linearProjectNames,
      linearLabels,
      codingPath,
      storyTaskId,
      requestTaskId,
    } = parsed.data;
    const db = getDb();
    if (!(await getRepository(db, repositoryId, admin.organization.id))) {
      return { ok: false, error: "That repository isn't connected." };
    }
    const taskErrors = await ralphTaskErrors(db, admin.organization.id, parsed.data);
    if (Object.keys(taskErrors).length > 0) {
      return { ok: false, error: "Fix the highlighted fields.", fieldErrors: taskErrors };
    }
    const saved = await updateRepositoryRalphSettings(db, repositoryId, {
      linearTeamKeys: linearTeamKeys.map((key) => key.toUpperCase()),
      linearProjectNames,
      linearLabels,
      ralphSettings: ralphSettingsFromInput(parsed.data),
      codingPath,
      storyTaskId,
      requestTaskId,
    });
    if (!saved) return { ok: false, error: "That repository isn't connected." };
    revalidateRepositorySettings(repositoryId);
  });
}
