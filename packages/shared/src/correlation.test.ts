import { getBuiltinTask } from "@omniralph/tasks";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CorrelationOutput } from "./correlation.js";
import { FINDING_CATEGORIES, FINDING_SEVERITIES } from "./finding.js";

const task = getBuiltinTask("builtin:correlate-findings")!;
const jsonSchema = z.fromJSONSchema(task.outputSchema as Parameters<typeof z.fromJSONSchema>[0]);

const merged = {
  sourceFindingIds: ["a", "b"],
  sourceTaskIds: ["builtin:review-pr", "builtin:security-review"],
  path: "src/app.ts",
  startLine: 2,
  endLine: 2,
  severity: "high",
  category: "security",
  title: "Token logged",
  body: "The token is logged.",
  suggestion: null,
  confidence: 0.95,
};

describe("CorrelationOutput", () => {
  it("accepts what builtin:correlate-findings' output schema accepts", () => {
    for (const output of [
      { findings: [merged], summary: "Adds logging." },
      { findings: [{ ...merged, suggestion: undefined }], summary: "" },
      { findings: [], summary: "Nothing overlaps." },
    ]) {
      expect(jsonSchema.safeParse(output).success).toBe(true);
      expect(CorrelationOutput.safeParse(output).success).toBe(true);
    }
  });

  it("rejects what the output schema rejects", () => {
    for (const output of [
      { findings: [merged] },
      { findings: [{ ...merged, sourceFindingIds: [] }], summary: "" },
      { findings: [{ ...merged, severity: "urgent" }], summary: "" },
      { findings: [{ ...merged, category: "style" }], summary: "" },
      { findings: [{ ...merged, confidence: 2 }], summary: "" },
    ]) {
      expect(jsonSchema.safeParse(output).success).toBe(false);
      expect(CorrelationOutput.safeParse(output).success).toBe(false);
    }
  });

  it("uses the finding severities and categories", () => {
    const item = (
      task.outputSchema as {
        properties: { findings: { items: { properties: Record<string, { enum?: unknown }> } } };
      }
    ).properties.findings.items.properties;
    expect(item.severity!.enum).toEqual([...FINDING_SEVERITIES]);
    expect(item.category!.enum).toEqual([...FINDING_CATEGORIES]);
  });
});
