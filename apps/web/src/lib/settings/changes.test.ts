import { describe, expect, it } from "vitest";
import {
  changeDiff,
  isMultiLineChange,
  lineDiff,
  formatSettingValue,
  sameSettingValue,
  settingChanges,
  withDefault,
  type SettingSpec,
} from "./changes";

describe("formatSettingValue", () => {
  it("shows flags as On/Off, empty values as Not set and lists comma-separated", () => {
    expect(formatSettingValue(true)).toBe("On");
    expect(formatSettingValue(false)).toBe("Off");
    expect(formatSettingValue("")).toBe("Not set");
    expect(formatSettingValue("  ")).toBe("Not set");
    expect(formatSettingValue(null)).toBe("Not set");
    expect(formatSettingValue([])).toBe("Not set");
    expect(formatSettingValue(["a", "b"])).toBe("a, b");
    expect(formatSettingValue("opus")).toBe("opus");
  });

  it("groups numbers and names what isn't one", () => {
    expect(formatSettingValue(200_000)).toBe("200,000");
    expect(formatSettingValue(Number.NaN)).toBe("Not a number");
  });
});

describe("sameSettingValue", () => {
  it("compares lists element by element, in order", () => {
    expect(sameSettingValue(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameSettingValue(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameSettingValue(["a"], ["a", "b"])).toBe(false);
    expect(sameSettingValue([], "")).toBe(false);
  });

  it("treats two unparsable numbers as the same", () => {
    expect(sameSettingValue(Number.NaN, Number.NaN)).toBe(true);
    expect(sameSettingValue(3, Number.NaN)).toBe(false);
  });
});

describe("settingChanges", () => {
  const specs: SettingSpec<"enabled" | "model" | "commands">[] = [
    { key: "enabled", label: "Enable Ralph" },
    { key: "model", label: "Model" },
    { key: "commands", label: "Verify commands", format: (v) => String(v).toUpperCase() },
  ];

  it("lists only the changed settings, in spec order, old → new", () => {
    expect(
      settingChanges(
        specs,
        { enabled: false, model: "opus", commands: ["pnpm test"] },
        { enabled: true, model: "opus", commands: ["pnpm test", "pnpm lint"] },
      ),
    ).toEqual([
      { key: "enabled", label: "Enable Ralph", from: "Off", to: "On" },
      { key: "commands", label: "Verify commands", from: "PNPM TEST", to: "PNPM TEST,PNPM LINT" },
    ]);
  });

  it("is empty when nothing changed", () => {
    const values = { enabled: true, model: "opus", commands: [] };
    expect(settingChanges(specs, values, { ...values, commands: [] })).toEqual([]);
  });
});

describe("withDefault", () => {
  it("appends the default as a sentence", () => {
    expect(withDefault("Jobs at once.", "1")).toBe("Jobs at once. Default: 1.");
  });
});

describe("lineDiff", () => {
  it("keeps unchanged lines and marks only the changed ones", () => {
    expect(
      lineDiff("pnpm lint\npnpm typecheck\npnpm test", "pnpm typecheck\npnpm test\npnpm e2e"),
    ).toEqual([
      { kind: "removed", text: "pnpm lint" },
      { kind: "same", text: "pnpm typecheck" },
      { kind: "same", text: "pnpm test" },
      { kind: "added", text: "pnpm e2e" },
    ]);
  });

  it("puts a replaced line's removal before its addition", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "same", text: "c" },
    ]);
  });

  it("tells multi-line changes from one-line ones", () => {
    expect(isMultiLineChange({ from: "a", to: "b" })).toBe(false);
    expect(isMultiLineChange({ from: "Not set", to: "a\nb" })).toBe(true);
    expect(isMultiLineChange({ from: "a", to: "x".repeat(81) })).toBe(true);
  });

  it("diffs a value against Not set as only added or only removed lines", () => {
    expect(changeDiff({ from: "Not set", to: "You review.\nBe brief." })).toEqual([
      { kind: "added", text: "You review." },
      { kind: "added", text: "Be brief." },
    ]);
    expect(changeDiff({ from: "a\nb", to: "Not set" })).toEqual([
      { kind: "removed", text: "a" },
      { kind: "removed", text: "b" },
    ]);
    expect(changeDiff({ from: "a\nb", to: "a\nc" })).toEqual(lineDiff("a\nb", "a\nc"));
  });
});
