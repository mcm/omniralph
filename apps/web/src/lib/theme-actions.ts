"use server";

import { setUserTheme } from "@omniralph/db";
import type { ThemePreference } from "@omniralph/ui";
import type { ActionResult } from "@/lib/action-result";
import { requireSignedInUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { parseThemePreference } from "@/lib/theme";

/**
 * Remembers the signed-in user's theme preference so every page renders in it, on any
 * device. System is stored as `null` (follow the OS).
 */
export async function saveThemePreference(preference: ThemePreference): Promise<ActionResult> {
  const user = await requireSignedInUser();
  const theme = parseThemePreference(preference);
  if (theme === undefined) return { ok: false, error: "Unknown theme." };
  await setUserTheme(getDb(), user.id, theme);
  return { ok: true };
}
