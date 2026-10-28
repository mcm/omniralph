/**
 * The theme preference, kept in this browser: the agent page has no account to save it in.
 * Storage can be missing or refuse access (private modes, blocked cookies), so every read
 * and write is wrapped and falls back to System.
 */
import { THEME_PREFERENCES, type ThemePreference } from "@omniralph/ui";

export const THEME_STORAGE_KEY = "omniralph-agent-theme";

function isThemePreference(value: unknown): value is ThemePreference {
  return (THEME_PREFERENCES as readonly unknown[]).includes(value);
}

/** The saved preference, or `system` when there is none or storage can't be read. */
export function readThemePreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(saved) ? saved : "system";
  } catch {
    return "system";
  }
}

/** Saves the preference; a refusing storage only means it isn't remembered. */
export function saveThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Not remembered: the theme still applies for this visit.
  }
}
