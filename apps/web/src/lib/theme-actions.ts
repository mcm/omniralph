"use server";

import { setUserShowAdvanced, setUserTheme } from "@omniralph/db";
import { recordChange } from "@omniralph/db/changes";
import type { ThemePreference } from "@omniralph/ui";
import type { ActionResult } from "@/lib/action-result";
import { runSignedInAction } from "@/lib/auth/admin-action";
import type { CurrentUser } from "@/lib/auth/session";
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
    recordProfileChange(db, user);
  });
}

/**
 * Remembers whether the signed-in user's control panel shows advanced settings (see
 * `useShowAdvanced`). A UI preference only: it never changes what anything does. Like the
 * theme, the user's other devices hear of it as a `settings` change (section `profile`).
 */
export async function saveShowAdvancedPreference(value: boolean): Promise<ActionResult> {
  return runSignedInAction(async (user) => {
    if (typeof value !== "boolean") return { ok: false, error: "Unknown setting." };
    const db = getDb();
    await setUserShowAdvanced(db, user.id, value);
    recordProfileChange(db, user);
  });
}

/** Records a change to the user's own record on the user's own change channel. */
function recordProfileChange(db: unknown, user: CurrentUser): void {
  // An event names an organization; a user without one has no app shell listening.
  if (!user.organization) return;
  recordChange(db, {
    resource: "settings",
    section: "profile",
    ids: [user.id],
    organizationId: user.organization.id,
    userId: user.id,
  });
}
