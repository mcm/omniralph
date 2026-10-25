import type { UiTheme } from "@omniralph/db";
import type { ThemePreference } from "@omniralph/ui";

/** Control panel color theme, remembered per user in the database. */
export type Theme = UiTheme;

/** A valid stored theme, or `null` when none was chosen (follow the OS preference). */
export function parseTheme(value: unknown): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

/**
 * The stored theme for a chosen preference: System is `null` (follow the OS), Dark and
 * Light are themselves. `undefined` when the value is no preference at all.
 */
export function parseThemePreference(value: unknown): Theme | null | undefined {
  if (value === "system") return null;
  if (value === "dark" || value === "light") return value;
  return undefined;
}

/** The preference a stored theme stands for: `null` is System. */
export function themePreference(theme: Theme | null): ThemePreference {
  return theme ?? "system";
}

/**
 * Inline `<head>` script for `src/app/layout.tsx`. It runs before paint when the
 * server rendered no theme (signed out, or no choice saved yet), following the OS
 * preference to avoid a flash of the wrong theme. With no OS preference it falls
 * back to dark, Ultraviolet's default.
 */
export const THEME_BOOTSTRAP = `
(function(){
  var root = document.documentElement;
  if (root.hasAttribute('data-theme')) return;
  try {
    root.setAttribute('data-theme', window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  } catch (_) {
    root.setAttribute('data-theme', 'dark');
  }
})();
`;
