import { describe, expect, it } from "vitest";
import { parseTheme } from "./theme";

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
