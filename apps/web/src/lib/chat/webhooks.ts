import "server-only";
import { timingSafeEqual } from "node:crypto";
import {
  deleteChatConnectionByExternalId,
  getChatConnectionByExternalId,
  type Database,
} from "@omniralph/db";
import { withSlackRequestScope, type ChatBot } from "./bot";

/**
 * `POST /api/webhooks/slack` and `POST /api/webhooks/discord`: the Chat SDK
 * adapters verify each request (Slack signing secret, Discord Ed25519 key or
 * the Gateway forwarder's bot token) and dispatch it to the bot's handlers.
 * Uninstall events, which Chat SDK doesn't handle, remove the connection
 * once the adapter has accepted the request.
 */

export interface ChatWebhookDeps {
  db: Database;
  bot: ChatBot;
  /** Keeps the handlers running after the response (the route passes Next.js `after`). */
  waitUntil: (task: Promise<unknown>) => void;
}

const notConfigured = () => Response.json({ error: "not_configured" }, { status: 503 });

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

interface SlackEnvelope {
  type?: string;
  team_id?: string;
  enterprise_id?: string;
  is_enterprise_install?: boolean;
  authorizations?: Array<{
    team_id?: string | null;
    enterprise_id?: string | null;
    is_enterprise_install?: boolean;
  }>;
  event?: { type?: string; tokens?: { bot?: string[] } };
}

/**
 * The workspace (team ID, or enterprise ID for an org-wide install) whose app
 * was uninstalled or bot token revoked by `payload`, or null.
 */
export function slackUninstalledId(payload: unknown): string | null {
  const envelope = payload as SlackEnvelope | null;
  if (envelope?.type !== "event_callback") return null;
  const event = envelope.event;
  const uninstalled =
    event?.type === "app_uninstalled" ||
    (event?.type === "tokens_revoked" && (event.tokens?.bot?.length ?? 0) > 0);
  if (!uninstalled) return null;
  const auth = envelope.authorizations?.[0];
  const isEnterpriseInstall = auth?.is_enterprise_install ?? envelope.is_enterprise_install;
  const id = isEnterpriseInstall
    ? (auth?.enterprise_id ?? envelope.enterprise_id)
    : (auth?.team_id ?? envelope.team_id);
  return id || null;
}

export async function handleSlackWebhook(req: Request, deps: ChatWebhookDeps): Promise<Response> {
  if (!deps.bot.adapters.slack) return notConfigured();
  const copy = req.clone();
  const res = await withSlackRequestScope(() =>
    deps.bot.chat.webhooks.slack!(req, { waitUntil: deps.waitUntil }),
  );
  // Only a request the adapter verified gets a 200.
  if (res.status === 200) {
    const externalId = slackUninstalledId(parseJson(await copy.text()));
    if (externalId) await deleteChatConnectionByExternalId(deps.db, "slack", externalId);
  }
  return res;
}

/**
 * The header a Gateway forwarder (the adapter's `startGatewayListener`) authenticates with.
 * Nothing runs a forwarder at the moment (the Gateway connection is to be redesigned).
 */
export const DISCORD_GATEWAY_TOKEN_HEADER = "x-discord-gateway-token";

interface ForwardedGatewayEvent {
  type?: string;
  data?: { id?: string; guild_id?: string; unavailable?: boolean };
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function handleDiscordWebhook(req: Request, deps: ChatWebhookDeps): Promise<Response> {
  const config = deps.bot.discord;
  if (!deps.bot.adapters.discord || !config) return notConfigured();
  const token = req.headers.get(DISCORD_GATEWAY_TOKEN_HEADER);
  // A forwarded Gateway event with the right token (anything else goes to the
  // adapter, which rejects it). Messages from servers no organization has
  // connected are dropped here: the adapter would otherwise open a Discord
  // thread for a mention before any handler runs.
  const event =
    token !== null && sameSecret(token, config.botToken)
      ? (parseJson(await req.clone().text()) as ForwardedGatewayEvent | null)
      : null;
  if (event?.type?.startsWith("GATEWAY_MESSAGE_")) {
    const guildId = event.data?.guild_id;
    const connection = guildId
      ? await getChatConnectionByExternalId(deps.db, "discord", guildId)
      : null;
    if (!connection) return Response.json({ ok: true, ignored: "not_connected" });
  }
  const res = await deps.bot.chat.webhooks.discord!(req, { waitUntil: deps.waitUntil });
  // The bot was removed from a server (not a server outage, which is `unavailable`).
  if (res.status === 200 && event?.type === "GATEWAY_GUILD_DELETE" && !event.data?.unavailable) {
    const guildId = event.data?.id;
    if (guildId) await deleteChatConnectionByExternalId(deps.db, "discord", guildId);
  }
  return res;
}
