import { getBuiltinTask } from "@omniralph/tasks";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MAX_SHARD_DESCRIPTION_LENGTH,
  MAX_SHARD_EPICS,
  MAX_SHARD_KEY_LENGTH,
  MAX_SHARD_NOTE_LENGTH,
  MAX_SHARD_SECTION_LENGTH,
  MAX_SHARD_TITLE_LENGTH,
  ShardPlanOutput,
  ShardVerifyOutput,
  sectionList,
} from "./feature-shard.js";

const schemaOf = (id: string) =>
  z.fromJSONSchema(getBuiltinTask(id)!.outputSchema as Parameters<typeof z.fromJSONSchema>[0]);

const epic = (key: string) => ({
  key,
  title: `Epic ${key}`,
  description: "## Problem\n\nX",
  covers: ["Approach"],
  dependsOn: [],
});

const passing = {
  verdict: "pass",
  uncoveredSections: [],
  inventedScope: [],
  dependencyProblems: [],
  epicNotes: [{ epic: "E1", note: "Covers the approach." }],
  summary: "Every section is covered.",
};

describe("ShardVerifyOutput", () => {
  it("refuses a pass that leaves a section uncovered, invented scope or a dependency problem", () => {
    expect(ShardVerifyOutput.safeParse(passing).success).toBe(true);
    for (const problem of [
      { uncoveredSections: [{ section: "Approach", note: "Nothing builds it." }] },
      { inventedScope: [{ epic: "E1", scope: "A billing page." }] },
      { dependencyProblems: ["E1 and E2 wait for each other."] },
    ]) {
      expect(ShardVerifyOutput.safeParse({ ...passing, ...problem }).success).toBe(false);
      expect(ShardVerifyOutput.safeParse({ ...passing, ...problem, verdict: "fail" }).success).toBe(
        true,
      );
    }
  });

  it("agrees with the verifier's output schema on the shape and the limits", () => {
    const schema = schemaOf("builtin:verify-shard");
    const full = {
      verdict: "fail",
      uncoveredSections: [
        { section: "x".repeat(MAX_SHARD_SECTION_LENGTH), note: "x".repeat(MAX_SHARD_NOTE_LENGTH) },
      ],
      inventedScope: [
        { epic: "x".repeat(MAX_SHARD_KEY_LENGTH), scope: "x".repeat(MAX_SHARD_NOTE_LENGTH) },
      ],
      dependencyProblems: ["x".repeat(MAX_SHARD_NOTE_LENGTH)],
      epicNotes: Array.from({ length: MAX_SHARD_EPICS }, (_, i) => ({ epic: `E${i}`, note: "ok" })),
      summary: "x".repeat(MAX_SHARD_NOTE_LENGTH),
    };
    for (const output of [passing, full]) {
      expect(schema.safeParse(output).success).toBe(true);
      expect(ShardVerifyOutput.safeParse(output).success).toBe(true);
    }
    const tooMuch = [
      { ...full, summary: "x".repeat(MAX_SHARD_NOTE_LENGTH + 1) },
      {
        ...full,
        epicNotes: Array.from({ length: MAX_SHARD_EPICS + 1 }, (_, i) => ({
          epic: `E${i}`,
          note: "ok",
        })),
      },
      { ...full, inventedScope: [{ epic: "x".repeat(MAX_SHARD_KEY_LENGTH + 1), scope: "y" }] },
    ];
    for (const output of tooMuch) {
      expect(schema.safeParse(output).success).toBe(false);
      expect(ShardVerifyOutput.safeParse(output).success).toBe(false);
    }
  });
});

describe("ShardPlanOutput", () => {
  it("agrees with the worker's output schema on the shape and the limits", () => {
    const schema = schemaOf("builtin:shard-plan");
    const full = {
      epics: Array.from({ length: MAX_SHARD_EPICS }, (_, i) => ({
        ...epic(`E${i}`),
        title: "x".repeat(MAX_SHARD_TITLE_LENGTH),
        description: "x".repeat(MAX_SHARD_DESCRIPTION_LENGTH),
      })),
      exempt: [{ section: "Context", reason: "Says why, builds nothing." }],
      summary: "Split by what each delivers.",
    };
    expect(schema.safeParse(full).success).toBe(true);
    expect(ShardPlanOutput.safeParse(full).success).toBe(true);

    const tooMuch = [
      { ...full, epics: [...full.epics, epic("E99")] },
      { ...full, epics: [] },
      { ...full, epics: [{ ...epic("E1"), title: "x".repeat(MAX_SHARD_TITLE_LENGTH + 1) }] },
    ];
    for (const output of tooMuch) {
      expect(schema.safeParse(output).success).toBe(false);
      expect(ShardPlanOutput.safeParse(output).success).toBe(false);
    }
  });
});

describe("sectionList", () => {
  it("lists each section on one line", () => {
    expect(sectionList([{ name: "Approach" }, { name: "Data\n model " }])).toBe(
      "- Approach\n- Data model",
    );
  });
});
