import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  integration: null as null | { name: string; credentials: { accessToken: string } },
  deletes: 0,
  deletedFrom: [] as string[],
  chat: [] as Array<{
    id: string;
    organizationId: string;
    platform: "slack" | "discord";
    name: string;
    credentials: { botToken: string } | null;
  }>,
  chatDeletes: [] as Array<[string, string]>,
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(state.user && { ...state.user, organization: { id: "org-a", name: "Acme" } }, role),
}));
vi.mock("@omniralph/db", () => ({
  deleteIntegration: async (_db: unknown, organizationId: string) => {
    state.deletes += 1;
    state.deletedFrom.push(organizationId);
    const removed = state.integration;
    state.integration = null;
    return removed;
  },
  listChatConnections: async (_db: unknown, organizationId: string) =>
    state.chat.filter((c) => c.organizationId === organizationId),
  deleteChatConnection: async (_db: unknown, organizationId: string, id: string) => {
    state.chatDeletes.push([organizationId, id]);
    const removed = state.chat.find((c) => c.organizationId === organizationId && c.id === id);
    state.chat = state.chat.filter((c) => c !== removed);
    return removed ?? null;
  },
}));

const { disconnectLinear, disconnectSlack } = await import("./actions");

const revoked: string[] = [];
let revokeStatus = 200;
const slackRevoked: string[] = [];
let slackRevoke: () => Response;
const server = setupServer(
  http.post("https://api.linear.app/oauth/revoke", ({ request }) => {
    revoked.push(request.headers.get("authorization") ?? "");
    return new HttpResponse(null, { status: revokeStatus });
  }),
  http.post("https://slack.com/api/auth.revoke", ({ request }) => {
    slackRevoked.push(request.headers.get("authorization") ?? "");
    return slackRevoke();
  }),
);
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterAll(() => server.close());

const user = (role: Role) => ({ id: `${role}-1`, role, name: null, email: null, image: null });

describe("disconnectLinear", () => {
  beforeEach(() => {
    state.user = user("admin");
    state.integration = { name: "Acme", credentials: { accessToken: "access-1" } };
    state.deletes = 0;
    state.deletedFrom = [];
    revoked.length = 0;
    revokeStatus = 200;
  });

  it("removes the integration and revokes its token", async () => {
    expect(await disconnectLinear()).toEqual({ ok: true });
    expect(state.integration).toBeNull();
    // Only the active organization's integration.
    expect(state.deletedFrom).toEqual(["org-a"]);
    expect(revoked).toEqual(["Bearer access-1"]);
  });

  it("still disconnects, with a warning, when revoking fails", async () => {
    revokeStatus = 500;
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await disconnectLinear();
    consoleError.mockRestore();
    expect(result).toMatchObject({ ok: true, warning: expect.stringContaining("Acme") });
    expect(state.integration).toBeNull();
  });

  it("reports when nothing is connected", async () => {
    state.integration = null;
    expect(await disconnectLinear()).toEqual({
      ok: false,
      error: "No Linear workspace is connected.",
    });
  });

  it("is admin-only", async () => {
    state.user = user("member");
    expect(await disconnectLinear()).toMatchObject({ ok: false });
    expect(state.deletes).toBe(0);
  });
});

describe("disconnectSlack", () => {
  const slack = (id: string, organizationId = "org-a") => ({
    id,
    organizationId,
    platform: "slack" as const,
    name: `Workspace ${id}`,
    credentials: { botToken: `xoxb-${id}` },
  });

  beforeEach(() => {
    state.user = user("admin");
    state.chat = [
      slack("s1"),
      slack("s2"),
      slack("foreign", "org-b"),
      { ...slack("d1"), platform: "discord", credentials: null },
    ];
    state.chatDeletes = [];
    slackRevoked.length = 0;
    slackRevoke = () => HttpResponse.json({ ok: true, revoked: true });
  });

  it("removes the workspace and revokes its bot token", async () => {
    expect(await disconnectSlack("s1")).toEqual({ ok: true });
    expect(state.chat.map((c) => c.id)).toEqual(["s2", "foreign", "d1"]);
    expect(state.chatDeletes).toEqual([["org-a", "s1"]]);
    expect(slackRevoked).toEqual(["Bearer xoxb-s1"]);
  });

  it("treats an already revoked token as revoked", async () => {
    slackRevoke = () => HttpResponse.json({ ok: false, error: "token_revoked" });
    expect(await disconnectSlack("s1")).toEqual({ ok: true });
  });

  it("still disconnects, with a warning, when revoking fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const failure of [
      () => new HttpResponse(null, { status: 500 }),
      () => HttpResponse.json({ ok: false, error: "ratelimited" }),
    ]) {
      slackRevoke = failure;
      const id = state.chat[0]!.id;
      expect(await disconnectSlack(id)).toMatchObject({
        ok: true,
        warning: expect.stringContaining(`Workspace ${id}`),
      });
      expect(state.chat.some((c) => c.id === id)).toBe(false);
    }
    consoleError.mockRestore();
  });

  it("only disconnects the active organization's Slack workspaces", async () => {
    for (const id of ["foreign", "d1", "missing"]) {
      expect(await disconnectSlack(id)).toEqual({
        ok: false,
        error: "That Slack workspace isn't connected.",
      });
    }
    expect(state.chatDeletes).toEqual([]);
    expect(state.chat).toHaveLength(4);
    expect(slackRevoked).toEqual([]);
  });

  it("is admin-only", async () => {
    state.user = user("member");
    expect(await disconnectSlack("s1")).toMatchObject({ ok: false });
    expect(state.chatDeletes).toEqual([]);
  });
});
