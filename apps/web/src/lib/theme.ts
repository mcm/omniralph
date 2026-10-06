import type { UiTheme } from "@omniralph/db";

/** Control panel color theme, remembered per user in the database. */
export type Theme = UiTheme;

/** A valid stored theme, or `null` when none was chosen (follow the OS preference). */
export function parseTheme(value: unknown): Theme | null {
  return value === "light" || value === "dark" ? value : null;
}
