import { describe, expect, it } from "vitest";
import { TaskRequirements } from "./requirements.js";

describe("TaskRequirements", () => {
  it("defaults to no installables, host tools or minimum harness version", () => {
    expect(TaskRequirements.parse({})).toEqual({
      minHarnessVersion: null,
      installables: [],
      hostTools: [],
    });
  });

  it("keeps what was derived", () => {
    const derived = { minHarnessVersion: "0.40.0", installables: ["node"], hostTools: ["git"] };
    expect(TaskRequirements.parse(derived)).toEqual(derived);
  });

  it("rejects a malformed minimum harness version", () => {
    expect(TaskRequirements.safeParse({ minHarnessVersion: "" }).success).toBe(false);
    expect(TaskRequirements.safeParse({ minHarnessVersion: 1 }).success).toBe(false);
  });
});
