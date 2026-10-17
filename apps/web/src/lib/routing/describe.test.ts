import { describe, expect, it } from "vitest";
import { LINEAR_ROUTING_FIELDS } from "@/lib/linear/routing-fields";
import { describeQuery, describeRule } from "./describe";

describe("describeRule", () => {
  it("reads as `rule N (…)` with the catalog's labels", () => {
    expect(
      describeRule(
        3,
        {
          combinator: "and",
          rules: [{ field: "labels", operator: "containsAny", value: ["backend"] }],
        },
        LINEAR_ROUTING_FIELDS,
      ),
    ).toBe("rule 3 (Labels contains any of backend)");
  });
});

describe("describeQuery", () => {
  it("joins conditions and groups in react-querybuilder's natural language", () => {
    expect(
      describeQuery(
        {
          combinator: "and",
          rules: [
            { field: "team", operator: "in", value: ["ENG", "OPS"] },
            {
              combinator: "or",
              not: true,
              rules: [
                { field: "priority", operator: "=", value: "1" },
                { field: "parent.estimate", operator: "between", value: [1, 3] },
                { field: "dueDate", operator: "null", value: null },
              ],
            },
          ],
        },
        LINEAR_ROUTING_FIELDS,
      ),
    ).toBe(
      "Team is any of ENG, OPS, and (Priority is Urgent, or Parent › Estimate between 1 and 3, " +
        "or Due date is empty) is not true",
    );
  });

  it("reads an empty rule as every issue", () => {
    expect(describeQuery({ combinator: "and", rules: [] }, LINEAR_ROUTING_FIELDS)).toBe(
      "every issue",
    );
  });
});
