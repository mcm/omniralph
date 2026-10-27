import "server-only";
import {
  getChatConnectionWithCredentials,
  type ChatConnection,
  type Database,
} from "@omniralph/db";
import { DISCORD_API_URL, discordOAuthConfig } from "@/lib/chat/discord-oauth";
import type { SlackCredentials } from "@/lib/chat/slack-oauth";

/**
 * Finds a channel of a chat connection by its name, for an admin who types `#general`
 * instead of the channel's ID: Slack's `conversations.list` (public and private channels the
 * app can see, `channels:read` and `groups:read`) with the workspace's bot token, or the
 * Discord server's channel list with the deployment's bot token.
 */

export const SLACK_CONVERSATIONS_LIST_URL = "https://slack.com/api/conversations.list";
/** Bounds each call so a hung chat API can't stall the save. */
export const CHANNEL_LOOKUP_TIMEOUT_MS = 10_000;
/** Slack pages of 1000 channels: at most this many are read. */
const SLACK_MAX_PAGES = 10;
/** Discord text and announcement channels (the ones Om can be mentioned in). */
const DISCORD_TEXT_CHANNEL_TYPES = new Set([0, 5]);

/** A channel name as typed (`#Release-Train`), normalized (`release-train`), or null when it can't be one. */
export function channelName(input: string): string | null {
  const name = input.trim().replace(/^#/, "").toLowerCase();
  return /^[\p{Ll}\p{N}][\p{Ll}\p{N}._-]{0,99}$/u.test(name) ? name : null;
}

export type ChannelLookup =
  | { ok: true; /** The ID the platform shows. */ channel: string }
  | { ok: false; reason: "not_found" | "unavailable" };

export interface ChannelLookupDeps {
  db: Database;
  fetch?: typeof fetch;
  /** `ENCRYPTION_KEY` override for Slack credentials (tests). */
  encryptionKey?: string | Buffer;
  env?: NodeJS.ProcessEnv;
}

interface SlackConversationsList {
  ok: boolean;
  error?: string;
  channels?: { id: string; name: string }[];
  response_metadata?: { next_cursor?: string };
}

async function findSlackChannel(
  deps: ChannelLookupDeps,
  connection: ChatConnection,
  name: string,
): Promise<ChannelLookup> {
  const withCredentials = await getChatConnectionWithCredentials<SlackCredentials>(
    deps.db,
    "slack",
    connection.externalId,
    deps.encryptionKey,
  );
  const token = withCredentials?.id === connection.id && withCredentials.credentials?.botToken;
  if (!token) return { ok: false, reason: "unavailable" };
  const fetchImpl = deps.fetch ?? fetch;
  let cursor = "";
  for (let page = 0; page < SLACK_MAX_PAGES; page++) {
    const url = new URL(SLACK_CONVERSATIONS_LIST_URL);
    url.searchParams.set("types", "public_channel,private_channel");
    url.searchParams.set("exclude_archived", "true");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(CHANNEL_LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: "unavailable" };
    const body = (await response.json()) as SlackConversationsList;
    if (!body.ok) return { ok: false, reason: "unavailable" };
    const found = body.channels?.find((channel) => channel.name.toLowerCase() === name);
    if (found) return { ok: true, channel: found.id };
    cursor = body.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return { ok: false, reason: "not_found" };
}

async function findDiscordChannel(
  deps: ChannelLookupDeps,
  connection: ChatConnection,
  name: string,
): Promise<ChannelLookup> {
  const config = discordOAuthConfig(deps.env);
  if (!config) return { ok: false, reason: "unavailable" };
  const response = await (deps.fetch ?? fetch)(
    `${DISCORD_API_URL}/guilds/${encodeURIComponent(connection.externalId)}/channels`,
    {
      headers: { authorization: `Bot ${config.botToken}` },
      signal: AbortSignal.timeout(CHANNEL_LOOKUP_TIMEOUT_MS),
    },
  );
  if (!response.ok) return { ok: false, reason: "unavailable" };
  const channels = (await response.json()) as { id: string; name?: string; type: number }[];
  const found = channels.find(
    (channel) =>
      DISCORD_TEXT_CHANNEL_TYPES.has(channel.type) && channel.name?.toLowerCase() === name,
  );
  return found ? { ok: true, channel: found.id } : { ok: false, reason: "not_found" };
}

/** The ID of `connection`'s channel named `name` (normalized by `channelName`). */
export async function findChatChannel(
  deps: ChannelLookupDeps,
  connection: ChatConnection,
  name: string,
): Promise<ChannelLookup> {
  try {
    return connection.platform === "slack"
      ? await findSlackChannel(deps, connection, name)
      : await findDiscordChannel(deps, connection, name);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
}
