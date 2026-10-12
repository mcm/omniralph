import { describe, expect, it } from "vitest";
import { outputSchemaProblem } from "./output-schema.js";

const rule = {
  type: "object",
  properties: { rule: { anyOf: [{ type: "string", maxLength: 2000 }, { type: "null" }] } },
  required: ["rule"],
  additionalProperties: false,
};

describe("outputSchemaProblem", () => {
  it("accepts anything for an empty schema", () => {
    expect(outputSchemaProblem({ type: "string" }, {})).toBeNull();
    expect(outputSchemaProblem(true, true)).toBeNull();
  });

  it("accepts a schema with the same shape, ignoring value constraints", () => {
    expect(outputSchemaProblem(rule, rule)).toBeNull();
    expect(
      outputSchemaProblem(
        {
          type: "object",
          properties: { rule: { type: ["string", "null"] } },
          required: ["rule"],
          additionalProperties: false,
        },
        rule,
      ),
    ).toBeNull();
  });

  it("rejects a type the accepted schema doesn't allow", () => {
    expect(outputSchemaProblem({ type: "number" }, { type: "string" })).toBe(
      "the output may be number; it must be string.",
    );
    expect(outputSchemaProblem({ type: "integer" }, { type: "number" })).toBeNull();
    expect(outputSchemaProblem({}, { type: "string" })).toContain("may be any type");
    expect(
      outputSchemaProblem(
        {
          type: "object",
          properties: { rule: { type: ["string", "number"] } },
          required: ["rule"],
          additionalProperties: false,
        },
        rule,
      ),
    ).toContain("`rule` may be number");
  });

  it("needs every required property required", () => {
    expect(
      outputSchemaProblem(
        { type: "object", properties: { rule: { type: "string" } }, additionalProperties: false },
        rule,
      ),
    ).toBe("`rule` must be required.");
  });

  it("needs a closed object when the accepted one is closed", () => {
    expect(
      outputSchemaProblem(
        { type: "object", properties: { rule: { type: "string" } }, required: ["rule"] },
        rule,
      ),
    ).toContain("set additionalProperties to false");
    expect(
      outputSchemaProblem(
        {
          type: "object",
          properties: { rule: { type: "string" }, extra: { type: "string" } },
          required: ["rule"],
          additionalProperties: false,
        },
        rule,
      ),
    ).toBe("`extra` isn't accepted at all.");
  });

  it("compares enums, nested objects and array items", () => {
    const accepted = {
      type: "object",
      properties: {
        size: { type: "string", enum: ["S", "M", "L"] },
        stories: {
          type: "array",
          items: {
            type: "object",
            properties: { priority: { type: "number", enum: [1, 2] } },
            required: ["priority"],
          },
        },
      },
      required: ["size", "stories"],
    };
    const given = (size: object, priority: object) => ({
      type: "object",
      properties: {
        size,
        stories: {
          type: "array",
          items: { type: "object", properties: { priority }, required: ["priority"] },
        },
      },
      required: ["size", "stories"],
    });
    expect(outputSchemaProblem(given({ enum: ["S", "M"] }, { const: 1 }), accepted)).toBeNull();
    expect(outputSchemaProblem(given({ type: "string" }, { const: 1 }), accepted)).toContain(
      "`size` must be one of",
    );
    expect(outputSchemaProblem(given({ enum: ["XL"] }, { const: 1 }), accepted)).toContain(
      '`size` may be ["XL"]',
    );
    expect(outputSchemaProblem(given({ enum: ["S"] }, { const: 3 }), accepted)).toContain(
      "`stories.*.priority` may be [3]",
    );
  });

  it("needs every branch of a union accepted", () => {
    expect(
      outputSchemaProblem(
        { anyOf: [{ type: "string" }, { type: "null" }] },
        { type: ["string", "null"] },
      ),
    ).toBeNull();
    expect(
      outputSchemaProblem(
        { oneOf: [{ type: "string" }, { type: "boolean" }] },
        { anyOf: [{ type: "string" }, { type: "null" }] },
      ),
    ).toContain("may be boolean");
  });
});
