import type * as Db from "@omniralph/db";
import { BUILTIN_TASKS, getBuiltinTask, type TaskDefinition } from "@omniralph/tasks";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG_ID = "org-a";
const CONNECTION_ID = "conn-1";

const state = vi.hoisted(() => ({
  /** The organization's `chat.tasks` setting value, or undefined when absent. */
  defaults: undefined as unknown,
  /** Channel overrides by channel ID. */
  overrides: new Map<
    string,
    { askAboutCodeTaskId: string | null; startWorkTaskId: string | null }
  >(),
  lookups: [] as Array<[string, string, string]>,
}));

vi.mock("@omniralph/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  getChatChannelTaskSetting: async (
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
  CHAT_TASK_FILTERS,
  chatChannelId,
  chatTasksFor,
  platformChannelId,
  validateChatTaskChoice,
} = await import("./tasks");
const { matchesTaskFilter } = await import("@/lib/definitions");

/** A database whose `app_settings` read returns the organization's `chat.tasks` setting. */
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

describe("chatTasksFor", () => {
  beforeEach(() => {
    state.defaults = undefined;
    state.overrides.clear();
    state.lookups = [];
  });

  it("is the built-in tasks when nothing is chosen", async () => {
    expect(await chatTasksFor(db, connection, "C1")).toEqual({
      askAboutCode: "builtin:ask-about-code",
      startWork: "builtin:handle-request",
    });
    expect(state.lookups).toEqual([[ORG_ID, CONNECTION_ID, "C1"]]);
  });

  it("takes each field from the organization's choice when set", async () => {
    state.defaults = { askAboutCode: "builtin:org-query" };
    expect(await chatTasksFor(db, connection, "C1")).toEqual({
      askAboutCode: "builtin:org-query",
      startWork: "builtin:handle-request",
    });
    state.defaults = { startWork: "builtin:org-coding" };
    expect(await chatTasksFor(db, connection, "C1")).toEqual({
      askAboutCode: "builtin:ask-about-code",
      startWork: "builtin:org-coding",
    });
  });

  it("takes each field from the channel's override when set", async () => {
    state.defaults = { askAboutCode: "builtin:org-query", startWork: "builtin:org-coding" };
    state.overrides.set("C1", {
      askAboutCodeTaskId: "builtin:channel-query",
      startWorkTaskId: null,
    });
    state.overrides.set("C2", {
      askAboutCodeTaskId: null,
      startWorkTaskId: "builtin:channel-coding",
    });
    expect(await chatTasksFor(db, connection, "C1")).toEqual({
      askAboutCode: "builtin:channel-query",
      startWork: "builtin:org-coding",
    });
    expect(await chatTasksFor(db, connection, "C2")).toEqual({
      askAboutCode: "builtin:org-query",
      startWork: "builtin:channel-coding",
    });
    // Another channel keeps the organization's choice.
    expect(await chatTasksFor(db, connection, "C3")).toEqual({
      askAboutCode: "builtin:org-query",
      startWork: "builtin:org-coding",
    });
  });

  it("overrides the built-in default when the organization chose nothing", async () => {
    state.overrides.set("C1", {
      askAboutCodeTaskId: null,
      startWorkTaskId: "builtin:channel-coding",
    });
    expect(await chatTasksFor(db, connection, "C1")).toEqual({
      askAboutCode: "builtin:ask-about-code",
      startWork: "builtin:channel-coding",
    });
  });
});

/** A task like a built-in one (`base`) with another ID and changes. */
const task = (id: string, base: string, changes: Partial<TaskDefinition> = {}): TaskDefinition => ({
  ...getBuiltinTask(base)!,
  id,
  ...changes,
});

describe("validateChatTaskChoice", () => {
  it("accepts the built-in chat tasks", () => {
    expect(
      validateChatTaskChoice("askAboutCode", "builtin:ask-about-code", getBuiltinTask),
    ).toMatchObject({
      ok: true,
      task: { id: "builtin:ask-about-code" },
    });
    expect(
      validateChatTaskChoice("startWork", "builtin:handle-request", getBuiltinTask),
    ).toMatchObject({
      ok: true,
      task: { id: "builtin:handle-request" },
    });
  });

  it("refuses an unknown task", () => {
    expect(validateChatTaskChoice("askAboutCode", "builtin:nope", getBuiltinTask)).toMatchObject({
      ok: false,
      reason: "unknown_task",
    });
  });

  it("refuses a task of the wrong type", () => {
    expect(
      validateChatTaskChoice("askAboutCode", "builtin:handle-request", getBuiltinTask),
    ).toMatchObject({
      ok: false,
      reason: "wrong_type",
    });
    expect(
      validateChatTaskChoice("startWork", "builtin:ask-about-code", getBuiltinTask),
    ).toMatchObject({
      ok: false,
      reason: "wrong_type",
    });
    expect(
      validateChatTaskChoice("askAboutCode", "builtin:review-pr", getBuiltinTask),
    ).toMatchObject({
      ok: false,
      reason: "wrong_type",
    });
  });

  it("refuses a task that doesn't run on chat requests", () => {
    expect(
      validateChatTaskChoice("askAboutCode", "builtin:learn-rule", getBuiltinTask),
    ).toMatchObject({
      ok: false,
      reason: "missing_trigger",
    });
    expect(
      validateChatTaskChoice("startWork", "builtin:implement-story", getBuiltinTask),
    ).toMatchObject({
      ok: false,
      reason: "missing_trigger",
    });
  });

  it("gives each refusal a distinct error", () => {
    const errors = [
      validateChatTaskChoice("askAboutCode", "builtin:nope", getBuiltinTask),
      validateChatTaskChoice("askAboutCode", "builtin:handle-request", getBuiltinTask),
      validateChatTaskChoice("askAboutCode", "builtin:learn-rule", getBuiltinTask),
    ].map((result) => (result.ok ? null : result.error));
    expect(new Set(errors).size).toBe(3);
    expect(errors).not.toContain(null);
  });

  it("looks tasks up with the given lookup", () => {
    const custom = task("00000000-0000-4000-8000-000000000001", "builtin:ask-about-code");
    expect(validateChatTaskChoice("askAboutCode", custom.id, () => custom)).toMatchObject({
      ok: true,
    });
    expect(validateChatTaskChoice("askAboutCode", custom.id, () => null)).toMatchObject({
      ok: false,
      reason: "unknown_task",
    });
  });
});

describe("CHAT_TASK_FILTERS", () => {
  it("offers tasks of the role's type accepting chat.request, built-in or custom", () => {
    const tasks = [
      task("builtin:ask-about-code", "builtin:ask-about-code"),
      task("00000000-0000-4000-8000-000000000001", "builtin:ask-about-code"),
      task("00000000-0000-4000-8000-000000000002", "builtin:ask-about-code", {
        triggers: ["run.invoked"],
      }),
      task("builtin:handle-request", "builtin:handle-request"),
      task("00000000-0000-4000-8000-000000000003", "builtin:handle-request"),
      task("00000000-0000-4000-8000-000000000004", "builtin:handle-request", {
        triggers: ["linear.mention"],
      }),
    ];
    const offered = (role: "askAboutCode" | "startWork") =>
      tasks.filter((t) => matchesTaskFilter(t, CHAT_TASK_FILTERS[role])).map((t) => t.id);
    expect(offered("askAboutCode")).toEqual([
      "builtin:ask-about-code",
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(offered("startWork")).toEqual([
      "builtin:handle-request",
      "00000000-0000-4000-8000-000000000003",
    ]);
  });

  it("offers exactly the tasks passing validateChatTaskChoice", () => {
    for (const role of ["askAboutCode", "startWork"] as const) {
      for (const t of BUILTIN_TASKS) {
        expect(matchesTaskFilter(t, CHAT_TASK_FILTERS[role])).toBe(
          validateChatTaskChoice(role, t.id, () => t).ok,
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
