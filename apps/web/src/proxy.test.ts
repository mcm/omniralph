import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { config, proxy } from "./proxy";

const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

describe("proxy matcher", () => {
  it("skips the self-authenticated APIs", () => {
    for (const url of [
      "/api/agent/heartbeat",
      "/api/agent/queue/iad1/api/v3/topic/t/consumer/agents",
      "/api/webhooks/github",
      "/api/cron/sweep",
      "/api/auth/session",
    ]) {
      expect(matches(url), url).toBe(false);
    }
  });

  it("runs for pages and other APIs", () => {
    for (const url of ["/", "/agents", "/api/other", "/api/agentx", "/api/agents"]) {
      expect(matches(url), url).toBe(true);
    }
  });

  it("no longer skips the old /api/harness/* routes", () => {
    for (const url of ["/api/harness/heartbeat", "/api/harness/token"]) {
      expect(matches(url), url).toBe(true);
    }
  });

  it("skips Next internals and static files", () => {
    expect(matches("/_next/static/chunk.js")).toBe(false);
    expect(matches("/logo.svg")).toBe(false);
  });
});

describe("proxy", () => {
  const run = (url: string, headers: Record<string, string> = {}) =>
    proxy(new NextRequest(new URL(url, "http://localhost"), { headers }));

  it("rejects APIs without a session cookie or a Bearer token", async () => {
    const response = run("/api/ui/features", { authorization: "Basic abc" });
    expect(response.status).toBe(401);
  });

  it("lets a Bearer token through to the route, which checks it", () => {
    const response = run("/api/ui/features", { authorization: "Bearer omr_x" });
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("still sends pages without a session to sign-in, token or not", () => {
    const response = run("/features", { authorization: "Bearer omr_x" });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/sign-in");
  });
});
