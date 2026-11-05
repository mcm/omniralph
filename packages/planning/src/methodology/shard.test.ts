import { describe, expect, it } from "vitest";
import { checkShard, dependencyCycle, planSections, type ShardEpic } from "./shard.js";

const PLAN = `Intro text before any section.

## Context

Teams plan large work in loose docs.

## Storage

Store features and their documents.

## Review screen

Show drafts beside the sections they cover.

## Success metrics

Fewer hand-split epics.

## Epics

### Storage first

- Covers: Storage
`;

const EPIC = `## Problem

Planners split work by hand.

## Scope

### In

- Storage

### Out

- Nothing else

## Requirements

- FR-1: The system must store features.`;

const epic = (key: string, overrides: Partial<ShardEpic> = {}): ShardEpic => ({
  key,
  title: `Epic ${key}`,
  description: EPIC,
  covers: [],
  dependsOn: [],
  ...overrides,
});

describe("planSections", () => {
  it("lists the ## sections an epic can cover, leaving out Epics and Success metrics", () => {
    expect(planSections(PLAN).map((s) => s.name)).toEqual(["Context", "Storage", "Review screen"]);
    expect(planSections(PLAN)[1]).toEqual({
      name: "Storage",
      body: "Store features and their documents.",
    });
    expect(planSections("No sections at all.")).toEqual([]);
  });
});

describe("checkShard", () => {
  const sections = planSections(PLAN);

  it("passes a draft that covers or exempts every section, in the epic format, without cycles", () => {
    expect(
      checkShard(sections, {
        epics: [
          epic("E1", { covers: ["storage"] }),
          epic("E2", { covers: ["Review screen"], dependsOn: ["E1"] }),
        ],
        exempt: [{ section: "Context", reason: "Says why, builds nothing." }],
      }),
    ).toEqual([]);
  });

  it("fails a section no epic covers and nothing exempts", () => {
    expect(
      checkShard(sections, {
        epics: [epic("E1", { covers: ["Storage"] })],
        exempt: [{ section: "Context", reason: "Background." }],
      }),
    ).toEqual([`No epic covers the Plan's "Review screen" section.`]);
  });

  it("fails covers and exemptions naming sections the Plan doesn't have", () => {
    expect(
      checkShard(sections, {
        epics: [
          epic("E1", { covers: ["Storage", "Billing"] }),
          epic("E2", { covers: ["Review screen"] }),
        ],
        exempt: [
          { section: "Glossary", reason: "Words." },
          { section: "Context", reason: "Why." },
        ],
      }),
    ).toEqual([
      `Epic E1 ("Epic E1") covers "Billing", which isn't a section of the Plan.`,
      `"Glossary" is exempted, but it isn't a section of the Plan.`,
    ]);
  });

  it("fails a dependency cycle, naming it", () => {
    const problems = checkShard(sections, {
      epics: [
        epic("E1", { covers: ["Storage"], dependsOn: ["E3"] }),
        epic("E2", { covers: ["Review screen"], dependsOn: ["E1"] }),
        epic("E3", { covers: ["Context"], dependsOn: ["E2"] }),
      ],
      exempt: [],
    });
    expect(problems).toEqual(["The epics' dependencies form a cycle: E1 → E3 → E2 → E1."]);
  });

  it("fails unknown and self dependencies, repeated keys, empty covers and epics out of format", () => {
    expect(
      checkShard(sections, {
        epics: [
          epic("E1", { covers: ["Storage", "Context"], dependsOn: ["E1", "E9"] }),
          epic("E1", { covers: [] }),
          epic("E2", { covers: ["Review screen"], description: "Just build it." }),
        ],
        exempt: [],
      }),
    ).toEqual([
      "Two epics have the key E1: give each its own.",
      `Epic E1 ("Epic E1") depends on itself.`,
      `Epic E1 ("Epic E1") depends on E9, which isn't an epic of the draft.`,
      `Epic E1 ("Epic E1") covers no section of the Plan.`,
      `Epic E2 ("Epic E2") isn't in the epic format: The Problem section is missing.`,
      `Epic E2 ("Epic E2") isn't in the epic format: The Scope section is missing.`,
      `Epic E2 ("Epic E2") isn't in the epic format: The Requirements section is missing.`,
    ]);
  });

  it("fails a draft with no epics", () => {
    expect(checkShard(sections, { epics: [], exempt: [] })).toEqual(["The draft has no epics."]);
  });
});

describe("dependencyCycle", () => {
  it("is null for acyclic dependencies, ignoring unknown keys", () => {
    expect(
      dependencyCycle([
        { key: "A", dependsOn: [] },
        { key: "B", dependsOn: ["A", "Z"] },
        { key: "C", dependsOn: ["A", "B"] },
      ]),
    ).toBeNull();
  });

  it("finds a two-epic cycle", () => {
    expect(
      dependencyCycle([
        { key: "A", dependsOn: ["B"] },
        { key: "B", dependsOn: ["A"] },
      ]),
    ).toEqual(["A", "B", "A"]);
  });
});
