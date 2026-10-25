import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as LinkAccount from "@/lib/chat/link-account";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  check: { status: "invalid" } as Record<string, unknown>,
  checked: [] as unknown[][],
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser: async () => state.user }));
vi.mock("@/lib/chat/link-account", async (importOriginal) => ({
  ...(await importOriginal<typeof LinkAccount>()),
  checkChatLink: async (_db: unknown, ...args: unknown[]) => {
    state.checked.push(args);
    return state.check;
  },
}));
vi.mock("./chat-link-view", () => ({ ChatLinkView: () => null }));

const { default: ChatLinkPage } = await import("./page");

const render = (params: Record<string, string>) =>
  ChatLinkPage({ searchParams: Promise.resolve(params) }) as Promise<{
    props: Record<string, unknown>;
  }>;

describe("/chat/link", () => {
  beforeEach(() => {
    state.user = { id: "ada" };
    state.check = { status: "invalid" };
    state.checked = [];
  });

  it("sends signed-out users to sign-in and back", async () => {
    state.user = null;
    await expect(render({ state: "a.b+c" })).rejects.toThrow(
      `redirect:/sign-in?callbackUrl=${encodeURIComponent("/chat/link?state=a.b%2Bc")}`,
    );
    expect(state.checked).toEqual([]);
  });

  it("explains links that can't be used", async () => {
    state.check = { status: "expired" };
    expect((await render({ state: "s" })).props).toEqual({
      problem: "This link has expired. Mention Om again to get a new one.",
    });
    state.check = { status: "used" };
    expect((await render({ state: "s" })).props).toEqual({
      problem:
        "This link was used already. Each link works once: mention Om again to get a new one.",
    });
    state.check = { status: "not_member", organizationName: "Acme" };
    expect((await render({ state: "s" })).props.problem).toMatch(/^You aren't a member of Acme/);
    expect(state.checked).toEqual([
      ["ada", "s"],
      ["ada", "s"],
      ["ada", "s"],
    ]);
  });

  it("asks to confirm a usable link", async () => {
    state.check = {
      status: "ready",
      state: { platform: "slack", displayName: "Ada L" },
      organizationName: "Acme",
      connectionName: "Acme Slack",
    };
    expect((await render({ state: "s" })).props).toEqual({
      confirmation: {
        state: "s",
        platform: "slack",
        displayName: "Ada L",
        organizationName: "Acme",
        connectionName: "Acme Slack",
      },
    });
  });
});
