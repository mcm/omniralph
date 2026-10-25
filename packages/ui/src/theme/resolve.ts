/** The user's choice: follow the OS, or a fixed theme. */
export type ThemePreference = "system" | "dark" | "light";

/** The theme actually drawn. */
export type ResolvedTheme = "dark" | "light";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "dark", "light"];

/** The media query System follows; dark is the default when the OS states no preference. */
export const PREFERS_LIGHT_QUERY = "(prefers-color-scheme: light)";

/** The theme a preference draws, given whether the OS prefers light. */
export function resolveTheme(preference: ThemePreference, prefersLight: boolean): ResolvedTheme {
  if (preference === "system") return prefersLight ? "light" : "dark";
  return preference;
}
