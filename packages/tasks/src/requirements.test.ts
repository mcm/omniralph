import { describe, expect, it } from "vitest";
import { TaskRequirements } from "./requirements.js";

describe("TaskRequirements", () => {
  it("defaults to no installables, host tools or minimum agent version", () => {
    expect(TaskRequirements.parse({})).toEqual({
      minAgentVersion: null,
      installables: [],
      hostTools: [],
    });
  });

  it("keeps what was derived", () => {
    const derived = { minAgentVersion: "0.40.0", installables: ["node"], hostTools: ["git"] };
    expect(TaskRequirements.parse(derived)).toEqual(derived);
  });

  it("rejects a malformed minimum agent version", () => {
    expect(TaskRequirements.safeParse({ minAgentVersion: "" }).success).toBe(false);
    expect(TaskRequirements.safeParse({ minAgentVersion: 1 }).success).toBe(false);
  });
});
