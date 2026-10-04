import { describe, expect, it } from "vitest";
import { CapabilityRegistry, defaultCapabilities, type Capability } from "./index.js";
import { REVIEW_TOOL_POLICY } from "./review.js";

describe("capability registry", () => {
  it("ships the review capability for review.run jobs", () => {
    const registry = new CapabilityRegistry(defaultCapabilities());
    expect(registry.names()).toEqual(["review"]);
    expect(registry.forJob({ capability: "review", type: "review.run" })?.name).toBe("review");
    expect(registry.forJob({ capability: "review", type: "review.other" })).toBeUndefined();
    expect(registry.forJob({ capability: "ralph", type: "review.run" })).toBeUndefined();
  });

  it("keeps review sessions read-only", () => {
    expect([...REVIEW_TOOL_POLICY.allowedTools].sort()).toEqual(["Glob", "Grep", "Read"]);
    for (const tool of ["Bash", "Write", "Edit", "WebFetch", "WebSearch"]) {
      expect(REVIEW_TOOL_POLICY.disallowedTools).toContain(tool);
    }
    expect(REVIEW_TOOL_POLICY.permissionMode).not.toBe("bypassPermissions");
    expect(REVIEW_TOOL_POLICY.loadProjectSettings).toBe(false);
  });

  it("rejects duplicate names", () => {
    const [review] = defaultCapabilities() as [Capability];
    expect(() => new CapabilityRegistry([review, review])).toThrow(/twice/);
  });
});
