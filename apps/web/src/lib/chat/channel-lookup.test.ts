import type { ChatConnection, Database } from "@omniralph/db";
import { describe, expect, it, vi } from "vitest";
import { channelName, findChatChannel } from "./channel-lookup";

vi.mock("server-only", () => ({}));

const env = {
  DISCORD_APPLICATION_ID: "app",
  DISCORD_CLIENT_SECRET: "secret",
  DISCORD_BOT_TOKEN: "bot-token",
  DISCORD_PUBLIC_KEY: "key",
} as unknown as NodeJS.ProcessEnv;

const discord = {
  id: "conn-1",
  organizationId: "org-1",
  platform: "discord",
  externalId: "G1",
  name: "Acme Gaming",
} as ChatConnection;

describe("channelName", () => {
  it("normalizes a typed channel name, and refuses what can't be one", () => {
    expect(channelName("#Release-Train ")).toBe("release-train");
    expect(channelName("general")).toBe("general");
    expect(channelName("not a channel!")).toBeNull();
    expect(channelName("#")).toBeNull();
    expect(channelName("")).toBeNull();
  });
});

describe("findChatChannel › Discord", () => {
  const db = {} as Database;

  it("finds a text or announcement channel of the server by name, with the bot token", async () => {
    const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      Response.json([
        { id: "1", name: "general", type: 2 },
        { id: "2", name: "general", type: 0 },
        { id: "3", name: "news", type: 5 },
      ]),
    );
    expect(await findChatChannel({ db, fetch, env }, discord, "general")).toEqual({
      ok: true,
      channel: "2",
    });
    expect(await findChatChannel({ db, fetch, env }, discord, "news")).toEqual({
      ok: true,
      channel: "3",
    });
    expect(String(fetch.mock.calls[0]![0])).toBe("https://discord.com/api/v10/guilds/G1/channels");
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("authorization")).toBe(
      "Bot bot-token",
    );
  });

  it("answers not found, or unavailable when Discord fails or isn't configured", async () => {
    const empty = vi.fn(async () => Response.json([]));
    expect(await findChatChannel({ db, fetch: empty, env }, discord, "general")).toEqual({
      ok: false,
      reason: "not_found",
    });
    const failing = vi.fn(async () => new Response("no", { status: 403 }));
    expect(await findChatChannel({ db, fetch: failing, env }, discord, "general")).toEqual({
      ok: false,
      reason: "unavailable",
    });
    const throwing = vi.fn(async () => {
      throw new Error("network");
    });
    expect(await findChatChannel({ db, fetch: throwing, env }, discord, "general")).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(
      await findChatChannel({ db, fetch: empty, env: {} as NodeJS.ProcessEnv }, discord, "general"),
    ).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(empty).toHaveBeenCalledTimes(1);
  });
});
