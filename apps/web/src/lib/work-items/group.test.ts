import { describe, expect, it } from "vitest";
import { groupFor } from "./group";

describe("groupFor", () => {
  it("groups by readiness: ready is Ready to start, needs_refining Needs refining, other isn't listed", () => {
    expect(groupFor({ readiness: "ready" })).toBe("ready");
    expect(groupFor({ readiness: "needs_refining" })).toBe("refine");
    expect(groupFor({ readiness: "other" })).toBeNull();
  });

  it("derives nothing from the description: a Ready item without a PRD stays Ready", () => {
    const withoutPrd = { readiness: "ready" as const, description: "" };
    const idea = { readiness: "ready" as const, description: "Just an idea." };
    const refiningPrd = {
      readiness: "needs_refining" as const,
      description: "# PRD: Done\n\n## User Stories\n\n### US-001: Ship it",
    };
    expect(groupFor(withoutPrd)).toBe("ready");
    expect(groupFor(idea)).toBe("ready");
    expect(groupFor(refiningPrd)).toBe("refine");
  });
});
