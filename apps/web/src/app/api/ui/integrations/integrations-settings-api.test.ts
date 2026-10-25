import { describe, expect, it, vi } from "vitest";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  slackConfigured: true,
  discordConfigured: true,
}));
/**
 * org-a's own playbooks: a chat query playbook, a chat coding playbook, and a query
 * playbook not accepting `chat.request` (no picker offers it).
 */
async function storedTaskRows() {
  const { getBuiltinPlaybook } = await import("@omniralph/tasks");
  const row = (id: string, name: string, base: string, changes: object = {}) => {
    const { id: _id, name: _name, role, ...definition } = getBuiltinPlaybook(base)!;
    const now = new Date("2026-10-01T00:00:00Z");
    return {
      id,
      organizationId: "org-a",
      name,
      role,
      definition: { ...definition, ...changes },
      requirements: { minHarnessVersion: "0.40.0", installables: [], hostTools: ["git"] },
      createdAt: now,
      updatedAt: now,
      createdBy: null,
      updatedBy: null,
    };
  };
  return [
    row("11111111-1111-4111-8111-111111111111", "Security Q&A", "builtin:ask-about-code"),
    row("22222222-2222-4222-8222-222222222222", "Hotfix", "builtin:handle-request"),
    row("33333333-3333-4333-8333-333333333333", "Not for chat", "builtin:correlate-findings"),
  ];
}

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
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
  DEFAULT_CHAT_TASKS: {
    askAboutCode: "builtin:ask-about-code",
    startWork: "builtin:handle-request",
  },
  listStoredPlaybooks: async (_db: unknown, organizationId: string) =>
    organizationId === "org-a" ? await storedTaskRows() : [],
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
  getChatTaskDefaults: async (_db: unknown, organizationId: string) =>
    organizationId === "org-a"
      ? { askAboutCode: "builtin:ask-about-code", startWork: "builtin:handle-request" }
      : null,
  listChatChannelTaskSettings: async (_db: unknown, organizationId: string) =>
    organizationId === "org-a"
      ? [
          {
            connectionId: "conn-1",
            channelId: "slack:C0SECURITY",
            askAboutCodeTaskId: null,
            startWorkTaskId: "builtin:handle-request",
          },
          {
            connectionId: "conn-3",
            channelId: "discord:G01:222",
            askAboutCodeTaskId: "builtin:ask-about-code",
            startWorkTaskId: null,
          },
        ]
      : [],
  getUserById: async (_db: unknown, id: string) =>
    id === "user-1" ? { id, name: null, email: "ada@acme.test" } : undefined,
}));
const { GET } = await import("@/app/api/ui/integrations/route");

const user = (role: Role) => ({ id: `${role}-1`, role, name: null, email: null, image: null });
/** `GET /api/ui/integrations`: its status and body. */
async function load() {
  const response = await GET(new Request("http://localhost/api/ui/integrations"), {
    params: Promise.resolve({}),
  });
  return { status: response.status, props: (await response.json()) as Record<string, unknown> };
}

describe("GET /api/ui/integrations", () => {
  it("is for admins only", async () => {
    state.user = null;
    expect((await load()).status).toBe(401);
    state.user = user("member");
    expect((await load()).status).toBe(403);
  });

  it("shows the connected workspace and chat connections to admins", async () => {
    state.user = user("admin");
    const { status, props } = await load();
    expect(status).toBe(200);
    expect(props).toEqual({
      linear: { name: "Acme", workspaceId: "org-1", connectedAt: "2026-10-01T00:00:00.000Z" },
      linearConfigured: true,
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
      chatTasks: expect.anything(),
    });
  });

  it("marks Slack and Discord as not configured without their apps' env vars", async () => {
    state.user = user("admin");
    state.slackConfigured = false;
    try {
      expect((await load()).props).toMatchObject({
        slackConfigured: false,
        discordConfigured: true,
      });
    } finally {
      state.slackConfigured = true;
    }
    state.discordConfigured = false;
    try {
      expect((await load()).props).toMatchObject({
        slackConfigured: true,
        discordConfigured: false,
      });
    } finally {
      state.discordConfigured = true;
    }
  });
});

describe("GET /api/ui/integrations › chat tasks", () => {
  it("shows the organization's chat tasks, the choices and each connection's channels", async () => {
    state.user = user("admin");
    const { props } = await load();
    expect(props.chatTasks).toEqual({
      defaults: { askAboutCode: "builtin:ask-about-code", startWork: "builtin:handle-request" },
      builtinDefaults: {
        askAboutCode: "builtin:ask-about-code",
        startWork: "builtin:handle-request",
      },
      // Built-in and the organization's own tasks of the role's type accepting chat.request.
      choices: {
        askAboutCode: [
          { id: "builtin:ask-about-code", name: "Ask about code", builtin: true },
          { id: "11111111-1111-4111-8111-111111111111", name: "Security Q&A", builtin: false },
        ],
        startWork: [
          { id: "builtin:handle-request", name: "Handle a request", builtin: true },
          { id: "22222222-2222-4222-8222-222222222222", name: "Hotfix", builtin: false },
        ],
      },
      connections: [
        {
          id: "conn-1",
          name: "Acme Slack",
          platform: "slack",
          channels: [
            {
              channelId: "slack:C0SECURITY",
              channel: "C0SECURITY",
              askAboutCode: null,
              startWork: "builtin:handle-request",
            },
          ],
        },
        { id: "conn-2", name: "Acme Grid", platform: "slack", channels: [] },
        {
          id: "conn-3",
          name: "Acme Discord",
          platform: "discord",
          channels: [
            {
              channelId: "discord:G01:222",
              channel: "222",
              askAboutCode: "builtin:ask-about-code",
              startWork: null,
            },
          ],
        },
        { id: "conn-4", name: "Acme Gaming", platform: "discord", channels: [] },
      ],
    });
  });
});
