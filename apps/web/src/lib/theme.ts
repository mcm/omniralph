import type { UiTheme } from "@omniralph/db";

/** Control panel color theme, remembered per user in the database. */
export type Theme = UiTheme;

/** A valid stored theme, or `null` when none was chosen (follow the OS preference). */
export function parseTheme(value: unknown): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}

/**
 * Inline `<head>` script for `src/app/layout.tsx`. It runs before paint when the
 * server rendered no theme (signed out, or no choice saved yet), following the OS
 * preference to avoid a flash of the wrong theme. With no OS preference it falls
 * back to Polar Night (dark), the library's default.
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
