import { describe, expect, it } from "vitest";
import { DefinitionId, isBuiltinId } from "./index.js";

const UUID = "0b8f9c1e-4d2a-4f6b-9e3c-7a5d1c2b3e4f";

describe("isBuiltinId", () => {
  it("accepts builtin:<name> with lowercase letters, digits and -", () => {
    expect(isBuiltinId("builtin:learn-rule")).toBe(true);
    expect(isBuiltinId("builtin:triage2")).toBe(true);
  });

  it("rejects UUIDs and anything else", () => {
    expect(isBuiltinId(UUID)).toBe(false);
    expect(isBuiltinId("builtin:")).toBe(false);
    expect(isBuiltinId("builtin:Learn-Rule")).toBe(false);
    expect(isBuiltinId("builtin:learn_rule")).toBe(false);
    expect(isBuiltinId("builtin:a b")).toBe(false);
    expect(isBuiltinId(" builtin:learn-rule")).toBe(false);
    expect(isBuiltinId("custom:learn-rule")).toBe(false);
  });
});

describe("DefinitionId", () => {
  it("accepts a built-in ID or a UUID", () => {
    expect(DefinitionId.safeParse("builtin:chat-ask").success).toBe(true);
    expect(DefinitionId.safeParse(UUID).success).toBe(true);
  });

  it("rejects anything else", () => {
    expect(DefinitionId.safeParse("chat-ask").success).toBe(false);
    expect(DefinitionId.safeParse("builtin:Chat").success).toBe(false);
    expect(DefinitionId.safeParse("not-a-uuid-0000").success).toBe(false);
    expect(DefinitionId.safeParse("").success).toBe(false);
  });
});
