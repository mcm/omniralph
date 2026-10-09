import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthorizationError } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  unlinked: [] as unknown[][],
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireSignedInUser: async () => {
    if (!state.user) throw new AuthorizationError("You must be signed in.", "unauthenticated");
    return state.user;
  },
}));
vi.mock("@omniralph/db", () => ({
  // Only ada's Slack account U1 in org-a is linked.
  unlinkChatIdentity: async (_db: unknown, ...args: unknown[]) => {
    state.unlinked.push(args);
    const [userId, organizationId, platform, externalUserId] = args;
    return (
      userId === "ada" &&
      organizationId === "org-a" &&
      platform === "slack" &&
      externalUserId === "U1"
    );
  },
}));

const { unlinkChatAccount } = await import("./actions");

const input = { organizationId: "org-a", platform: "slack", externalUserId: "U1" };

describe("unlinkChatAccount", () => {
  beforeEach(() => {
    state.user = { id: "ada" };
    state.unlinked = [];
  });

  it("unlinks the signed-in user's own chat account", async () => {
    expect(await unlinkChatAccount(input)).toEqual({ ok: true });
    expect(state.unlinked).toEqual([["ada", "org-a", "slack", "U1"]]);
  });

  it("can't unlink another user's chat account", async () => {
    state.user = { id: "bob" };
    expect(await unlinkChatAccount(input)).toEqual({
      ok: false,
      error: "That chat account isn't linked to you.",
    });
  });

  it("rejects signed-out callers and unknown platforms", async () => {
    expect(await unlinkChatAccount({ ...input, platform: "teams" })).toEqual({
      ok: false,
      error: "Unknown chat platform.",
    });
    state.user = null;
    expect(await unlinkChatAccount(input)).toMatchObject({ ok: false });
    expect(state.unlinked).toEqual([]);
  });
});
