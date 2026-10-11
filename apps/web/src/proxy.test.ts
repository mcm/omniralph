import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";
import { config } from "./proxy";

const matches = (url: string) => unstable_doesMiddlewareMatch({ config, url });

describe("proxy matcher", () => {
  it("skips the self-authenticated APIs", () => {
    for (const url of [
      "/api/harness/heartbeat",
      "/api/harness/queue/iad1/api/v3/topic/t/consumer/agents",
      "/api/webhooks/github",
      "/api/cron/sweep",
      "/api/auth/session",
    ]) {
      expect(matches(url), url).toBe(false);
    }
  });

  it("runs for pages and other APIs", () => {
    for (const url of ["/", "/harnesses", "/api/other", "/api/harnessx"]) {
      expect(matches(url), url).toBe(true);
    }
  });

  it("skips Next internals and static files", () => {
    expect(matches("/_next/static/chunk.js")).toBe(false);
    expect(matches("/logo.svg")).toBe(false);
  });
});
