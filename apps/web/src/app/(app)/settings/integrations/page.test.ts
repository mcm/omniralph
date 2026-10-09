import { describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  slackConfigured: true,
  discordConfigured: true,
}));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requirePageUser: async (role: Role = "member") =>
    assertRole(state.user && { ...state.user, organization: { id: "org-a", name: "Acme" } }, role),
}));
vi.mock("@/lib/linear/oauth", () => ({ linearOAuthConfig: () => ({ clientId: "c" }) }));
vi.mock("@/lib/chat/slack-oauth", () => ({
  slackOAuthConfig: () => (state.slackConfigured ? { clientId: "c" } : null),
}));
vi.mock("@/lib/chat/discord-oauth", () => ({
  discordOAuthConfig: () => (state.discordConfigured ? { applicationId: "a" } : null),
}));
vi.mock("@omniralph/db", () => ({
  // Only the active organization's integration exists.
  getIntegration: async (_db: unknown, organizationId: string, provider: string) =>
    organizationId === "org-a" && provider === "linear"
      ? {
          name: "Acme",
          externalId: "org-1",
          updatedAt: new Date("2026-10-01T00:00:00Z"),
        }
      : null,
  listChatConnections: async (_db: unknown, organizationId: string) =>
    organizationId === "org-a"
      ? [
          {
            id: "conn-1",
            platform: "slack",
            externalId: "T01",
            name: "Acme Slack",
            installedByUserId: "user-1",
            updatedAt: new Date("2026-10-02T00:00:00Z"),
          },
          {
            id: "conn-2",
            platform: "slack",
            externalId: "E01",
            name: "Acme Grid",
            installedByUserId: "user-gone",
            updatedAt: new Date("2026-10-03T00:00:00Z"),
          },
          {
            id: "conn-3",
            platform: "discord",
            externalId: "G01",
            name: "Acme Discord",
            installedByUserId: null,
            updatedAt: new Date("2026-10-03T00:00:00Z"),
          },
          {
            id: "conn-4",
            platform: "discord",
            externalId: "G02",
            name: "Acme Gaming",
            installedByUserId: "user-1",
            updatedAt: new Date("2026-10-04T00:00:00Z"),
          },
        ]
      : [],
  getUserById: async (_db: unknown, id: string) =>
    id === "user-1" ? { id, name: null, email: "ada@acme.test" } : undefined,
}));
vi.mock("./integrations-view", () => ({ IntegrationsView: () => null }));

const { default: IntegrationsPage } = await import("./page");

const user = (role: Role) => ({ id: `${role}-1`, role, name: null, email: null, image: null });
const render = (linear?: string, slack?: string, discord?: string) =>
  IntegrationsPage({
    searchParams: Promise.resolve({
      ...(linear && { linear }),
      ...(slack && { slack }),
      ...(discord && { discord }),
    }),
  });

describe("Settings › Integrations page", () => {
  it("is for admins only", async () => {
    state.user = null;
    await expect(render()).rejects.toThrow();
    state.user = user("member");
    await expect(render()).rejects.toThrow();
  });

  it("shows the connected workspace and the OAuth outcome to admins", async () => {
    state.user = user("admin");
    const page = await render("connected");
    expect(page.props).toEqual({
      linear: { name: "Acme", workspaceId: "org-1", connectedAt: "2026-10-01T00:00:00.000Z" },
      linearConfigured: true,
      notice: "connected",
      slack: [
        {
          id: "conn-1",
          name: "Acme Slack",
          workspaceId: "T01",
          installedBy: "ada@acme.test",
          connectedAt: "2026-10-02T00:00:00.000Z",
        },
        {
          id: "conn-2",
          name: "Acme Grid",
          workspaceId: "E01",
          installedBy: null,
          connectedAt: "2026-10-03T00:00:00.000Z",
        },
      ],
      slackConfigured: true,
      slackNotice: null,
      discord: [
        {
          id: "conn-3",
          name: "Acme Discord",
          serverId: "G01",
          installedBy: null,
          connectedAt: "2026-10-03T00:00:00.000Z",
        },
        {
          id: "conn-4",
          name: "Acme Gaming",
          serverId: "G02",
          installedBy: "ada@acme.test",
          connectedAt: "2026-10-04T00:00:00.000Z",
        },
      ],
      discordConfigured: true,
      discordNotice: null,
    });
    expect((await render("bogus")).props.notice).toBeNull();
    expect((await render("other_organization")).props.notice).toBe("other_organization");
  });

  it("shows the Slack OAuth outcome", async () => {
    state.user = user("admin");
    for (const notice of [
      "connected",
      "other_organization",
      "denied",
      "invalid_state",
      "not_configured",
    ]) {
      const { props } = await render(undefined, notice);
      expect(props.slackNotice).toBe(notice);
      expect(props.notice).toBeNull();
    }
    expect((await render(undefined, "bogus")).props.slackNotice).toBeNull();
  });

  it("marks Slack as not configured without the Slack app's env vars", async () => {
    state.user = user("admin");
    state.slackConfigured = false;
    try {
      expect((await render()).props.slackConfigured).toBe(false);
    } finally {
      state.slackConfigured = true;
    }
  });
});

describe("Settings › Integrations page › Discord", () => {
  it("shows the Discord OAuth outcome", async () => {
    state.user = user("admin");
    for (const notice of [
      "connected",
      "other_organization",
      "denied",
      "invalid_state",
      "not_configured",
    ]) {
      const { props } = await render(undefined, undefined, notice);
      expect(props.discordNotice).toBe(notice);
      expect(props.slackNotice).toBeNull();
      expect(props.notice).toBeNull();
    }
    expect((await render(undefined, undefined, "bogus")).props.discordNotice).toBeNull();
  });

  it("marks Discord as not configured without the Discord app's env vars", async () => {
    state.user = user("admin");
    state.discordConfigured = false;
    try {
      const { props } = await render();
      expect(props.discordConfigured).toBe(false);
      expect(props.slackConfigured).toBe(true);
    } finally {
      state.discordConfigured = true;
    }
  });
});
