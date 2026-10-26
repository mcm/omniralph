import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { servedByRouteHandler } from "@/lib/testing/app-routes";

describe("routes the configuration model removed", () => {
  it.each([
    // Review profiles became review depth.
    "/api/ui/review-profiles",
    "/api/ui/review-profiles/standard",
    // Findings are dismissed with `@bot dismiss` on the PR.
    "/api/ui/findings/x/dismiss",
    "/api/ui/findings/x/restore",
    // The repo coding policy is the coding API's five fields.
    "/api/ui/repositories/x/coding/linear",
  ])("%s has no handler (404)", (path) => {
    expect(servedByRouteHandler(path)).toBe(false);
  });

  it("has no pinnable repositories search: pins are edited from the repo's settings", () => {
    // `/api/ui/agents/[id]` answers the path itself, with 404 for an unknown agent.
    expect(existsSync(join(__dirname, "agents/pinnable-repositories"))).toBe(false);
  });

  it("serves the agent pages' routes under /api/ui/agent*, and none under /api/ui/harness*", () => {
    for (const path of [
      "/api/ui/agents",
      "/api/ui/agents/x",
      "/api/ui/agents/x/host-tools",
      "/api/ui/agents/x/installables",
      "/api/ui/agents/x/installs",
      "/api/ui/agents/x/revoke",
      "/api/ui/agents/x/settings",
      "/api/ui/agents/x/update",
      "/api/ui/agent-defaults",
      "/api/ui/agent-enrollments",
      "/api/ui/agent-enrollments/x",
    ]) {
      expect(servedByRouteHandler(path), path).toBe(true);
      const old = path.replace("/agents", "/harnesses").replace("/agent-", "/harness-");
      expect(servedByRouteHandler(old), old).toBe(false);
    }
    expect(readdirSync(__dirname).filter((name) => /harness/i.test(name))).toEqual([]);
  });

  it("keeps the routes that replaced them", () => {
    for (const path of [
      "/api/ui/repositories/x/settings",
      "/api/ui/repositories/x/coding",
      "/api/ui/repositories/x/task-types",
      "/api/ui/repositories/x/work-item-match",
      "/api/ui/routing-rules/test",
    ]) {
      expect(servedByRouteHandler(path), path).toBe(true);
    }
  });
});
