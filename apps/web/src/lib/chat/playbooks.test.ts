import type * as Db from "@omniralph/db";
import { BUILTIN_PLAYBOOKS, getBuiltinPlaybook, type Playbook } from "@omniralph/tasks";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG_ID = "org-a";
const CONNECTION_ID = "conn-1";

const state = vi.hoisted(() => ({
  /** The organization's `chat.playbooks` setting value, or undefined when absent. */
  defaults: undefined as unknown,
  /** Channel overrides by channel ID. */
  overrides: new Map<
    string,
    { askPlaybookId: string | null; startWorkPlaybookId: string | null }
  >(),
  lookups: [] as Array<[string, string, string]>,
}));

vi.mock("@omniralph/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  getChatChannelPlaybookSetting: async (
    _db: unknown,
    organizationId: string,
    connectionId: string,
    channelId: string,
  ) => {
    state.lookups.push([organizationId, connectionId, channelId]);
    return organizationId === ORG_ID && connectionId === CONNECTION_ID
      ? (state.overrides.get(channelId) ?? null)
      : null;
  },
}));

const {
  CHAT_PLAYBOOK_FILTERS,
  chatChannelId,
  chatPlaybooksFor,
  platformChannelId,
  validateChatPlaybookChoice,
} = await import("./playbooks");
const { matchesPlaybookFilter } = await import("@/lib/playbooks");

/** A database whose `app_settings` read returns the organization's `chat.playbooks` setting. */
const db = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () =>
          state.defaults === undefined
            ? []
            : [{ value: state.defaults, updatedBy: null, updatedAt: new Date() }],
      }),
    }),
  }),
} as unknown as Db.Database;

const connection = { id: CONNECTION_ID, organizationId: ORG_ID };

describe("chatPlaybooksFor", () => {
  beforeEach(() => {
    state.defaults = undefined;
    state.overrides.clear();
    state.lookups = [];
  });

  it("is the built-in playbooks when nothing is chosen", async () => {
    expect(await chatPlaybooksFor(db, connection, "C1")).toEqual({
      ask: "builtin:ask-about-code",
      startWork: "builtin:handle-request",
    });
    expect(state.lookups).toEqual([[ORG_ID, CONNECTION_ID, "C1"]]);
  });

  it("takes each field from the organization's choice when set", async () => {
    state.defaults = { ask: "builtin:org-ask" };
    expect(await chatPlaybooksFor(db, connection, "C1")).toEqual({
      ask: "builtin:org-ask",
      startWork: "builtin:handle-request",
    });
    state.defaults = { startWork: "builtin:org-request" };
    expect(await chatPlaybooksFor(db, connection, "C1")).toEqual({
      ask: "builtin:ask-about-code",
      startWork: "builtin:org-request",
    });
  });

  it("ignores the old chat.tasks field names", async () => {
    state.defaults = { askAboutCode: "builtin:org-ask" };
    expect(await chatPlaybooksFor(db, connection, "C1")).toEqual({
      ask: "builtin:ask-about-code",
      startWork: "builtin:handle-request",
    });
  });

  it("takes each field from the channel's override when set", async () => {
    state.defaults = { ask: "builtin:org-ask", startWork: "builtin:org-request" };
    state.overrides.set("C1", {
      askPlaybookId: "builtin:channel-ask",
      startWorkPlaybookId: null,
    });
    state.overrides.set("C2", {
      askPlaybookId: null,
      startWorkPlaybookId: "builtin:channel-request",
    });
    expect(await chatPlaybooksFor(db, connection, "C1")).toEqual({
      ask: "builtin:channel-ask",
      startWork: "builtin:org-request",
    });
    expect(await chatPlaybooksFor(db, connection, "C2")).toEqual({
      ask: "builtin:org-ask",
      startWork: "builtin:channel-request",
    });
    // Another channel keeps the organization's choice.
    expect(await chatPlaybooksFor(db, connection, "C3")).toEqual({
      ask: "builtin:org-ask",
      startWork: "builtin:org-request",
    });
  });

  it("overrides the built-in default when the organization chose nothing", async () => {
    state.overrides.set("C1", {
      askPlaybookId: null,
      startWorkPlaybookId: "builtin:channel-request",
    });
    expect(await chatPlaybooksFor(db, connection, "C1")).toEqual({
      ask: "builtin:ask-about-code",
      startWork: "builtin:channel-request",
    });
  });
});

/** A playbook like a built-in one (`base`) with another ID. */
const custom = (id: string, base: string): Playbook => ({ ...getBuiltinPlaybook(base)!, id });
const builtin = (id: string) => getBuiltinPlaybook(id) ?? null;

describe("validateChatPlaybookChoice", () => {
  it("accepts the built-in chat playbooks", () => {
    expect(
      validateChatPlaybookChoice("ask", "builtin:ask-about-code", builtin("builtin:ask-about-code")),
    ).toMatchObject({ ok: true, playbook: { id: "builtin:ask-about-code" } });
    expect(
      validateChatPlaybookChoice(
        "startWork",
        "builtin:handle-request",
        builtin("builtin:handle-request"),
      ),
    ).toMatchObject({ ok: true, playbook: { id: "builtin:handle-request" } });
  });

  it("refuses an unknown playbook", () => {
    expect(validateChatPlaybookChoice("ask", "builtin:nope", null)).toEqual({
      ok: false,
      reason: "unknown_playbook",
      error: "There's no playbook builtin:nope.",
    });
  });

  it("refuses a playbook of another role", () => {
    expect(
      validateChatPlaybookChoice("ask", "builtin:handle-request", builtin("builtin:handle-request")),
    ).toMatchObject({
      ok: false,
      reason: "wrong_role",
      error: expect.stringMatching(/^Ask about code needs a chat-ask playbook; .* is a request playbook\.$/),
    });
    for (const id of [
      "builtin:ask-about-code",
      "builtin:implement-story",
      "builtin:review-pr",
      "builtin:describe-pr",
    ]) {
      expect(validateChatPlaybookChoice("startWork", id, builtin(id))).toMatchObject({
        ok: false,
        reason: "wrong_role",
      });
    }
  });

  it("accepts a custom playbook of the role", () => {
    const ask = custom("00000000-0000-4000-8000-000000000001", "builtin:ask-about-code");
    expect(validateChatPlaybookChoice("ask", ask.id, ask)).toMatchObject({ ok: true });
  });
});

describe("CHAT_PLAYBOOK_FILTERS", () => {
  it("offers the playbooks of the slot's role, built-in or custom", () => {
    const playbooks = [
      ...BUILTIN_PLAYBOOKS,
      custom("00000000-0000-4000-8000-000000000001", "builtin:ask-about-code"),
      custom("00000000-0000-4000-8000-000000000003", "builtin:handle-request"),
      custom("00000000-0000-4000-8000-000000000004", "builtin:implement-story"),
    ];
    const offered = (slot: "ask" | "startWork") =>
      playbooks
        .filter((p) => matchesPlaybookFilter(p, CHAT_PLAYBOOK_FILTERS[slot]))
        .map((p) => p.id);
    expect(offered("ask")).toEqual([
      "builtin:ask-about-code",
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(offered("startWork")).toEqual([
      "builtin:handle-request",
      "00000000-0000-4000-8000-000000000003",
    ]);
  });

  it("offers exactly the playbooks passing validateChatPlaybookChoice", () => {
    for (const slot of ["ask", "startWork"] as const) {
      for (const playbook of BUILTIN_PLAYBOOKS) {
        expect(matchesPlaybookFilter(playbook, CHAT_PLAYBOOK_FILTERS[slot])).toBe(
          validateChatPlaybookChoice(slot, playbook.id, playbook).ok,
        );
      }
    }
  });
});

describe("chatChannelId", () => {
  it("is the Chat SDK channel ID of a Slack channel", () => {
    const slack = { platform: "slack" as const, externalId: "T1" };
    expect(chatChannelId(slack, " C0123ABCD ")).toBe("slack:C0123ABCD");
    expect(chatChannelId(slack, "general")).toBeNull();
    expect(chatChannelId(slack, "#general")).toBeNull();
    expect(chatChannelId(slack, "")).toBeNull();
  });

  it("is the Chat SDK channel ID of a Discord channel", () => {
    const discord = { platform: "discord" as const, externalId: "111" };
    expect(chatChannelId(discord, "222")).toBe("discord:111:222");
    expect(chatChannelId(discord, "#general")).toBeNull();
  });

  it("round-trips to the platform's ID", () => {
    expect(platformChannelId("slack:C1")).toBe("C1");
    expect(platformChannelId("discord:111:222")).toBe("222");
  });
});
