import { describe, expect, it } from "vitest";
import { unknownLinearValues, type LinearSettingsOptions } from "./settings-values";

const options: LinearSettingsOptions = {
  teams: [
    { key: "ENG", name: "Engineering" },
    { key: "OPS", name: "Operations" },
  ],
  labels: ["backend", "Manual", "ralph"],
  projects: ["Omniralph"],
  states: ["Done", "In Review"],
  projectMilestones: [],
  cycles: [],
  users: [],
};

describe("unknownLinearValues", () => {
  it("returns nothing when every value exists, ignoring case", () => {
    expect(
      unknownLinearValues(options, {
        manualLabels: ["manual", "RALPH"],
        blockedLabels: ["BACKEND"],
        epicCompletedState: "in review",
      }),
    ).toEqual({
      manualLabels: [],
      blockedLabels: [],
      epicCompletedState: null,
    });
  });

  it("returns the values missing from the workspace, as saved and in order", () => {
    expect(
      unknownLinearValues(options, {
        manualLabels: ["manual", "by-hand", "gone"],
        blockedLabels: ["on-hold", "backend"],
        epicCompletedState: "Shipped",
      }),
    ).toEqual({
      manualLabels: ["by-hand", "gone"],
      blockedLabels: ["on-hold"],
      epicCompletedState: "Shipped",
    });
  });

  it.each(["started", "completed", "Completed", "", "  ", null, undefined])(
    "always accepts the epic state %j",
    (epicCompletedState) => {
      const empty = {
        teams: [],
        labels: [],
        projects: [],
        states: [],
        projectMilestones: [],
        cycles: [],
        users: [],
      };
      expect(unknownLinearValues(empty, { epicCompletedState }).epicCompletedState).toBeNull();
    },
  );

  it("treats absent lists as empty", () => {
    expect(unknownLinearValues(options, {})).toEqual({
      manualLabels: [],
      blockedLabels: [],
      epicCompletedState: null,
    });
  });
});
