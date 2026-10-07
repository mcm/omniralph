"use server";

import { setUserTheme } from "@omniralph/db";
import type { ActionResult } from "@/lib/action-result";
import { requireSignedInUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { parseTheme } from "@/lib/theme";

/** Remembers the signed-in user's theme so every page renders in it, on any device. */
export async function saveThemePreference(theme: string): Promise<ActionResult> {
  const user = await requireSignedInUser();
  const parsed = parseTheme(theme);
  if (!parsed) return { ok: false, error: "Unknown theme." };
  await setUserTheme(getDb(), user.id, parsed);
  return { ok: true };
}
