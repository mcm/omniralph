import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
    externalId?: string;
    name: string;
    credentials: { botToken: string } | null;
  }>,
  chatDeletes: [] as Array<[string, string]>,
  chatTaskDefaults: [] as Array<[string, unknown, string | null]>,
  channelTasks: [] as Array<{
    organizationId: string;
    connectionId: string;
    channelId: string;
    askAboutCodeTaskId: string | null;
    startWorkTaskId: string | null;
    updatedBy: string | null;
  }>,
}));
/** Stored tasks: org-a's chat query and coding tasks, a non-chat one, and org-b's chat query task. */
const IDS = {
  query: "11111111-1111-4111-8111-111111111111",
  coding: "22222222-2222-4222-8222-222222222222",
  notChat: "33333333-3333-4333-8333-333333333333",
  foreign: "44444444-4444-4444-8444-444444444444",
};
const rows = vi.hoisted(async () => {
  const { getBuiltinTask } = await import("@omniralph/tasks");
  const row = (id: string, organizationId: string, base: string, changes: object = {}) => {
    const { id: _id, name, ...definition } = getBuiltinTask(base)!;
    const now = new Date("2026-10-01T00:00:00Z");
    return {
      id,
      organizationId,
      name: `Custom ${name}`,
      definition: { ...definition, ...changes },
      requirements: { minHarnessVersion: "0.40.0", installables: [], hostTools: ["git"] },
      createdAt: now,
      updatedAt: now,
      createdBy: null,
      updatedBy: null,
    };
  };
  return [
    row("11111111-1111-4111-8111-111111111111", "org-a", "builtin:ask-about-code"),
    row("22222222-2222-4222-8222-222222222222", "org-a", "builtin:handle-request"),
    row("33333333-3333-4333-8333-333333333333", "org-a", "builtin:ask-about-code", {
      triggers: ["finding.mention"],
    }),
    row("44444444-4444-4444-8444-444444444444", "org-b", "builtin:ask-about-code"),
  ];
});
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/session", () => ({
  requireUser: async (role: Role = "member") =>
    assertRole(state.user && { ...state.user, organization: { id: "org-a", name: "Acme" } }, role),
}));
vi.mock("@omniralph/db", async () => ({
  getStoredTaskDefinition: async (_db: unknown, organizationId: string, id: string) =>
    (await rows).find((r) => r.organizationId === organizationId && r.id === id) ?? null,
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
  getChatConnection: async (_db: unknown, organizationId: string, id: string) =>
    state.chat.find((c) => c.organizationId === organizationId && c.id === id) ?? null,
  setChatTaskDefaults: async (
    _db: unknown,
    organizationId: string,
    tasks: unknown,
    updatedBy: string | null,
  ) => {
    state.chatTaskDefaults.push([organizationId, tasks, updatedBy]);
  },
  upsertChatChannelTaskSetting: async (
    _db: unknown,
    input: (typeof state.channelTasks)[number],
  ) => {
    if (
      !state.chat.some(
        (c) => c.organizationId === input.organizationId && c.id === input.connectionId,
      )
    )
      return null;
    state.channelTasks = state.channelTasks.filter(
      (t) => !(t.connectionId === input.connectionId && t.channelId === input.channelId),
    );
    state.channelTasks.push(input);
    return { id: "setting-1", ...input, updatedAt: new Date() };
  },
  deleteChatChannelTaskSetting: async (
    _db: unknown,
    organizationId: string,
    connectionId: string,
    channelId: string,
  ) => {
    const before = state.channelTasks.length;
    state.channelTasks = state.channelTasks.filter(
      (t) =>
        !(
          t.organizationId === organizationId &&
          t.connectionId === connectionId &&
          t.channelId === channelId
        ),
    );
    return state.channelTasks.length < before;
  },
}));

const {
  disconnectDiscord,
  disconnectLinear,
  disconnectSlack,
  removeChatChannelTasks,
  saveChatChannelTasks,
  saveChatTaskDefaults,
} = await import("./actions");

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

describe("disconnectDiscord", () => {
  const discord = (id: string, organizationId = "org-a") => ({
    id,
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
      discord("d1"),
      discord("d2"),
      discord("foreign", "org-b"),
      { ...discord("s1"), platform: "slack", credentials: { botToken: "xoxb-s1" } },
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
    expect(state.chat.map((c) => c.id)).toEqual(["d2", "foreign", "s1"]);
    expect(state.chatDeletes).toEqual([["org-a", "d1"]]);
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
    expect(state.chat.map((c) => c.id)).toEqual(["foreign", "s1"]);
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

describe("saveChatTaskDefaults", () => {
  beforeEach(() => {
    state.user = user("admin");
    state.chatTaskDefaults = [];
  });

  it("saves the organization's chat tasks", async () => {
    const tasks = { askAboutCode: "builtin:ask-about-code", startWork: "builtin:handle-request" };
    expect(await saveChatTaskDefaults(tasks)).toEqual({ ok: true });
    expect(state.chatTaskDefaults).toEqual([["org-a", tasks, "admin-1"]]);
  });

  it("rejects a task that doesn't pass validateChatTaskChoice", async () => {
    for (const [tasks, field] of [
      [
        { askAboutCode: "builtin:handle-request", startWork: "builtin:handle-request" },
        "askAboutCode",
      ],
      [
        { askAboutCode: "builtin:ask-about-code", startWork: "builtin:implement-story" },
        "startWork",
      ],
      [{ askAboutCode: "builtin:ask-about-code", startWork: "builtin:nope" }, "startWork"],
    ] as const) {
      const result = await saveChatTaskDefaults(tasks);
      expect(result).toMatchObject({ ok: false, fieldErrors: { [field]: expect.any(String) } });
    }
    expect(await saveChatTaskDefaults(null as never)).toMatchObject({ ok: false });
    expect(state.chatTaskDefaults).toEqual([]);
  });

  it("saves the organization's own chat tasks", async () => {
    const tasks = { askAboutCode: IDS.query, startWork: IDS.coding };
    expect(await saveChatTaskDefaults(tasks)).toEqual({ ok: true });
    expect(state.chatTaskDefaults).toEqual([["org-a", tasks, "admin-1"]]);
  });

  it("rejects another organization's task, one of the wrong type or not accepting chat.request", async () => {
    for (const [tasks, field] of [
      [{ askAboutCode: IDS.foreign, startWork: IDS.coding }, "askAboutCode"],
      [{ askAboutCode: IDS.coding, startWork: IDS.coding }, "askAboutCode"],
      [{ askAboutCode: IDS.query, startWork: IDS.query }, "startWork"],
      [{ askAboutCode: IDS.notChat, startWork: IDS.coding }, "askAboutCode"],
    ] as const) {
      const result = await saveChatTaskDefaults(tasks);
      expect(result).toMatchObject({ ok: false, fieldErrors: { [field]: expect.any(String) } });
    }
    expect(state.chatTaskDefaults).toEqual([]);
  });

  it("refuses non-admins", async () => {
    state.user = user("member");
    expect(
      await saveChatTaskDefaults({
        askAboutCode: "builtin:ask-about-code",
        startWork: "builtin:handle-request",
      }),
    ).toMatchObject({ ok: false });
    expect(state.chatTaskDefaults).toEqual([]);
  });
});

describe("saveChatChannelTasks and removeChatChannelTasks", () => {
  beforeEach(() => {
    state.user = user("admin");
    state.chat = [
      {
        id: "s1",
        organizationId: "org-a",
        platform: "slack",
        externalId: "T1",
        name: "Acme",
        credentials: { botToken: "xoxb" },
      },
      {
        id: "d1",
        organizationId: "org-a",
        platform: "discord",
        externalId: "111",
        name: "Acme",
        credentials: null,
      },
      {
        id: "foreign",
        organizationId: "org-b",
        platform: "slack",
        externalId: "T2",
        name: "Other",
        credentials: { botToken: "xoxb" },
      },
    ];
    state.channelTasks = [];
  });

  it("saves a channel's overrides under its Chat SDK channel ID", async () => {
    expect(
      await saveChatChannelTasks("s1", "C0123ABCD", {
        askAboutCode: "builtin:ask-about-code",
        startWork: null,
      }),
    ).toEqual({ ok: true });
    expect(
      await saveChatChannelTasks("d1", "222", {
        askAboutCode: null,
        startWork: "builtin:handle-request",
      }),
    ).toEqual({ ok: true });
    expect(state.channelTasks).toEqual([
      {
        organizationId: "org-a",
        connectionId: "s1",
        channelId: "slack:C0123ABCD",
        askAboutCodeTaskId: "builtin:ask-about-code",
        startWorkTaskId: null,
        updatedBy: "admin-1",
      },
      {
        organizationId: "org-a",
        connectionId: "d1",
        channelId: "discord:111:222",
        askAboutCodeTaskId: null,
        startWorkTaskId: "builtin:handle-request",
        updatedBy: "admin-1",
      },
    ]);
    expect(await removeChatChannelTasks("s1", "slack:C0123ABCD")).toEqual({ ok: true });
    expect(state.channelTasks.map((t) => t.connectionId)).toEqual(["d1"]);
    expect(await removeChatChannelTasks("s1", "slack:C0123ABCD")).toMatchObject({ ok: false });
  });

  it("saves a channel override naming the organization's own tasks", async () => {
    expect(
      await saveChatChannelTasks("s1", "C0123ABCD", {
        askAboutCode: IDS.query,
        startWork: IDS.coding,
      }),
    ).toEqual({ ok: true });
    expect(state.channelTasks).toEqual([
      expect.objectContaining({
        channelId: "slack:C0123ABCD",
        askAboutCodeTaskId: IDS.query,
        startWorkTaskId: IDS.coding,
      }),
    ]);
  });

  it("rejects a channel override naming another organization's task, or a wrong one", async () => {
    for (const [tasks, field] of [
      [{ askAboutCode: IDS.foreign, startWork: null }, "askAboutCode"],
      [{ askAboutCode: IDS.coding, startWork: null }, "askAboutCode"],
      [{ askAboutCode: null, startWork: IDS.query }, "startWork"],
      [{ askAboutCode: IDS.notChat, startWork: null }, "askAboutCode"],
    ] as const) {
      const result = await saveChatChannelTasks("s1", "C0123ABCD", tasks);
      expect(result).toMatchObject({ ok: false, fieldErrors: { [field]: expect.any(String) } });
    }
    expect(state.channelTasks).toEqual([]);
  });

  it("rejects an invalid task, channel or connection", async () => {
    expect(
      await saveChatChannelTasks("s1", "C0123ABCD", {
        askAboutCode: "builtin:review-pr",
        startWork: null,
      }),
    ).toMatchObject({ ok: false, fieldErrors: { askAboutCode: expect.any(String) } });
    expect(
      await saveChatChannelTasks("s1", "C0123ABCD", {
        askAboutCode: null,
        startWork: "builtin:implement-story",
      }),
    ).toMatchObject({ ok: false, fieldErrors: { startWork: expect.any(String) } });
    expect(
      await saveChatChannelTasks("s1", "C0123ABCD", { askAboutCode: null, startWork: null }),
    ).toMatchObject({ ok: false });
    expect(
      await saveChatChannelTasks("s1", "#general", {
        askAboutCode: "builtin:ask-about-code",
        startWork: null,
      }),
    ).toMatchObject({ ok: false, fieldErrors: { channel: expect.any(String) } });
    expect(
      await saveChatChannelTasks("foreign", "C0123ABCD", {
        askAboutCode: "builtin:ask-about-code",
        startWork: null,
      }),
    ).toEqual({ ok: false, error: "That chat connection isn't connected." });
    expect(state.channelTasks).toEqual([]);
  });

  it("refuses non-admins", async () => {
    state.channelTasks = [
      {
        organizationId: "org-a",
        connectionId: "s1",
        channelId: "slack:C1",
        askAboutCodeTaskId: "builtin:ask-about-code",
        startWorkTaskId: null,
        updatedBy: "admin-1",
      },
    ];
    state.user = user("member");
    expect(
      await saveChatChannelTasks("s1", "C0123ABCD", {
        askAboutCode: "builtin:ask-about-code",
        startWork: null,
      }),
    ).toMatchObject({ ok: false });
    expect(await removeChatChannelTasks("s1", "slack:C1")).toMatchObject({ ok: false });
    expect(state.channelTasks).toHaveLength(1);
  });
});
