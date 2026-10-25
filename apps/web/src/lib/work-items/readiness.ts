/**
 * The readiness state mapping: which workflow states mean "Ready to start" and which
 * "Needs refining". By state type by default (every team of a tracker shares the types),
 * with optional per-team overrides by workflow state ID, which replace the type rule for
 * that team only.
 */
import type { TrackerStateMapping } from "@omniralph/db";
import { z } from "zod";
import type { WorkItemReadiness, WORK_ITEM_READINESS } from "./tracker";

/** State types a readiness may use: open states before work starts (or just after). */
export const READINESS_STATE_TYPES = ["triage", "backlog", "unstarted", "started"] as const;

const readinessKeys = { ready: "ready", needs_refining: "needsRefining" } as const;
const readinessLabels = { ready: "Ready to start", needsRefining: "Needs refining" } as const;

/** The shape of a mapping (`PUT …/state-mapping`); `validateStateMapping` checks the rest. */
export const stateMappingSchema = z.strictObject({
  ready: z.strictObject({ types: z.array(z.string().min(1)).max(10) }),
  needsRefining: z.strictObject({ types: z.array(z.string().min(1)).max(10) }),
  teams: z.record(
    z.string().min(1),
    z.strictObject({
      ready: z.array(z.string().min(1)).max(100),
      needsRefining: z.array(z.string().min(1)).max(100),
    }),
  ),
}) satisfies z.ZodType<TrackerStateMapping>;

/** A work item's readiness: its team's override first, then its state's type. */
export function readinessOf(
  mapping: TrackerStateMapping,
  item: { teamId: string; stateId?: string | null; stateType: string },
): WorkItemReadiness {
  const team = mapping.teams[item.teamId];
  if (team) {
    if (!item.stateId) return "other";
    if (team.ready.includes(item.stateId)) return "ready";
    if (team.needsRefining.includes(item.stateId)) return "needs_refining";
    return "other";
  }
  if (mapping.ready.types.includes(item.stateType)) return "ready";
  if (mapping.needsRefining.types.includes(item.stateType)) return "needs_refining";
  return "other";
}

/**
 * The state a work item of team `teamId` moves to for a readiness: the first of the team's
 * override states in workflow order, else the first state of the mapping's first type that
 * the team has. Null when the team has none. `states` are the team's, in workflow order.
 */
export function readinessTargetState<S extends { id: string; type: string }>(
  mapping: TrackerStateMapping,
  teamId: string,
  readiness: (typeof WORK_ITEM_READINESS)[number],
  states: readonly S[],
): S | null {
  const key = readinessKeys[readiness];
  const team = mapping.teams[teamId];
  if (team) return states.find((state) => team[key].includes(state.id)) ?? null;
  for (const type of mapping[key].types) {
    const state = states.find((s) => s.type === type);
    if (state) return state;
  }
  return null;
}

/**
 * The states of some readiness values, for a tracker query: a state of one of `types` in a
 * team without an override, or one of the override states `ids`.
 */
export function readinessStateMatch(
  mapping: TrackerStateMapping,
  readiness: ReadonlyArray<(typeof WORK_ITEM_READINESS)[number]>,
): { types: string[]; typesExceptTeamIds: string[]; ids: string[] } {
  const keys = [...new Set(readiness)].map((r) => readinessKeys[r]);
  return {
    types: [...new Set(keys.flatMap((key) => mapping[key].types))],
    typesExceptTeamIds: Object.keys(mapping.teams),
    ids: [
      ...new Set(Object.values(mapping.teams).flatMap((team) => keys.flatMap((key) => team[key]))),
    ],
  };
}

/**
 * Field errors of a mapping (empty when it is valid): an empty list, a state type other
 * than `READINESS_STATE_TYPES`, a state ID that isn't in its team's workflow
 * (`statesByTeam`, the team's workflow state IDs), or a type or state in both lists.
 */
export function validateStateMapping(
  mapping: TrackerStateMapping,
  statesByTeam: ReadonlyMap<string, ReadonlySet<string>>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const allowed: readonly string[] = READINESS_STATE_TYPES;
  for (const key of ["ready", "needsRefining"] as const) {
    const types = mapping[key].types;
    const path = `${key}.types`;
    if (types.length === 0) {
      errors[path] = `Choose at least one kind of state for ${readinessLabels[key]}.`;
    } else if (types.some((type) => !allowed.includes(type))) {
      errors[path] =
        `${readinessLabels[key]} can only use triage, backlog, unstarted or started states.`;
    }
  }
  if (!errors["needsRefining.types"]) {
    const ready = new Set(mapping.ready.types);
    if (mapping.needsRefining.types.some((type) => ready.has(type))) {
      errors["needsRefining.types"] = "A state can't be both Ready to start and Needs refining.";
    }
  }
  for (const [teamId, team] of Object.entries(mapping.teams)) {
    const known = statesByTeam.get(teamId) ?? new Set<string>();
    for (const key of ["ready", "needsRefining"] as const) {
      const ids = team[key];
      const path = `teams.${teamId}.${key}`;
      if (ids.length === 0) {
        errors[path] = `Choose at least one state for ${readinessLabels[key]}.`;
      } else if (ids.some((id) => !known.has(id))) {
        errors[path] = "This state isn't in the team's workflow.";
      }
    }
    const path = `teams.${teamId}.needsRefining`;
    if (!errors[path]) {
      const ready = new Set(team.ready);
      if (team.needsRefining.some((id) => ready.has(id))) {
        errors[path] = "A state can't be both Ready to start and Needs refining.";
      }
    }
  }
  return errors;
}
