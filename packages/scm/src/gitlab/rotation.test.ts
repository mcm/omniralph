import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { rotatedTokenExpiry, rotateGitLabToken } from "./rotation.js";

const HOST = "https://gitlab.example.com";
const NOW = new Date("2026-10-07T23:30:00Z");

/** Mutable GitLab state the handlers serve. */
let user: { status: number; username: string };
let rotate: { status: number; message: string };
let rotateBodies: unknown[];

const server = setupServer(
  http.get(`${HOST}/api/v4/user`, () =>
    user.status === 200
      ? HttpResponse.json({ id: 42, username: user.username, name: "Omniralph" })
      : HttpResponse.json({ message: "401 Unauthorized" }, { status: user.status }),
  ),
  http.post(`${HOST}/api/v4/personal_access_tokens/self/rotate`, async ({ request }) => {
    const body = (await request.json()) as { expires_at?: string };
    rotateBodies.push(body);
    return rotate.status === 200
      ? HttpResponse.json({ id: 8, token: "glpat-new", expires_at: body.expires_at })
      : HttpResponse.json({ message: rotate.message }, { status: rotate.status });
  }),
);

beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
beforeEach(() => {
  user = { status: 200, username: "service_account_group_12_omniralph" };
  rotate = { status: 200, message: "" };
  rotateBodies = [];
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const rotateNow = () => rotateGitLabToken({ baseUrl: HOST, token: "glpat-old", now: NOW });

describe("rotatedTokenExpiry", () => {
  it("is today (UTC) + 7 days", () => {
    expect(rotatedTokenExpiry(NOW)).toBe("2026-10-14");
    expect(rotatedTokenExpiry(new Date("2026-12-28T00:00:00Z"))).toBe("2027-01-04");
  });
});

describe("rotateGitLabToken", () => {
  it("rotates the token to expire in 7 days", async () => {
    expect(await rotateNow()).toEqual({
      status: "rotated",
      token: "glpat-new",
      expiresAt: "2026-10-14",
    });
    expect(rotateBodies).toEqual([{ expires_at: "2026-10-14" }]);
  });

  it("skips tokens GitLab rejects", async () => {
    user.status = 401;
    expect(await rotateNow()).toEqual({ status: "skipped", reason: "token_invalid" });
    expect(rotateBodies).toEqual([]);
  });

  it("skips group and project access tokens", async () => {
    user.username = "group_12_bot_0123abcd";
    expect(await rotateNow()).toEqual({ status: "skipped", reason: "access_token_bot" });
    user.username = "project_7_bot";
    expect(await rotateNow()).toEqual({ status: "skipped", reason: "access_token_bot" });
    expect(rotateBodies).toEqual([]);
  });

  it("reports instances without self-rotation as unsupported", async () => {
    rotate = { status: 404, message: "404 Not Found" };
    expect(await rotateNow()).toEqual({ status: "unsupported" });
  });

  it("throws other GitLab errors with GitLab's message", async () => {
    rotate = { status: 400, message: "expires_at is too far in the future" };
    await expect(rotateNow()).rejects.toThrow("expires_at is too far in the future");
  });
});
