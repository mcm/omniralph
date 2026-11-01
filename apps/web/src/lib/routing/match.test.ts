import type { WorkItemMatchFields } from "@omniralph/db";
import { describe, expect, it } from "vitest";
import {
  describeMatch,
  describeMatchRoute,
  matchesConflict,
  matchesWorkItem,
  matchSentence,
  specificity,
  type WorkItemValues,
} from "./match";

const match = (fields: Partial<WorkItemMatchFields> = {}): WorkItemMatchFields => ({
  tracker: "linear",
  team: "SOC",
  project: null,
  withoutProject: false,
  labels: [],
  ...fields,
});

const item = (fields: Partial<WorkItemValues> = {}): WorkItemValues => ({
  tracker: "linear",
  team: "SOC",
  project: null,
  labels: [],
  ...fields,
});

describe("matchesWorkItem", () => {
  it("matches the team, ignoring case", () => {
    expect(matchesWorkItem(match(), item())).toBe(true);
    expect(matchesWorkItem(match({ team: "soc" }), item({ team: "SOC" }))).toBe(true);
    expect(matchesWorkItem(match(), item({ team: "MOD" }))).toBe(false);
    expect(matchesWorkItem(match(), item({ team: null }))).toBe(false);
  });

  it("takes any project, or none, when it sets no project condition", () => {
    expect(matchesWorkItem(match(), item({ project: "Portal" }))).toBe(true);
    expect(matchesWorkItem(match(), item({ project: null }))).toBe(true);
  });

  it("matches a named project, ignoring case", () => {
    const portal = match({ project: "Create More Fans" });
    expect(matchesWorkItem(portal, item({ project: "create more FANS" }))).toBe(true);
    expect(matchesWorkItem(portal, item({ project: "Other" }))).toBe(false);
    expect(matchesWorkItem(portal, item({ project: null }))).toBe(false);
  });

  it('matches only work items without a project for "no project"', () => {
    const none = match({ withoutProject: true });
    expect(matchesWorkItem(none, item({ project: null }))).toBe(true);
    expect(matchesWorkItem(none, item({ project: "Portal" }))).toBe(false);
  });

  it("matches any of its labels, ignoring case", () => {
    const portal = match({ labels: ["product:portal", "product:app"] });
    expect(matchesWorkItem(portal, item({ labels: ["bug", "Product:App"] }))).toBe(true);
    expect(matchesWorkItem(portal, item({ labels: ["bug"] }))).toBe(false);
    expect(matchesWorkItem(portal, item({ labels: [] }))).toBe(false);
  });

  it("takes any labels with an empty label set", () => {
    expect(matchesWorkItem(match({ labels: [] }), item({ labels: [] }))).toBe(true);
    expect(matchesWorkItem(match({ labels: [] }), item({ labels: ["anything"] }))).toBe(true);
  });

  it("needs every condition it sets", () => {
    const both = match({ project: "Portal", labels: ["api"] });
    expect(matchesWorkItem(both, item({ project: "Portal", labels: ["api"] }))).toBe(true);
    expect(matchesWorkItem(both, item({ project: "Portal" }))).toBe(false);
    expect(matchesWorkItem(both, item({ labels: ["api"] }))).toBe(false);
  });
});

describe("specificity", () => {
  it("counts a project, no project and labels beyond the team", () => {
    expect(specificity(match())).toBe(0);
    expect(specificity(match({ project: "Portal" }))).toBe(1);
    expect(specificity(match({ withoutProject: true }))).toBe(1);
    expect(specificity(match({ labels: ["a", "b"] }))).toBe(1);
    expect(specificity(match({ project: "Portal", labels: ["a"] }))).toBe(2);
    expect(specificity(match({ withoutProject: true, labels: ["a"] }))).toBe(2);
  });
});

describe("describeMatch", () => {
  it("reads like the routed_by text", () => {
    expect(describeMatchRoute(match({ labels: ["product:portal"] }))).toBe(
      "work item match (Team is SOC, label product:portal)",
    );
    expect(describeMatch(match({ team: "MOD", project: "Create More Fans" }))).toBe(
      "Team is MOD, project Create More Fans",
    );
    expect(describeMatch(match({ withoutProject: true, labels: ["a", "b"] }))).toBe(
      "Team is SOC, no project, any label of a, b",
    );
  });
});

describe("matchSentence", () => {
  it("reads like the Coding card's sentence", () => {
    expect(matchSentence(match({ labels: ["product:portal"] }))).toBe(
      "Linear team SOC, label product:portal",
    );
    expect(matchSentence(match({ team: "MOD", withoutProject: true }))).toBe(
      "Linear team MOD, no project",
    );
    expect(matchSentence(match({ project: "Portal", labels: ["ui", "web"] }))).toBe(
      "Linear team SOC, project Portal, label ui or web",
    );
  });
});

describe("matchesConflict", () => {
  it("conflicts on the same team and project condition with intersecting or empty labels", () => {
    expect(matchesConflict(match(), match({ team: "soc" }))).toBe(true);
    expect(matchesConflict(match({ labels: ["A", "b"] }), match({ labels: ["a"] }))).toBe(true);
    expect(matchesConflict(match({ project: "P" }), match({ project: "p" }))).toBe(true);
    expect(matchesConflict(match({ withoutProject: true }), match({ withoutProject: true }))).toBe(
      true,
    );
  });

  it("doesn't conflict when a condition tells them apart", () => {
    expect(matchesConflict(match(), match({ team: "MOD" }))).toBe(false);
    expect(matchesConflict(match({ labels: ["a"] }), match({ labels: ["b"] }))).toBe(false);
    expect(matchesConflict(match({ labels: ["a"] }), match())).toBe(false);
    expect(matchesConflict(match({ project: "P" }), match({ project: "Q" }))).toBe(false);
    expect(matchesConflict(match({ project: "P" }), match())).toBe(false);
    expect(matchesConflict(match({ withoutProject: true }), match())).toBe(false);
    expect(matchesConflict(match({ withoutProject: true }), match({ project: "P" }))).toBe(false);
  });
});
