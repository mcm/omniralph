import { describe, expect, it } from "vitest";
import { parseTheme, parseThemePreference, THEME_BOOTSTRAP, themePreference } from "./theme";

describe("parseTheme", () => {
  it("accepts only light or dark, otherwise follows the OS (null)", () => {
    expect(parseTheme("light")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("system")).toBeNull();
    expect(parseTheme("")).toBeNull();
    expect(parseTheme(null)).toBeNull();
    expect(parseTheme(undefined)).toBeNull();
  });
});

describe("parseThemePreference", () => {
  it("stores System as null and Dark and Light as themselves", () => {
    expect(parseThemePreference("system")).toBeNull();
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("light")).toBe("light");
  });

  it("treats anything else as invalid", () => {
    for (const value of ["", "auto", "Dark", null, undefined, 1]) {
      expect(parseThemePreference(value)).toBeUndefined();
    }
  });
});

describe("themePreference", () => {
  it("reads a stored null as System", () => {
    expect(themePreference(null)).toBe("system");
    expect(themePreference("dark")).toBe("dark");
    expect(themePreference("light")).toBe("light");
  });
});

/** Runs the bootstrap against a fake `<html>` and returns the theme it leaves. */
function bootstrap({
  rendered,
  prefers,
}: {
  rendered?: string;
  /** The OS preference, `null` for none, `"throws"` when matchMedia fails, `"missing"` without it. */
  prefers: "light" | "dark" | null | "throws" | "missing";
}): string | undefined {
  const attributes = new Map<string, string>(rendered ? [["data-theme", rendered]] : []);
  const document = {
    documentElement: {
      hasAttribute: (name: string) => attributes.has(name),
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
    },
  };
  const window =
    prefers === "missing"
      ? {}
      : {
          matchMedia: (query: string) => {
            if (prefers === "throws") throw new Error("matchMedia unavailable");
            return { matches: prefers !== null && query === `(prefers-color-scheme: ${prefers})` };
          },
        };
  new Function("document", "window", THEME_BOOTSTRAP)(document, window);
  return attributes.get("data-theme");
}

describe("THEME_BOOTSTRAP", () => {
  it("falls back to dark (Ultraviolet's default) with no OS preference or no matchMedia", () => {
    expect(bootstrap({ prefers: null })).toBe("dark");
    expect(bootstrap({ prefers: "throws" })).toBe("dark");
    expect(bootstrap({ prefers: "missing" })).toBe("dark");
  });

  it("follows the OS preference", () => {
    expect(bootstrap({ prefers: "light" })).toBe("light");
    expect(bootstrap({ prefers: "dark" })).toBe("dark");
  });

  it("keeps the theme the server rendered from the saved choice", () => {
    expect(bootstrap({ rendered: "light", prefers: "dark" })).toBe("light");
    expect(bootstrap({ rendered: "dark", prefers: "light" })).toBe("dark");
  });
});
