import { ROUTING_OPERATORS } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import { LINEAR_ROUTING_FIELDS, linearRoutingRulesSchema } from "./routing-fields";

const ISSUE_FIELDS = {
  identifier: "text",
  title: "text",
  description: "text",
  team: "one-of",
  project: "one-of",
  projectMilestone: "one-of",
  cycle: "one-of",
  state: "one-of",
  stateType: "one-of",
  priority: "one-of",
  assignee: "one-of",
  creator: "one-of",
  parent: "one-of",
  labels: "many-of",
  estimate: "number",
  dueDate: "date",
};

describe("LINEAR_ROUTING_FIELDS", () => {
  it("has every issue field, then the parent's and the source's, with their type's operators", () => {
    const expected = ["", "parent.", "source."].flatMap((prefix) =>
      Object.entries(ISSUE_FIELDS).map(([id, type]) => [`${prefix}${id}`, type]),
    );
    expect(LINEAR_ROUTING_FIELDS.map((f) => [f.id, f.type])).toEqual(expected);
    for (const field of LINEAR_ROUTING_FIELDS) {
      expect(field.operators).toBe(ROUTING_OPERATORS[field.type]);
    }
  });

  it("labels the related issues' fields with their issue", () => {
    const label = (id: string) => LINEAR_ROUTING_FIELDS.find((f) => f.id === id)?.label;
    expect(label("labels")).toBe("Labels");
    expect(label("parent.labels")).toBe("Parent › Labels");
    expect(label("source.team")).toBe("Source › Team");
  });

  it("feeds pickers from the workspace's lists or fixed values", () => {
    const options = (id: string) => LINEAR_ROUTING_FIELDS.find((f) => f.id === id)?.options;
    expect(options("team")).toEqual({ source: "teams" });
    expect(options("projectMilestone")).toEqual({ source: "projectMilestones" });
    expect(options("cycle")).toEqual({ source: "cycles" });
    expect(options("parent.assignee")).toEqual({ source: "users" });
    expect(options("source.labels")).toEqual({ source: "labels" });
    expect(options("title")).toBeNull();
    expect(options("parent")).toBeNull();
    const priority = options("priority");
    expect(priority && "values" in priority && priority.values.map((v) => v.value)).toEqual([
      "0",
      "1",
      "2",
      "3",
      "4",
    ]);
  });

  it("validates saved rules against the catalog, fixed values included", () => {
    const rule = (field: string, operator: string, value: unknown) => ({
      rules: [
        {
          repositoryId: "00000000-0000-4000-8000-000000000001",
          query: { combinator: "and", rules: [{ field, operator, value }] },
        },
      ],
    });
    expect(
      linearRoutingRulesSchema.safeParse(rule("source.stateType", "=", "started")).success,
    ).toBe(true);
    expect(linearRoutingRulesSchema.safeParse(rule("stateType", "=", "doing")).success).toBe(false);
    expect(
      linearRoutingRulesSchema.safeParse(rule("parent.priority", "in", ["1", "2"])).success,
    ).toBe(true);
    expect(linearRoutingRulesSchema.safeParse(rule("grandparent.team", "=", "ENG")).success).toBe(
      false,
    );
  });
});
