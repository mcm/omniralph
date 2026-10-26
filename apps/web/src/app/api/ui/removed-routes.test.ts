import { existsSync } from "node:fs";
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
    // `/api/ui/harnesses/[id]` answers the path itself, with 404 for an unknown agent.
    expect(existsSync(join(__dirname, "harnesses/pinnable-repositories"))).toBe(false);
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
