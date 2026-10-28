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
    // Each Repos card saves on its own endpoint.
    "/api/ui/repositories/x/settings",
    "/api/ui/repositories/x/task-types",
    // The Coding card saves the work item match with the switch and policy.
    "/api/ui/repositories/x/work-item-match",
  ])("%s has no handler (404)", (path) => {
    expect(servedByRouteHandler(path)).toBe(false);
  });

  it.each([
    // Runs replaced the Coding, Reviews, Triage and Jobs pages and their endpoints.
    "/api/ui/coding-runs",
    "/api/ui/coding-runs/x",
    "/api/ui/reviews",
    "/api/ui/reviews/x",
    "/api/ui/reviews/x/rerun",
    "/api/ui/triage",
    "/api/ui/triage/x",
    "/api/ui/jobs",
  ])("%s has no handler (404): Runs replaced its page", (path) => {
    expect(servedByRouteHandler(path)).toBe(false);
  });

  it("keeps cancelling and rerunning a job (the step panel's Cancel attempt, Fleet's Rerun)", () => {
    expect(servedByRouteHandler("/api/ui/jobs/x/cancel")).toBe(true);
    expect(servedByRouteHandler("/api/ui/jobs/x/rerun")).toBe(true);
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

  it("has no agent settings route: slots and kinds are set on the agent and reported", () => {
    expect(servedByRouteHandler("/api/ui/agents/x/settings")).toBe(false);
    expect(existsSync(join(__dirname, "agents/[id]/settings"))).toBe(false);
  });

  it("keeps the routes that replaced them", () => {
    for (const path of [
      "/api/ui/repositories/x/reviews",
      "/api/ui/repositories/x/coding",
      "/api/ui/repositories/x/coding/match-check",
      "/api/ui/repositories/x/ask",
      "/api/ui/repositories/x/agents",
      "/api/ui/repositories/x/playbooks",
      "/api/ui/routing-rules/test",
    ]) {
      expect(servedByRouteHandler(path), path).toBe(true);
    }
  });
});
