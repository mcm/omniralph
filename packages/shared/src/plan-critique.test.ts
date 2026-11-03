import { getBuiltinTask } from "@omniralph/tasks";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MAX_PLAN_CRITIQUE_ITEM_LENGTH,
  MAX_PLAN_CRITIQUE_NOTE_LENGTH,
  MAX_PLAN_CRITIQUE_NOTES,
  MAX_PLAN_CRITIQUE_QUESTION_LENGTH,
  MAX_PLAN_CRITIQUE_QUESTIONS,
  MAX_PLAN_CRITIQUE_STORIES,
  MAX_PLAN_CRITIQUE_TEXT_LENGTH,
  PlanCritiqueOutput,
  planCritiqueContext,
  type PlanCritiqueNote,
} from "./plan-critique.js";

const critic = getBuiltinTask("builtin:critique-plan")!;
const criticSchema = z.fromJSONSchema(
  critic.outputSchema as Parameters<typeof z.fromJSONSchema>[0],
);

const note = (item: string, ok = true): PlanCritiqueNote => ({
  item,
  ok,
  note: ok ? `${item} holds.` : `${item} is missing.`,
});

const passing = {
  verdict: "pass",
  notes: [note("task-format"), note("checkable-criteria")],
  openQuestions: [],
};

describe("PlanCritiqueOutput", () => {
  it("reads a pass, and a fail with unmet items and open questions", () => {
    expect(PlanCritiqueOutput.parse(passing)).toEqual(passing);
    const failing = {
      verdict: "fail",
      notes: [note("task-format"), note("located-cause", false)],
      openQuestions: ["Should a blank timezone fall back to UTC or to the browser's?"],
    };
    expect(PlanCritiqueOutput.parse(failing)).toEqual(failing);
  });

  it("trims notes and questions", () => {
    const parsed = PlanCritiqueOutput.parse({
      verdict: "fail",
      notes: [{ item: " reproduction ", ok: false, note: "  No steps.  " }],
      openQuestions: ["  Which repo?  "],
    });
    expect(parsed.notes[0]).toEqual({ item: "reproduction", ok: false, note: "No steps." });
    expect(parsed.openQuestions).toEqual(["Which repo?"]);
  });

  it("rejects a pass with an unmet item or an open question", () => {
    const unmet = PlanCritiqueOutput.safeParse({
      ...passing,
      notes: [note("task-format"), note("story-order", false)],
    });
    expect(unmet.success).toBe(false);
    expect(unmet.error?.issues[0]).toMatchObject({
      path: ["notes", 1, "ok"],
      message: expect.stringContaining("story-order"),
    });
    const asking = PlanCritiqueOutput.safeParse({ ...passing, openQuestions: ["Which repo?"] });
    expect(asking.success).toBe(false);
    expect(asking.error?.issues[0]?.path).toEqual(["openQuestions"]);
  });

  it("rejects a critique without notes, a blank note and anything past the limits", () => {
    const invalid = [
      { ...passing, notes: [] },
      { ...passing, verdict: "maybe" },
      { ...passing, notes: [{ item: "task-format", ok: true, note: "   " }] },
      { ...passing, notes: [{ item: "", ok: true, note: "Fine." }] },
      { ...passing, notes: [note("x".repeat(MAX_PLAN_CRITIQUE_ITEM_LENGTH + 1))] },
      {
        ...passing,
        notes: [
          { item: "task-format", ok: true, note: "x".repeat(MAX_PLAN_CRITIQUE_NOTE_LENGTH + 1) },
        ],
      },
      {
        ...passing,
        notes: Array.from({ length: MAX_PLAN_CRITIQUE_NOTES + 1 }, (_, i) => note(`item-${i}`)),
      },
      {
        verdict: "fail",
        notes: [note("task-format", false)],
        openQuestions: Array.from({ length: MAX_PLAN_CRITIQUE_QUESTIONS + 1 }, () => "Why?"),
      },
      {
        verdict: "fail",
        notes: [note("task-format", false)],
        openQuestions: ["x".repeat(MAX_PLAN_CRITIQUE_QUESTION_LENGTH + 1)],
      },
      { verdict: "fail", notes: [note("task-format", false)] },
    ];
    for (const output of invalid) expect(PlanCritiqueOutput.safeParse(output).success).toBe(false);
  });

  it("agrees with the critic's output schema on the shape and the limits", () => {
    const valid = [
      passing,
      {
        verdict: "fail",
        notes: Array.from({ length: MAX_PLAN_CRITIQUE_NOTES }, (_, i) => ({
          item: "x".repeat(MAX_PLAN_CRITIQUE_ITEM_LENGTH),
          ok: i > 0,
          note: "x".repeat(MAX_PLAN_CRITIQUE_NOTE_LENGTH),
        })),
        openQuestions: Array.from({ length: MAX_PLAN_CRITIQUE_QUESTIONS }, () =>
          "x".repeat(MAX_PLAN_CRITIQUE_QUESTION_LENGTH),
        ),
      },
    ];
    for (const output of valid) {
      expect(criticSchema.safeParse(output).success).toBe(true);
      expect(PlanCritiqueOutput.safeParse(output).success).toBe(true);
    }
    const tooLong = [
      { ...passing, notes: [note("x".repeat(MAX_PLAN_CRITIQUE_ITEM_LENGTH + 1))] },
      {
        verdict: "fail",
        notes: [note("a", false)],
        openQuestions: Array.from({ length: MAX_PLAN_CRITIQUE_QUESTIONS + 1 }, () => "Why?"),
      },
      { ...passing, notes: [] },
    ];
    for (const output of tooLong) {
      expect(criticSchema.safeParse(output).success).toBe(false);
      expect(PlanCritiqueOutput.safeParse(output).success).toBe(false);
    }
    // The session must answer exactly the schema; the reader just drops anything extra.
    expect(criticSchema.safeParse({ ...passing, extra: true }).success).toBe(false);
  });
});

describe("planCritiqueContext", () => {
  it("flags the draft's size and carries no stories for a Fix or a Story", () => {
    const story = {
      title: "Badge",
      body: "I want you to show it.",
      kind: "story",
      dependsOn: [],
      manual: false,
    } as const;
    for (const size of ["fix", "story"] as const) {
      const context = planCritiqueContext({
        size,
        title: "Fix the\n blank timezone  crash",
        description: "I want you to fix it.",
        stories: [story],
      });
      expect(context).toEqual({
        size,
        fix: size === "fix",
        story: size === "story",
        epic: false,
        draft: {
          title: "Fix the blank timezone crash",
          description: "I want you to fix it.",
          stories: null,
        },
      });
    }
  });

  it("numbers an epic's stories by their 0-based position, and cuts what is past the limits", () => {
    const story = (title: string, dependsOn: number[] = []) => ({
      title,
      body: "x".repeat(MAX_PLAN_CRITIQUE_TEXT_LENGTH + 10),
      kind: "story" as const,
      dependsOn,
      manual: false,
    });
    const context = planCritiqueContext({
      size: "epic",
      title: "Priorities",
      description: "y".repeat(MAX_PLAN_CRITIQUE_TEXT_LENGTH + 10),
      stories: [
        story("Store"),
        story("Show", [0]),
        ...Array.from({ length: MAX_PLAN_CRITIQUE_STORIES }, (_, i) => story(`S${i}`)),
      ],
    });
    expect(context.epic).toBe(true);
    expect(context.draft.description).toHaveLength(MAX_PLAN_CRITIQUE_TEXT_LENGTH);
    expect(context.draft.stories).toHaveLength(MAX_PLAN_CRITIQUE_STORIES);
    expect(context.draft.stories![1]).toMatchObject({ index: 1, title: "Show", dependsOn: [0] });
    expect(context.draft.stories![0]!.body).toHaveLength(MAX_PLAN_CRITIQUE_TEXT_LENGTH);
  });

  it("gives an epic drafted without stories an empty list", () => {
    expect(
      planCritiqueContext({ size: "epic", title: "Priorities", description: "## Problem" }).draft
        .stories,
    ).toEqual([]);
  });
});
