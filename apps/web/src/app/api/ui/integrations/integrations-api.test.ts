import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { callAction } from "@/lib/api/test-call";
import { assertRole, type Role } from "@/lib/auth/roles";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string; role: Role; name: null; email: null; image: null } | null,
  integration: null as null | { name: string; credentials: { accessToken: string } },
  deletes: 0,
  deletedFrom: [] as string[],
  chat: [] as Array<{
    id: string;
    organizationId: string;
    platform: "slack" | "discord" | "web";
    externalId?: string;
    name: string;
    credentials: { botToken: string } | null;
  }>,
  chatDeletes: [] as Array<[string, string]>,
  chatPlaybookDefaults: [] as Array<[string, unknown, string | null]>,
  channelPlaybooks: [] as Array<{
    organizationId: string;
    connectionId: string;
    channelId: string;
    askPlaybookId: string | null;
    startWorkPlaybookId: string | null;
    updatedBy: string | null;
  }>,
}));
/** Stored playbooks: org-a's chat-ask and request playbooks, a correlation one, and org-b's chat-ask one. */
const IDS = {
  query: "11111111-1111-4111-8111-111111111111",
  coding: "22222222-2222-4222-8222-222222222222",
  notChat: "33333333-3333-4333-8333-333333333333",
  foreign: "44444444-4444-4444-8444-444444444444",
};
const rows = vi.hoisted(async () => {
  const { getBuiltinPlaybook } = await import("@omniralph/tasks");
  const row = (id: string, organizationId: string, base: string, changes: object = {}) => {
    const { id: _id, name, role, ...definition } = getBuiltinPlaybook(base)!;
    const now = new Date("2026-10-01T00:00:00Z");
    return {
      id,
      organizationId,
      name: `Custom ${name}`,
      role,
      definition: { ...definition, ...changes },
      requirements: { minAgentVersion: "0.40.0", installables: [], hostTools: ["git"] },
      createdAt: now,
      updatedAt: now,
      createdBy: null,
      updatedBy: null,
    };
  };
  return [
    row("11111111-1111-4111-8111-111111111111", "org-a", "builtin:ask-about-code"),
    row("22222222-2222-4222-8222-222222222222", "org-a", "builtin:handle-request"),
    row("33333333-3333-4333-8333-333333333333", "org-a", "builtin:correlate-findings"),
    row("44444444-4444-4444-8444-444444444444", "org-b", "builtin:ask-about-code"),
  ];
});
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(state.user && { ...state.user, organization: { id: "org-a", name: "Acme" } }, role),
}));
vi.mock("@omniralph/db", async () => ({
  // The change history is covered by its own tests: a save just runs.
  withSettingsChanges: async (
    db: unknown,
    _actor: unknown,
    _tracked: unknown,
    save: (tx: unknown) => Promise<unknown>,
  ) => save(db),
  getStoredPlaybook: async (_db: unknown, organizationId: string, id: string) =>
    (await rows).find((r) => r.organizationId === organizationId && r.id === id) ?? null,
  getIntegration: async () => state.integration && { id: "integration-1", ...state.integration },
  deleteIntegration: async (_db: unknown, organizationId: string) => {
    state.deletes += 1;
    state.deletedFrom.push(organizationId);
    const removed = state.integration;
    state.integration = null;
    return removed;
  },
  // As the real one (covered against Postgres in `web-chat.test.ts`): never the web connection.
  listChatConnections: async (_db: unknown, organizationId: string) =>
    state.chat.filter((c) => c.organizationId === organizationId && c.platform !== "web"),
  isExternalChatConnection: (connection: { platform: string }) => connection.platform !== "web",
  // Finds any connection, the web one included: callers must refuse it.
  deleteChatConnection: async (_db: unknown, organizationId: string, id: string) => {
    state.chatDeletes.push([organizationId, id]);
    const removed = state.chat.find((c) => c.organizationId === organizationId && c.id === id);
    state.chat = state.chat.filter((c) => c !== removed);
    return removed ?? null;
  },
  getChatConnection: async (_db: unknown, organizationId: string, id: string) =>
    state.chat.find((c) => c.organizationId === organizationId && c.id === id) ?? null,
  setChatPlaybookDefaults: async (
    _db: unknown,
    organizationId: string,
    playbooks: unknown,
    updatedBy: string | null,
  ) => {
    state.chatPlaybookDefaults.push([organizationId, playbooks, updatedBy]);
  },
  upsertChatChannelPlaybookSetting: async (
    _db: unknown,
    input: (typeof state.channelPlaybooks)[number],
  ) => {
    if (
      !state.chat.some(
        (c) => c.organizationId === input.organizationId && c.id === input.connectionId,
      )
    )
      return null;
    state.channelPlaybooks = state.channelPlaybooks.filter(
      (t) => !(t.connectionId === input.connectionId && t.channelId === input.channelId),
    );
    state.channelPlaybooks.push(input);
    return { id: "setting-1", ...input, updatedAt: new Date() };
  },
  deleteChatChannelPlaybookSetting: async (
    _db: unknown,
    organizationId: string,
    connectionId: string,
    channelId: string,
  ) => {
    const before = state.channelPlaybooks.length;
    state.channelPlaybooks = state.channelPlaybooks.filter(
      (t) =>
        !(
          t.organizationId === organizationId &&
          t.connectionId === connectionId &&
          t.channelId === channelId
        ),
    );
    return state.channelPlaybooks.length < before;
  },
}));

const linear = await import("@/app/api/ui/integrations/linear/route");
const slack = await import("@/app/api/ui/integrations/slack/[id]/route");
const discord = await import("@/app/api/ui/integrations/discord/[id]/route");
const chatPlaybooks = await import("@/app/api/ui/integrations/chat-tasks/route");
const channels = await import("@/app/api/ui/integrations/chat-connections/[id]/channels/route");

/** Chat connection IDs (UUIDs) by the name the tests use. */
const CONNECTIONS: Record<string, string> = {
  s1: "c0000000-0000-4000-8000-000000000001",
  s2: "c0000000-0000-4000-8000-000000000002",
  d1: "c0000000-0000-4000-8000-000000000003",
  d2: "c0000000-0000-4000-8000-000000000004",
  foreign: "c0000000-0000-4000-8000-000000000005",
  missing: "c0000000-0000-4000-8000-000000000006",
  web: "c0000000-0000-4000-8000-000000000007",
};
const cid = (name: string) => CONNECTIONS[name]!;

// The panel's requests, under the names of the server actions they replace.
type Playbooks<T> = { ask: T; startWork: T };
const disconnectLinear = () => callAction(linear.DELETE, "DELETE", {});
const disconnectSlack = (name: string) => callAction(slack.DELETE, "DELETE", { id: cid(name) });
const disconnectDiscord = (name: string) => callAction(discord.DELETE, "DELETE", { id: cid(name) });
const saveChatPlaybookDefaults = (playbooks: Playbooks<string>) =>
  callAction(chatPlaybooks.PUT, "PUT", {}, playbooks);
const saveChatChannelPlaybooks = (
  name: string,
  channel: string,
  playbooks: Playbooks<string | null>,
) => callAction(channels.PUT, "PUT", { id: cid(name) }, { channel, ...playbooks });
const removeChatChannelPlaybooks = (name: string, channelId: string) =>
  callAction(channels.DELETE, "DELETE", { id: cid(name) }, { channelId });

const revoked: string[] = [];
let revokeStatus = 200;
const slackRevoked: string[] = [];
let slackRevoke: () => Response;
const discordLeft: Array<{ guildId: string; authorization: string }> = [];
let discordLeave: () => Response;
const server = setupServer(
  http.post("https://api.linear.app/oauth/revoke", ({ request }) => {
    revoked.push(request.headers.get("authorization") ?? "");
    return new HttpResponse(null, { status: revokeStatus });
  }),
  http.post("https://slack.com/api/auth.revoke", ({ request }) => {
    slackRevoked.push(request.headers.get("authorization") ?? "");
    return slackRevoke();
  }),
  http.delete("https://discord.com/api/v10/users/@me/guilds/:guildId", ({ request, params }) => {
    discordLeft.push({
      guildId: String(params.guildId),
      authorization: request.headers.get("authorization") ?? "",
    });
    return discordLeave();
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
  const workspace = (id: string, organizationId = "org-a") => ({
    id: cid(id),
    organizationId,
    platform: "slack" as const,
    name: `Workspace ${id}`,
    credentials: { botToken: `xoxb-${id}` },
  });

  beforeEach(() => {
    state.user = user("admin");
    state.chat = [
      workspace("s1"),
      workspace("s2"),
      workspace("foreign", "org-b"),
      { ...workspace("d1"), platform: "discord", credentials: null },
    ];
    state.chatDeletes = [];
    slackRevoked.length = 0;
    slackRevoke = () => HttpResponse.json({ ok: true, revoked: true });
  });

  it("removes the workspace and revokes its bot token", async () => {
    expect(await disconnectSlack("s1")).toEqual({ ok: true });
    expect(state.chat.map((c) => c.name)).toEqual([
      "Workspace s2",
      "Workspace foreign",
      "Workspace d1",
    ]);
    expect(state.chatDeletes).toEqual([["org-a", cid("s1")]]);
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
      const { id, name } = state.chat[0]!;
      const key = Object.keys(CONNECTIONS).find((k) => cid(k) === id)!;
      expect(await disconnectSlack(key)).toMatchObject({
        ok: true,
        warning: expect.stringContaining(name),
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

describe("disconnectDiscord", () => {
  const server = (id: string, organizationId = "org-a") => ({
    id: cid(id),
    organizationId,
    platform: "discord" as const,
    externalId: `guild-${id}`,
    name: `Server ${id}`,
    credentials: null,
  });
  const ENV = {
    DISCORD_APPLICATION_ID: "app-1",
    DISCORD_CLIENT_SECRET: "secret-1",
    DISCORD_BOT_TOKEN: "bot-token-1",
    DISCORD_PUBLIC_KEY: "public-key-1",
  };

  beforeEach(() => {
    Object.assign(process.env, ENV);
    state.user = user("admin");
    state.chat = [
      server("d1"),
      server("d2"),
      server("foreign", "org-b"),
      { ...server("s1"), platform: "slack", credentials: { botToken: "xoxb-s1" } },
    ];
    state.chatDeletes = [];
    discordLeft.length = 0;
    discordLeave = () => new HttpResponse(null, { status: 204 });
  });
  afterEach(() => {
    for (const name of Object.keys(ENV)) delete process.env[name];
  });

  it("removes the server and makes the bot leave it", async () => {
    expect(await disconnectDiscord("d1")).toEqual({ ok: true });
    expect(state.chat.map((c) => c.name)).toEqual(["Server d2", "Server foreign", "Server s1"]);
    expect(state.chatDeletes).toEqual([["org-a", cid("d1")]]);
    expect(discordLeft).toEqual([{ guildId: "guild-d1", authorization: "Bot bot-token-1" }]);
  });

  it("treats a server the bot already left as left", async () => {
    discordLeave = () => HttpResponse.json({ code: 10004 }, { status: 404 });
    expect(await disconnectDiscord("d1")).toEqual({ ok: true });
  });

  it("still disconnects, with a warning, when leaving fails or Discord isn't configured", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    discordLeave = () => new HttpResponse(null, { status: 500 });
    expect(await disconnectDiscord("d1")).toMatchObject({
      ok: true,
      warning: expect.stringContaining("Server d1"),
    });
    delete process.env.DISCORD_BOT_TOKEN;
    expect(await disconnectDiscord("d2")).toMatchObject({
      ok: true,
      warning: expect.stringContaining("Server d2"),
    });
    consoleError.mockRestore();
    expect(state.chat.map((c) => c.name)).toEqual(["Server foreign", "Server s1"]);
    expect(discordLeft.map((l) => l.guildId)).toEqual(["guild-d1"]);
  });

  it("only disconnects the active organization's Discord servers", async () => {
    for (const id of ["foreign", "s1", "missing"]) {
      expect(await disconnectDiscord(id)).toEqual({
        ok: false,
        error: "That Discord server isn't connected.",
      });
    }
    expect(state.chatDeletes).toEqual([]);
    expect(state.chat).toHaveLength(4);
    expect(discordLeft).toEqual([]);
  });

  it("is admin-only", async () => {
    state.user = user("member");
    expect(await disconnectDiscord("d1")).toMatchObject({ ok: false });
    expect(state.chatDeletes).toEqual([]);
    expect(discordLeft).toEqual([]);
  });
});

describe("saveChatPlaybookDefaults", () => {
  beforeEach(() => {
    state.user = user("admin");
    state.chatPlaybookDefaults = [];
  });

  it("saves the organization's chat playbooks", async () => {
    const playbooks = { ask: "builtin:ask-about-code", startWork: "builtin:handle-request" };
    expect(await saveChatPlaybookDefaults(playbooks)).toEqual({ ok: true });
    expect(state.chatPlaybookDefaults).toEqual([["org-a", playbooks, "admin-1"]]);
  });

  it("rejects a playbook that doesn't pass validateChatPlaybookChoice", async () => {
    for (const [playbooks, field] of [
      [{ ask: "builtin:handle-request", startWork: "builtin:handle-request" }, "ask"],
      [{ ask: "builtin:ask-about-code", startWork: "builtin:implement-story" }, "startWork"],
      [{ ask: "builtin:ask-about-code", startWork: "builtin:nope" }, "startWork"],
    ] as const) {
      const result = await saveChatPlaybookDefaults(playbooks);
      expect(result).toMatchObject({ ok: false, fieldErrors: { [field]: expect.any(String) } });
    }
    expect(await saveChatPlaybookDefaults(null as never)).toMatchObject({ ok: false });
    expect(state.chatPlaybookDefaults).toEqual([]);
  });

  it("saves the organization's own chat playbooks", async () => {
    const playbooks = { ask: IDS.query, startWork: IDS.coding };
    expect(await saveChatPlaybookDefaults(playbooks)).toEqual({ ok: true });
    expect(state.chatPlaybookDefaults).toEqual([["org-a", playbooks, "admin-1"]]);
  });

  it("rejects another organization's playbook or one of another role", async () => {
    for (const [playbooks, field] of [
      [{ ask: IDS.foreign, startWork: IDS.coding }, "ask"],
      [{ ask: IDS.coding, startWork: IDS.coding }, "ask"],
      [{ ask: IDS.query, startWork: IDS.query }, "startWork"],
      [{ ask: IDS.notChat, startWork: IDS.coding }, "ask"],
    ] as const) {
      const result = await saveChatPlaybookDefaults(playbooks);
      expect(result).toMatchObject({ ok: false, fieldErrors: { [field]: expect.any(String) } });
    }
    expect(state.chatPlaybookDefaults).toEqual([]);
  });

  it("names the role a choice needs", async () => {
    expect(await saveChatPlaybookDefaults({ ask: IDS.coding, startWork: IDS.query })).toMatchObject(
      {
        ok: false,
        fieldErrors: {
          ask: "Ask about code needs a chat-ask playbook; Custom Handle a request is a request playbook.",
          startWork:
            "Start work needs a request playbook; Custom Ask about code is a chat-ask playbook.",
        },
      },
    );
    expect(
      await saveChatPlaybookDefaults({ ask: "builtin:nope", startWork: "builtin:handle-request" }),
    ).toMatchObject({ ok: false, fieldErrors: { ask: "There's no playbook builtin:nope." } });
  });

  it("refuses non-admins", async () => {
    state.user = user("member");
    expect(
      await saveChatPlaybookDefaults({
        ask: "builtin:ask-about-code",
        startWork: "builtin:handle-request",
      }),
    ).toMatchObject({ ok: false });
    expect(state.chatPlaybookDefaults).toEqual([]);
  });
});

describe("saveChatChannelPlaybooks and removeChatChannelPlaybooks", () => {
  it("404s on a connection ID that isn't a UUID", async () => {
    const response = await channels.PUT(
      new Request("http://localhost/api/ui", { method: "PUT", body: "{}" }),
      { params: Promise.resolve({ id: "s1" }) },
    );
    expect(response.status).toBe(404);
  });

  beforeEach(() => {
    state.user = user("admin");
    state.chat = [
      {
        id: cid("s1"),
        organizationId: "org-a",
        platform: "slack",
        externalId: "T1",
        name: "Acme",
        credentials: { botToken: "xoxb" },
      },
      {
        id: cid("d1"),
        organizationId: "org-a",
        platform: "discord",
        externalId: "111",
        name: "Acme",
        credentials: null,
      },
      {
        id: cid("foreign"),
        organizationId: "org-b",
        platform: "slack",
        externalId: "T2",
        name: "Other",
        credentials: { botToken: "xoxb" },
      },
    ];
    state.channelPlaybooks = [];
  });

  it("saves a channel's overrides under its Chat SDK channel ID", async () => {
    expect(
      await saveChatChannelPlaybooks("s1", "C0123ABCD", {
        ask: "builtin:ask-about-code",
        startWork: null,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await saveChatChannelPlaybooks("d1", "222", {
        ask: null,
        startWork: "builtin:handle-request",
      }),
    ).toMatchObject({ ok: true });
    expect(state.channelPlaybooks).toEqual([
      {
        organizationId: "org-a",
        connectionId: cid("s1"),
        channelId: "slack:C0123ABCD",
        askPlaybookId: "builtin:ask-about-code",
        startWorkPlaybookId: null,
        updatedBy: "admin-1",
      },
      {
        organizationId: "org-a",
        connectionId: cid("d1"),
        channelId: "discord:111:222",
        askPlaybookId: null,
        startWorkPlaybookId: "builtin:handle-request",
        updatedBy: "admin-1",
      },
    ]);
    expect(await removeChatChannelPlaybooks("s1", "slack:C0123ABCD")).toEqual({ ok: true });
    expect(state.channelPlaybooks.map((t) => t.connectionId)).toEqual([cid("d1")]);
    expect(await removeChatChannelPlaybooks("s1", "slack:C0123ABCD")).toMatchObject({ ok: false });
  });

  it("saves a channel override naming the organization's own playbooks", async () => {
    expect(
      await saveChatChannelPlaybooks("s1", "C0123ABCD", {
        ask: IDS.query,
        startWork: IDS.coding,
      }),
    ).toMatchObject({ ok: true });
    expect(state.channelPlaybooks).toEqual([
      expect.objectContaining({
        channelId: "slack:C0123ABCD",
        askPlaybookId: IDS.query,
        startWorkPlaybookId: IDS.coding,
      }),
    ]);
  });

  it("rejects a channel override naming another organization's playbook, or a wrong one", async () => {
    for (const [playbooks, field] of [
      [{ ask: IDS.foreign, startWork: null }, "ask"],
      [{ ask: IDS.coding, startWork: null }, "ask"],
      [{ ask: null, startWork: IDS.query }, "startWork"],
      [{ ask: IDS.notChat, startWork: null }, "ask"],
    ] as const) {
      const result = await saveChatChannelPlaybooks("s1", "C0123ABCD", playbooks);
      expect(result).toMatchObject({ ok: false, fieldErrors: { [field]: expect.any(String) } });
    }
    expect(state.channelPlaybooks).toEqual([]);
  });

  it("rejects an invalid playbook, channel or connection", async () => {
    expect(
      await saveChatChannelPlaybooks("s1", "C0123ABCD", {
        ask: "builtin:review-pr",
        startWork: null,
      }),
    ).toMatchObject({ ok: false, fieldErrors: { ask: expect.any(String) } });
    expect(
      await saveChatChannelPlaybooks("s1", "C0123ABCD", {
        ask: null,
        startWork: "builtin:implement-story",
      }),
    ).toMatchObject({ ok: false, fieldErrors: { startWork: expect.any(String) } });
    expect(
      await saveChatChannelPlaybooks("s1", "C0123ABCD", { ask: null, startWork: null }),
    ).toMatchObject({ ok: false });
    expect(
      await saveChatChannelPlaybooks("s1", "not a channel!", {
        ask: "builtin:ask-about-code",
        startWork: null,
      }),
    ).toMatchObject({ ok: false, fieldErrors: { channel: expect.any(String) } });
    expect(
      await saveChatChannelPlaybooks("foreign", "C0123ABCD", {
        ask: "builtin:ask-about-code",
        startWork: null,
      }),
    ).toEqual({ ok: false, error: "That chat connection isn't connected." });
    expect(state.channelPlaybooks).toEqual([]);
  });

  it("refuses non-admins", async () => {
    state.channelPlaybooks = [
      {
        organizationId: "org-a",
        connectionId: cid("s1"),
        channelId: "slack:C1",
        askPlaybookId: "builtin:ask-about-code",
        startWorkPlaybookId: null,
        updatedBy: "admin-1",
      },
    ];
    state.user = user("member");
    expect(
      await saveChatChannelPlaybooks("s1", "C0123ABCD", {
        ask: "builtin:ask-about-code",
        startWork: null,
      }),
    ).toMatchObject({ ok: false });
    expect(await removeChatChannelPlaybooks("s1", "slack:C1")).toMatchObject({ ok: false });
    expect(state.channelPlaybooks).toHaveLength(1);
  });
});

describe("the organization's hidden web connection", () => {
  beforeEach(() => {
    state.user = user("admin");
    state.chat = [
      {
        id: cid("s1"),
        organizationId: "org-a",
        platform: "slack",
        externalId: "T1",
        name: "Acme",
        credentials: { botToken: "xoxb" },
      },
      {
        id: cid("web"),
        organizationId: "org-a",
        platform: "web",
        externalId: "org-a",
        name: "Omniralph",
        credentials: null,
      },
    ];
    state.chatDeletes = [];
    state.channelPlaybooks = [];
    slackRevoke = () => HttpResponse.json({ ok: true, revoked: true });
    discordLeave = () => new HttpResponse(null, { status: 204 });
    slackRevoked.length = 0;
    discordLeft.length = 0;
  });

  it("is never disconnected as a Slack workspace or Discord server", async () => {
    expect(await disconnectSlack("web")).toEqual({
      ok: false,
      error: "That Slack workspace isn't connected.",
    });
    expect(await disconnectDiscord("web")).toEqual({
      ok: false,
      error: "That Discord server isn't connected.",
    });
    expect(state.chatDeletes).toEqual([]);
    expect(state.chat).toHaveLength(2);
    expect(slackRevoked).toEqual([]);
    expect(discordLeft).toEqual([]);
  });

  it("takes no channel overrides", async () => {
    expect(
      await saveChatChannelPlaybooks("web", "C0123ABCD", {
        ask: "builtin:ask-about-code",
        startWork: null,
      }),
    ).toEqual({ ok: false, error: "That chat connection isn't connected." });
    expect(state.channelPlaybooks).toEqual([]);
  });
});
