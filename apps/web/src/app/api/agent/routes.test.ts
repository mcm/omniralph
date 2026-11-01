import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const API = join(__dirname, "..");

function routePaths(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return routePaths(path);
    return name === "route.ts" ? [`/api/${relative(API, dir).split(sep).join("/")}`] : [];
  });
}

describe("agent API routes", () => {
  it("are served under /api/agent", () => {
    expect(routePaths(join(API, "agent")).sort()).toEqual([
      "/api/agent/claim",
      "/api/agent/credentials",
      "/api/agent/enroll",
      "/api/agent/heartbeat",
      "/api/agent/jobs/[id]/activities",
      "/api/agent/jobs/[id]/attachments/[attachmentId]",
      "/api/agent/jobs/[id]/fail",
      "/api/agent/jobs/[id]/permissions",
      "/api/agent/jobs/[id]/permissions/[requestId]",
      "/api/agent/jobs/[id]/result",
      "/api/agent/runs/[id]/tracker/documents/[documentId]",
      "/api/agent/runs/[id]/tracker/issues",
      "/api/agent/runs/[id]/tracker/issues/[issueId]",
      "/api/agent/runs/[id]/tracker/issues/[issueId]/comments",
      "/api/agent/token",
    ]);
  });

  it("leave nothing under /api/harness, so /api/harness/heartbeat isn't a route", () => {
    expect(existsSync(join(API, "harness"))).toBe(false);
    // No catch-all at /api could serve it either.
    expect(readdirSync(API).filter((name) => name.startsWith("["))).toEqual([]);
    expect(routePaths(API)).not.toContain("/api/harness/heartbeat");
  });
});
