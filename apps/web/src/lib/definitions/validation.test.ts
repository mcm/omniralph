import {
  BUILTIN_AGENTS,
  BUILTIN_TASKS,
  getBuiltinTask,
  SINK_KINDS,
  validateTaskDefinition,
} from "@omniralph/tasks";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { sinkOutputs, taskValidationContext } = await import("./validation");

const context = taskValidationContext(BUILTIN_AGENTS, BUILTIN_TASKS);
const TASK_ID = "0b6f7a0e-8a3d-4e43-9a51-2a8c55a1f6e2";

describe("sinkOutputs", () => {
  it("says what every sink kind accepts", () => {
    const outputs = sinkOutputs();
    expect(Object.keys(outputs).sort()).toEqual([...SINK_KINDS].sort());
    expect(outputs["chat-thread"]).toEqual({ taskType: "query", output: "answer" });
    expect(outputs["run-result"]).toEqual({ taskType: "query", output: "any" });
    expect(outputs.review).toEqual({ taskType: "review" });
    expect(outputs["ralph-run"]).toEqual({ taskType: "coding" });
    expect(outputs["learned-rule"]).toMatchObject({
      taskType: "query",
      output: { schema: { type: "object", required: ["rule"] } },
    });
  });
});

describe("validating against the real sinks", () => {
  it("accepts every built-in task", () => {
    for (const task of BUILTIN_TASKS) {
      expect(validateTaskDefinition(task, context), task.id).toMatchObject({ ok: true });
    }
  });

  it("accepts a clone of a built-in", () => {
    for (const task of BUILTIN_TASKS) {
      expect(validateTaskDefinition({ ...task, id: TASK_ID }, context), task.id).toMatchObject({
        ok: true,
      });
    }
  });

  it("rejects an output schema the learned-rule sink doesn't accept", () => {
    const learn = getBuiltinTask("builtin:learn-rule")!;
    expect(
      validateTaskDefinition(
        {
          ...learn,
          id: TASK_ID,
          outputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
        context,
      ),
    ).toEqual({
      ok: false,
      fieldErrors: { sink: expect.stringContaining("`rule` must be required") },
    });
  });

  it("rejects a triage output schema missing a field the triage sink needs", () => {
    const triage = getBuiltinTask("builtin:triage")!;
    const schema = triage.outputSchema as { required: string[] };
    expect(
      validateTaskDefinition(
        {
          ...triage,
          id: TASK_ID,
          outputSchema: {
            ...schema,
            required: schema.required.filter((name) => name !== "summary"),
          },
        },
        context,
      ),
    ).toEqual({
      ok: false,
      fieldErrors: { sink: expect.stringContaining("`summary` must be required") },
    });
  });

  it("rejects a Markdown answer on the triage sink", () => {
    const { outputSchema: _schema, ...triage } = getBuiltinTask("builtin:triage")!;
    expect(validateTaskDefinition({ ...triage, id: TASK_ID }, context)).toEqual({
      ok: false,
      fieldErrors: { sink: expect.stringContaining("takes structured output") },
    });
  });
});
