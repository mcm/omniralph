import { describe, expect, it } from "vitest";
import { parseTheme, THEME_BOOTSTRAP } from "./theme";

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

/** Runs the bootstrap against a fake `<html>` and returns the theme it leaves. */
function bootstrap({
  rendered,
  prefers,
}: {
  rendered?: string;
  /** The OS preference, `null` for none, or `"throws"` when matchMedia is missing. */
  prefers: "light" | "dark" | null | "throws";
}): string | undefined {
  const attributes = new Map<string, string>(rendered ? [["data-theme", rendered]] : []);
  const document = {
    documentElement: {
      hasAttribute: (name: string) => attributes.has(name),
      setAttribute: (name: string, value: string) => void attributes.set(name, value),
    },
  };
  const window = {
    matchMedia: (query: string) => {
      if (prefers === "throws") throw new Error("matchMedia unavailable");
      return { matches: prefers !== null && query === `(prefers-color-scheme: ${prefers})` };
    },
  };
  new Function("document", "window", THEME_BOOTSTRAP)(document, window);
  return attributes.get("data-theme");
}

describe("THEME_BOOTSTRAP", () => {
  it("falls back to Polar Night (dark) with no saved theme and no OS preference", () => {
    expect(bootstrap({ prefers: null })).toBe("dark");
    expect(bootstrap({ prefers: "throws" })).toBe("dark");
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
