import type { RoutingQuery } from "@omniralph/shared";
import { describe, expect, it, vi } from "vitest";
import type { RouteWorkItemMatch } from "@/lib/routing/resolve";
import { candidateFilters, compareBacklogEntries, ruleTeam, type BacklogEntry } from "./backlog";

vi.mock("server-only", () => ({}));

const team = (key: string): RoutingQuery => ({
  combinator: "and",
  rules: [{ field: "team", operator: "=", value: key }],
});
const labels = (...values: string[]): RoutingQuery => ({
  combinator: "and",
  rules: [{ field: "labels", operator: "containsAny", value: values }],
});

const match = (
  repositoryId: string,
  fields: Partial<RouteWorkItemMatch> = {},
): RouteWorkItemMatch => ({
  repositoryId,
  tracker: "linear",
  team: "ENG",
  project: null,
  withoutProject: false,
  labels: [],
  ...fields,
});

const repositories = [
  { id: "api", codingEnabled: true },
  { id: "web", codingEnabled: true },
  { id: "docs", codingEnabled: false },
];

describe("ruleTeam", () => {
  it("is the team of a top-level Team is condition", () => {
    expect(ruleTeam(team("SOC"))).toBe("SOC");
    expect(
      ruleTeam({
        combinator: "and",
        rules: [
          { field: "labels", operator: "containsAny", value: ["ui"] },
          { field: "team", operator: "=", value: "MOD" },
        ],
      }),
    ).toBe("MOD");
    // A group of that one condition, whatever its combinator.
    expect(ruleTeam({ ...team("SOC"), combinator: "or" })).toBe("SOC");
  });

  it("is null when the rule may match any team", () => {
    expect(ruleTeam(labels("ui"))).toBeNull();
    expect(ruleTeam({ ...team("SOC"), not: true })).toBeNull();
    expect(
      ruleTeam({
        combinator: "or",
        rules: [
          { field: "team", operator: "=", value: "SOC" },
          { field: "labels", operator: "containsAny", value: ["ui"] },
        ],
      }),
    ).toBeNull();
    expect(
      ruleTeam({ combinator: "and", rules: [{ field: "team", operator: "!=", value: "SOC" }] }),
    ).toBeNull();
    // Only top-level conditions count.
    expect(ruleTeam({ combinator: "and", rules: [team("SOC")] })).toBeNull();
    expect(
      ruleTeam({
        combinator: "and",
        rules: [{ field: "parent.team", operator: "=", value: "SOC" }],
      }),
    ).toBeNull();
  });
});

describe("candidateFilters", () => {
  it("has one filter per work item match of a repo with Coding on: team, project or no project, labels", () => {
    expect(
      candidateFilters({
        tracker: "linear",
        repositories,
        matches: [
          match("api", { project: "Portal" }),
          match("web", { team: "MOD", withoutProject: true, labels: ["ui", "web"] }),
          match("docs", { team: "DOC" }),
          match("gone", { team: "OLD" }),
        ],
        rules: [],
      }),
    ).toEqual([
      { teamKey: "ENG", projectName: "Portal" },
      { teamKey: "MOD", withoutProject: true, labelNames: ["ui", "web"] },
    ]);
  });

  it("has one filter per routing rule of a repo with Coding on: its Team is, else every team", () => {
    expect(
      candidateFilters({
        tracker: "linear",
        repositories,
        matches: [],
        rules: [
          { repositoryId: "api", query: team("SOC") },
          { repositoryId: "docs", query: team("DOC") },
          { repositoryId: "web", query: team("MOD") },
        ],
      }),
    ).toEqual([{ teamKey: "SOC" }, { teamKey: "MOD" }]);
    expect(
      candidateFilters({
        tracker: "linear",
        repositories,
        matches: [match("api"), match("web", { team: "MOD" })],
        rules: [
          { repositoryId: "api", query: team("SOC") },
          { repositoryId: "web", query: labels("ui") },
        ],
      }),
    ).toEqual([{}]);
  });

  it("leaves out a filter another one covers, and repeats none", () => {
    expect(
      candidateFilters({
        tracker: "linear",
        repositories,
        matches: [
          match("api", { labels: ["backend"] }),
          match("web", { project: "Portal", labels: ["ui"] }),
          match("api", { team: "MOD", labels: ["ui"] }),
          match("web", { team: "MOD", labels: ["ui", "web"] }),
        ],
        rules: [
          { repositoryId: "api", query: team("eng") },
          { repositoryId: "web", query: team("SOC") },
          { repositoryId: "api", query: team("SOC") },
        ],
      }),
    ).toEqual([
      { teamKey: "MOD", labelNames: ["ui", "web"] },
      { teamKey: "eng" },
      { teamKey: "SOC" },
    ]);
  });

  it("is empty without matches or rules of repos with Coding on", () => {
    expect(
      candidateFilters({
        tracker: "linear",
        repositories,
        matches: [match("docs")],
        rules: [{ repositoryId: "docs", query: labels("x") }],
      }),
    ).toEqual([]);
  });
});

describe("compareBacklogEntries", () => {
  const entry = (identifier: string, priority: number, updatedAt: string): BacklogEntry => ({
    row: { identifier } as BacklogEntry["row"],
    priority,
    updatedAt,
  });

  it("orders by priority, Urgent first and No priority last, then most recently updated", () => {
    const entries = [
      entry("none", 0, "2026-01-05T00:00:00Z"),
      entry("low", 4, "2026-01-01T00:00:00Z"),
      entry("high-old", 2, "2026-01-01T00:00:00Z"),
      entry("urgent", 1, "2026-01-01T00:00:00Z"),
      entry("high-new", 2, "2026-01-02T00:00:00Z"),
    ];
    expect(entries.sort(compareBacklogEntries).map((e) => e.row.identifier)).toEqual([
      "urgent",
      "high-new",
      "high-old",
      "low",
      "none",
    ]);
  });
});
