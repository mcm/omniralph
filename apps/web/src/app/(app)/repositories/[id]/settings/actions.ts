"use server";

import { updateRepositoryRalphSettings } from "@omniralph/db";
import { fieldErrors, RalphSettingsInput, RepositorySettingsInput } from "@omniralph/shared";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { saveRepositorySettings } from "@/lib/repositories/settings";

/**
 * Saves a repository's review settings. Newly pinned agents get a `repo.sync`
 * job; the next review job enqueued for the repository uses the new settings.
 */
export async function updateRepositorySettings(
  repositoryId: string,
  input: RepositorySettingsInput,
): Promise<ActionResult> {
  return runAdminAction(async () => {
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
          error: "Some selected agents don't exist or were revoked.",
          fieldErrors: { pinnedAgentIds: "Some selected agents don't exist or were revoked." },
        };
    }
    revalidatePath(`/repositories/${repositoryId}/settings`);
    revalidatePath("/repositories");
    revalidatePath("/agents", "layout");
  });
}

/**
 * Saves a repository's Ralph section: whether Linear delegations may build in
 * it, which Linear issues route to it, and how its runs work. New runs pick it up.
 */
export async function updateRalphSettings(
  repositoryId: string,
  input: RalphSettingsInput,
): Promise<ActionResult> {
  return runAdminAction(async () => {
    const parsed = RalphSettingsInput.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Fix the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    const { ralphEnabled, linearTeamKeys, linearProjectNames, linearLabels, ...settings } =
      parsed.data;
    const saved = await updateRepositoryRalphSettings(getDb(), repositoryId, {
      ralphEnabled,
      linearTeamKeys: linearTeamKeys.map((key) => key.toUpperCase()),
      linearProjectNames,
      linearLabels,
      ralphSettings: {
        openPullRequestEarly: settings.openPullRequestEarly,
        setupCommand: settings.setupCommand.trim() || null,
        model: settings.model,
      },
    });
    if (!saved) return { ok: false, error: "That repository isn't connected." };
    revalidatePath(`/repositories/${repositoryId}/settings`);
  });
}
