import { describe, expect, it } from "vitest";
import { CapabilityRegistry, defaultCapabilities, type Capability } from "./index.js";
import { REVIEW_TOOL_POLICY } from "./review.js";

describe("capability registry", () => {
  it("ships the system capability for repo.sync and the review capability for review.run jobs", () => {
    const registry = new CapabilityRegistry(defaultCapabilities());
    expect(registry.names()).toEqual(["system", "review"]);
    expect(registry.forJob({ capability: "system", type: "repo.sync" })?.name).toBe("system");
    expect(registry.forJob({ capability: "system", type: "review.run" })).toBeUndefined();
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
    const [system] = defaultCapabilities() as [Capability];
    expect(() => new CapabilityRegistry([system, system])).toThrow(/twice/);
  });
});
