import { DEFAULT_TRACKER_STATE_MAPPING, type TrackerStateMapping } from "@omniralph/db";
import { describe, expect, it } from "vitest";
import {
  readinessOf,
  readinessStateMatch,
  stateMappingSchema,
  validateStateMapping,
} from "./readiness";

/** Team A follows the types; team B overrides them with its own states. */
const mapping: TrackerStateMapping = {
  ready: { types: ["unstarted"] },
  needsRefining: { types: ["triage", "backlog"] },
  teams: { "team-b": { ready: ["b-review"], needsRefining: ["b-todo"] } },
};

describe("readinessOf", () => {
  it("matches state types for a team without an override", () => {
    const a = (stateType: string) =>
      readinessOf(mapping, { teamId: "team-a", stateId: `a-${stateType}`, stateType });
    expect(a("unstarted")).toBe("ready");
    expect(a("triage")).toBe("needs_refining");
    expect(a("backlog")).toBe("needs_refining");
    expect(a("started")).toBe("other");
    expect(a("completed")).toBe("other");
  });

  it("uses only the override's states for a team with one", () => {
    const b = (stateId: string | undefined, stateType: string) =>
      readinessOf(mapping, { teamId: "team-b", stateId, stateType });
    expect(b("b-review", "started")).toBe("ready");
    expect(b("b-todo", "unstarted")).toBe("needs_refining");
    // The type rule doesn't apply to team B.
    expect(b("b-other-todo", "unstarted")).toBe("other");
    expect(b("b-backlog", "backlog")).toBe("other");
    expect(b(undefined, "unstarted")).toBe("other");
  });

  it("makes Todo ready and Backlog needs refining by default", () => {
    const of = (stateType: string) =>
      readinessOf(DEFAULT_TRACKER_STATE_MAPPING, { teamId: "t", stateType });
    expect([of("unstarted"), of("backlog"), of("triage"), of("started")]).toEqual([
      "ready",
      "needs_refining",
      "other",
      "other",
    ]);
  });
});

describe("readinessStateMatch", () => {
  it("collects the types, the overridden teams and their states", () => {
    expect(readinessStateMatch(mapping, ["ready"])).toEqual({
      types: ["unstarted"],
      typesExceptTeamIds: ["team-b"],
      ids: ["b-review"],
    });
    expect(readinessStateMatch(mapping, ["ready", "needs_refining", "ready"])).toEqual({
      types: ["unstarted", "triage", "backlog"],
      typesExceptTeamIds: ["team-b"],
      ids: ["b-review", "b-todo"],
    });
  });
});

describe("validateStateMapping", () => {
  const states = new Map([["team-b", new Set(["b-review", "b-todo", "b-done"])]]);

  it("accepts a valid mapping", () => {
    expect(validateStateMapping(mapping, states)).toEqual({});
  });

  it("rejects unknown states, empty lists, overlaps and other types", () => {
    expect(
      validateStateMapping(
        {
          ready: { types: [] },
          needsRefining: { types: ["completed"] },
          teams: {
            "team-b": { ready: ["b-review", "a-todo"], needsRefining: [] },
            "team-c": { ready: ["c-1"], needsRefining: ["c-2"] },
          },
        },
        states,
      ),
    ).toEqual({
      "ready.types": "Choose at least one kind of state for Ready to start.",
      "needsRefining.types":
        "Needs refining can only use triage, backlog, unstarted or started states.",
      "teams.team-b.ready": "This state isn't in the team's workflow.",
      "teams.team-b.needsRefining": "Choose at least one state for Needs refining.",
      "teams.team-c.ready": "This state isn't in the team's workflow.",
      "teams.team-c.needsRefining": "This state isn't in the team's workflow.",
    });
    expect(
      validateStateMapping(
        {
          ready: { types: ["unstarted", "backlog"] },
          needsRefining: { types: ["backlog"] },
          teams: { "team-b": { ready: ["b-todo"], needsRefining: ["b-todo"] } },
        },
        states,
      ),
    ).toEqual({
      "needsRefining.types": "A state can't be both Ready to start and Needs refining.",
      "teams.team-b.needsRefining": "A state can't be both Ready to start and Needs refining.",
    });
  });

  it("parses only the mapping's shape", () => {
    expect(stateMappingSchema.safeParse(mapping).success).toBe(true);
    expect(stateMappingSchema.safeParse({ ...mapping, extra: 1 }).success).toBe(false);
    expect(stateMappingSchema.safeParse({ ready: { types: ["unstarted"] } }).success).toBe(false);
  });
});
