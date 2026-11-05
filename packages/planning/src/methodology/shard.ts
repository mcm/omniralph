/**
 * Sharding a feature's Plan into epics: the Plan's sections an epic can cover, and the
 * structural check of a sharding draft (every section covered or exempted, covers naming real
 * sections, epic→epic dependencies naming real epics without a cycle, each epic in the epic
 * format). A verifier session judges the rest (whether an epic really builds what it claims,
 * and whether it adds scope the Plan lacks).
 */
import { lintWorkItem } from "../work-item/lint.js";
import { sectionKey, splitSections } from "../work-item/parse.js";
import { PLAN_EPICS_SECTION, SUCCESS_METRICS_SECTION } from "./documents.js";

/** A `##` section of a Plan. */
export interface PlanSection {
  name: string;
  body: string;
}

/**
 * The sections of a Plan that epics may cover: its `##` sections but `## Epics` (the epics it
 * expects, where sharding starts) and `## Success metrics` (for people, never reaching a run).
 * A name repeated keeps its first section.
 */
export function planSections(plan: string): PlanSection[] {
  const skipped = new Set([sectionKey(PLAN_EPICS_SECTION), sectionKey(SUCCESS_METRICS_SECTION)]);
  const seen = new Set<string>();
  const sections: PlanSection[] = [];
  for (const section of splitSections(plan).sections) {
    const key = sectionKey(section.name);
    if (!key || skipped.has(key) || seen.has(key)) continue;
    seen.add(key);
    sections.push({ name: section.name, body: section.body });
  }
  return sections;
}

/** An epic of a sharding draft, as the check reads it. */
export interface ShardEpic {
  /** Its short key in the draft (`E1`), which other epics' `dependsOn` name. */
  key: string;
  title: string;
  /** The epic in the epic format. */
  description: string;
  /** The names of the Plan sections it builds. */
  covers: readonly string[];
  /** The keys of the epics it waits for (each becomes an epic→epic blocks relation). */
  dependsOn: readonly string[];
}

/** A section the draft says needs no epic (context, what is left out), and why. */
export interface ShardExemption {
  section: string;
  reason: string;
}

/**
 * The keys of a dependency cycle among `epics` (the first key repeated at the end:
 * `["E1", "E2", "E1"]`), or null when the dependencies are acyclic. Unknown keys are ignored.
 */
export function dependencyCycle(
  epics: readonly Pick<ShardEpic, "key" | "dependsOn">[],
): string[] | null {
  const byKey = new Map(epics.map((epic) => [epic.key, epic]));
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (key: string): string[] | null => {
    const at = state.get(key);
    if (at === "done") return null;
    if (at === "visiting") return [...path.slice(path.indexOf(key)), key];
    state.set(key, "visiting");
    path.push(key);
    for (const next of byKey.get(key)?.dependsOn ?? []) {
      // A dependency on itself is reported on its own (`checkShard`), not as a cycle.
      if (next === key || !byKey.has(next)) continue;
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(key, "done");
    return null;
  };
  for (const epic of epics) {
    const cycle = visit(epic.key);
    if (cycle) return cycle;
  }
  return null;
}

/** An epic as a problem names it. */
const named = (epic: Pick<ShardEpic, "key" | "title">) => `${epic.key} ("${epic.title}")`;

/**
 * Every structural problem of a sharding draft over the Plan's `sections`, one sentence each;
 * empty when it passes: no epics, a repeated key, an epic covering no section or a section the
 * Plan doesn't have, a section no epic covers that isn't exempted, an exemption of a section
 * the Plan doesn't have, a dependency on an unknown epic or on itself, a cycle, and an epic
 * that isn't in the epic format (`lintWorkItem`).
 */
export function checkShard(
  sections: readonly Pick<PlanSection, "name">[],
  draft: { epics: readonly ShardEpic[]; exempt: readonly ShardExemption[] },
): string[] {
  const problems: string[] = [];
  const { epics } = draft;
  if (epics.length === 0) return ["The draft has no epics."];

  const sectionKeys = new Map(sections.map((s) => [sectionKey(s.name), s.name]));
  const keys = new Set<string>();
  for (const epic of epics) {
    if (keys.has(epic.key)) problems.push(`Two epics have the key ${epic.key}: give each its own.`);
    keys.add(epic.key);
  }

  const covered = new Set<string>();
  for (const epic of epics) {
    if (epic.covers.length === 0) {
      problems.push(`Epic ${named(epic)} covers no section of the Plan.`);
    }
    for (const name of epic.covers) {
      const key = sectionKey(name);
      if (sectionKeys.has(key)) covered.add(key);
      else
        problems.push(`Epic ${named(epic)} covers "${name}", which isn't a section of the Plan.`);
    }
    for (const dependency of epic.dependsOn) {
      if (dependency === epic.key) {
        problems.push(`Epic ${named(epic)} depends on itself.`);
      } else if (!keys.has(dependency)) {
        problems.push(
          `Epic ${named(epic)} depends on ${dependency}, which isn't an epic of the draft.`,
        );
      }
    }
    for (const lint of lintWorkItem(epic.description, { format: "epic" })) {
      problems.push(`Epic ${named(epic)} isn't in the epic format: ${lint.message}`);
    }
  }

  const exempt = new Set<string>();
  for (const exemption of draft.exempt) {
    const key = sectionKey(exemption.section);
    if (sectionKeys.has(key)) exempt.add(key);
    else problems.push(`"${exemption.section}" is exempted, but it isn't a section of the Plan.`);
  }
  for (const [key, name] of sectionKeys) {
    if (!covered.has(key) && !exempt.has(key)) {
      problems.push(`No epic covers the Plan's "${name}" section.`);
    }
  }

  const cycle = dependencyCycle(epics);
  if (cycle) problems.push(`The epics' dependencies form a cycle: ${cycle.join(" → ")}.`);
  return problems;
}
