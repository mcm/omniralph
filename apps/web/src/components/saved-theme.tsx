"use client";

import { ThemeProvider, toast, type ThemePreference } from "@omniralph/ui";
import type * as React from "react";
import { saveThemePreference } from "@/lib/theme-actions";

export const THEME_SAVE_FAILED = "Couldn't save your theme preference.";

/**
 * Saves a theme choice the `ThemeProvider` has already applied. A failed save shows a toast
 * and rejects, so the provider restores the previous preference.
 */
async function saveTheme(preference: ThemePreference): Promise<void> {
  // Opts into the library's body cross-fade for this switch only (not on page load).
  document.documentElement.setAttribute("data-theme-transition", "");
  const result = await saveThemePreference(preference).catch(() => null);
  if (!result?.ok) {
    toast(THEME_SAVE_FAILED, { variant: "danger" });
    throw new Error(result?.error ?? THEME_SAVE_FAILED);
  }
}

/**
 * The signed-in theme: applies the user's saved preference (System follows the OS as it
 * changes), and saves every choice to their account so it follows them to every device.
 */
export function SavedThemeProvider({
  preference,
  children,
}: {
  preference: ThemePreference;
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider preference={preference} onPreferenceChange={saveTheme}>
      {children}
    </ThemeProvider>
  );
}
