import { describe, expect, it, vi } from "vitest";
import { ClaudeSignInError } from "../claude-credentials.js";
import type { ClaudeStatus } from "../claude-status.js";
import { claudeRoutes } from "./machine-routes.js";
import { UiHttpError, type UiApiRequest, type UiRoute } from "./server.js";

const SIGNED_IN: ClaudeStatus = {
  status: "signed_in",
  source: "login",
  models: [{ value: "opus", displayName: "Opus" }],
  checkedAt: "2026-11-06T05:00:00.000Z",
};

function route(routes: UiRoute[], path: string): UiRoute {
  const found = routes.find((candidate) => candidate.path === path);
  if (!found) throw new Error(`no ${path}`);
  return found;
}

function post(body: unknown): UiApiRequest {
  return { json: async () => body } as UiApiRequest;
}

describe("claudeRoutes' sign-in", () => {
  it("has no sign-in routes without a sign-in", () => {
    expect(claudeRoutes({ check: async () => SIGNED_IN }).map((r) => r.path)).toEqual([
      "/api/claude/check",
    ]);
  });

  it("starts, completes, checks again at once and heartbeats", async () => {
    const check = vi.fn(async () => SIGNED_IN);
    const signIn = {
      start: vi.fn(() => ({ authorizeUrl: "https://x", expiresAt: "2026-11-06T05:15:00.000Z" })),
      complete: vi.fn(async () => ({ email: "steve@example.com", subscriptionType: "max" })),
    };
    const heartbeatSoon = vi.fn();
    const routes = claudeRoutes({ check }, { signIn, heartbeatSoon });

    expect(await route(routes, "/api/claude/sign-in").handle(post({}))).toEqual({
      status: 200,
      body: { authorizeUrl: "https://x", expiresAt: "2026-11-06T05:15:00.000Z" },
    });
    expect(
      await route(routes, "/api/claude/sign-in/complete").handle(post({ code: "c#s" })),
    ).toEqual({ status: 200, body: { claude: SIGNED_IN } });
    expect(signIn.complete).toHaveBeenCalledWith("c#s");
    expect(check).toHaveBeenCalledWith({ force: true });
    expect(heartbeatSoon).toHaveBeenCalledTimes(1);
  });

  it("answers the sign-in's own status and message, and 400 without a code", async () => {
    const check = vi.fn(async () => SIGNED_IN);
    const routes = claudeRoutes(
      { check },
      {
        signIn: {
          start: () => {
            throw new ClaudeSignInError(409, "ANTHROPIC_API_KEY is set");
          },
          complete: async () => {
            throw new ClaudeSignInError(400, "Anthropic didn't accept that code");
          },
        },
      },
    );
    await expect(
      Promise.resolve().then(() => route(routes, "/api/claude/sign-in").handle(post({}))),
    ).rejects.toEqual(new UiHttpError(409, "ANTHROPIC_API_KEY is set"));
    const complete = route(routes, "/api/claude/sign-in/complete");
    await expect(complete.handle(post({ code: "x" }))).rejects.toMatchObject({
      status: 400,
      message: "Anthropic didn't accept that code",
    });
    await expect(complete.handle(post({}))).rejects.toMatchObject({ status: 400 });
    await expect(complete.handle(post({ code: "  " }))).rejects.toMatchObject({ status: 400 });
    expect(check).not.toHaveBeenCalled();
  });
});
