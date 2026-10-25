"use server";

import { setUserTheme } from "@omniralph/db";
import { recordChange } from "@omniralph/db/changes";
import type { ThemePreference } from "@omniralph/ui";
import type { ActionResult } from "@/lib/action-result";
import { runSignedInAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";
import { parseThemePreference } from "@/lib/theme";

/**
 * Remembers the signed-in user's theme preference so every page renders in it, on any
 * device. System is stored as `null` (follow the OS). The user's other devices hear of it
 * live: a `settings` change (section `profile`) on the user's own change channel.
 */
export async function saveThemePreference(preference: ThemePreference): Promise<ActionResult> {
  const theme = parseThemePreference(preference);
  if (theme === undefined) return { ok: false, error: "Unknown theme." };
  return runSignedInAction(async (user) => {
    const db = getDb();
    await setUserTheme(db, user.id, theme);
    // An event names an organization; a user without one has no app shell listening.
    if (user.organization) {
      recordChange(db, {
        resource: "settings",
        section: "profile",
        ids: [user.id],
        organizationId: user.organization.id,
        userId: user.id,
      });
    }
  });
}
