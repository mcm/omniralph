import { describe, expect, it } from "vitest";
import {
  BUILTIN_TASKS,
  CORRELATION_OUTPUT_SCHEMA,
  correlationProblem,
  getBuiltinTask,
} from "./index.js";

const correlate = getBuiltinTask("builtin:correlate-findings")!;

describe("correlationProblem", () => {
  it("accepts builtin:correlate-findings and a clone of it, and no other built-in", () => {
    expect(correlationProblem(correlate)).toBeNull();
    expect(correlationProblem({ ...correlate, id: "custom" })).toBeNull();
    expect(BUILTIN_TASKS.filter((t) => correlationProblem(t) === null).map((t) => t.id)).toEqual([
      "builtin:correlate-findings",
    ]);
  });

  it("refuses a task of another type or trigger, or without the correlation output", () => {
    expect(correlationProblem({ ...correlate, triggers: ["chat.request"] })).toMatch(
      /isn't a query task started by run.invoked/,
    );
    expect(correlationProblem(getBuiltinTask("builtin:review-pr")!)).toMatch(/isn't a query task/);
    expect(correlationProblem({ ...correlate, outputSchema: undefined })).toMatch(
      /has no output schema/,
    );
    expect(
      correlationProblem({
        ...correlate,
        outputSchema: { type: "object", properties: { summary: { type: "string" } } },
      }),
    ).toMatch(/doesn't output the correlation/);
    expect(CORRELATION_OUTPUT_SCHEMA).toEqual(correlate.outputSchema);
  });
});
