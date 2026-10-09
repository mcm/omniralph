import { describe, expect, it } from "vitest";
import { classifyPath, safeCallbackPath } from "./routes";

describe("classifyPath", () => {
  it("leaves self-authenticated APIs to their own auth", () => {
    for (const path of [
      "/api/agent/token",
      "/api/agent/queue/iad1/x",
      "/api/webhooks/github",
      "/api/cron/expire-jobs",
      "/api/auth/callback/github",
    ]) {
      expect(classifyPath(path)).toBe("public");
    }
  });

  it("lets the sign-in and access-denied pages through", () => {
    expect(classifyPath("/sign-in")).toBe("public");
    expect(classifyPath("/access-denied")).toBe("public");
  });

  it("lets the terms of service and privacy policy through", () => {
    expect(classifyPath("/terms")).toBe("public");
    expect(classifyPath("/privacy")).toBe("public");
    expect(classifyPath("/privacy-settings")).toBe("page");
  });

  it("protects other APIs and every UI page", () => {
    expect(classifyPath("/api/other")).toBe("api");
    expect(classifyPath("/api/agentx")).toBe("api");
    expect(classifyPath("/")).toBe("page");
    expect(classifyPath("/settings/organization")).toBe("page");
    expect(classifyPath("/sign-in-elsewhere")).toBe("page");
  });
});

describe("safeCallbackPath", () => {
  it("keeps same-origin paths", () => {
    expect(safeCallbackPath("/agents?x=1")).toBe("/agents?x=1");
    expect(safeCallbackPath(["/jobs", "/x"])).toBe("/jobs");
  });

  it("rejects absolute and protocol-relative URLs", () => {
    expect(safeCallbackPath("https://evil.com")).toBe("/");
    expect(safeCallbackPath("//evil.com")).toBe("/");
    expect(safeCallbackPath("/\\evil.com")).toBe("/");
    expect(safeCallbackPath(undefined)).toBe("/");
  });
});
