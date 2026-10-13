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
};

describe("unknownLinearValues", () => {
  it("returns nothing when every value exists, ignoring case", () => {
    expect(
      unknownLinearValues(options, {
        labels: ["RALPH", "Backend"],
        projects: ["omniralph"],
        teamKeys: ["eng", "OPS"],
        manualLabels: ["manual"],
        epicCompletedState: "in review",
      }),
    ).toEqual({
      labels: [],
      projects: [],
      teamKeys: [],
      manualLabels: [],
      epicCompletedState: null,
    });
  });

  it("returns the values missing from the workspace, as saved and in order", () => {
    expect(
      unknownLinearValues(options, {
        labels: ["ralph", "Renamed", "gone"],
        projects: ["Old Project", "Omniralph"],
        teamKeys: ["ENG", "QA"],
        manualLabels: ["manual", "by-hand"],
        epicCompletedState: "Shipped",
      }),
    ).toEqual({
      labels: ["Renamed", "gone"],
      projects: ["Old Project"],
      teamKeys: ["QA"],
      manualLabels: ["by-hand"],
      epicCompletedState: "Shipped",
    });
  });

  it("matches team keys, not team names", () => {
    expect(unknownLinearValues(options, { teamKeys: ["Engineering"] }).teamKeys).toEqual([
      "Engineering",
    ]);
  });

  it.each(["started", "completed", "Completed", "", "  ", null, undefined])(
    "always accepts the epic state %j",
    (epicCompletedState) => {
      const empty = { teams: [], labels: [], projects: [], states: [] };
      expect(unknownLinearValues(empty, { epicCompletedState }).epicCompletedState).toBeNull();
    },
  );

  it("treats absent lists as empty", () => {
    expect(unknownLinearValues(options, {})).toEqual({
      labels: [],
      projects: [],
      teamKeys: [],
      manualLabels: [],
      epicCompletedState: null,
    });
  });
});
