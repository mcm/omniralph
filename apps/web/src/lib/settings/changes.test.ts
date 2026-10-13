import { describe, expect, it } from "vitest";
import {
  formatLongText,
  isMultiLineChange,
  lineDiff,
  formatSettingValue,
  sameSettingValue,
  settingChanges,
  withDefault,
  withoutFieldErrors,
  type SettingSpec,
} from "./changes";

describe("formatLongText", () => {
  it("shows short one-line text whole and summarizes the rest", () => {
    expect(formatLongText("Review it.")).toBe("Review it.");
    expect(formatLongText("")).toBe("Not set");
    expect(formatLongText("a\nb")).toBe("2 lines, 3 characters");
    expect(formatLongText("x".repeat(1200))).toBe("1 line, 1,200 characters");
  });
});

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

describe("withoutFieldErrors", () => {
  it("drops a field's errors, including its list items", () => {
    expect(
      withoutFieldErrors(
        { verifyCommands: "a", "verifyCommands.2": "b", model: "c", verifyCommandsX: "d" },
        ["verifyCommands"],
      ),
    ).toEqual({ model: "c", verifyCommandsX: "d" });
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
  });
});
