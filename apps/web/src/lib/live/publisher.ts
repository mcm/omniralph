import "server-only";
import type { RecordedChange } from "@omniralph/db/changes";
import { ablyAuthorization, ABLY_REST_URL } from "@/lib/ably/publisher";
import { getAblyConfig, type AblyConfig } from "@/lib/ably/token";
import {
  CHANGE_EVENT_NAME,
  CHANGE_EVENT_VERSION,
  changeEventSchema,
  orgChangesChannel,
  userChangesChannel,
  type ChangeEvent,
} from "./events";

type Env = Record<string, string | undefined>;

/** A change publish that takes longer than this is abandoned (it runs after the response). */
export const CHANGE_PUBLISH_TIMEOUT_MS = 2_000;

/** A change event and the channel it goes on. */
export interface ChangeMessage {
  channel: string;
  event: ChangeEvent;
}

/** Publishes change events; throws when the publish fails. */
export interface ChangePublisher {
  publish(messages: readonly ChangeMessage[]): Promise<void>;
}

/**
 * The message for a recorded change: per-user state on the user's channel, everything
 * else on the organization's. Validated against the catalogue, so nothing but IDs leaves.
 */
export function changeMessage(change: RecordedChange): ChangeMessage {
  const event = changeEventSchema.parse({
    v: CHANGE_EVENT_VERSION,
    resource: change.resource,
    ids: change.ids,
    organizationId: change.organizationId,
    at: change.at.toISOString(),
    ...(change.runId ? { runId: change.runId } : {}),
    ...(change.section ? { section: change.section } : {}),
    ...(change.subjectId ? { subjectId: change.subjectId } : {}),
  });
  return {
    channel: change.userId
      ? userChangesChannel(change.userId)
      : orgChangesChannel(change.organizationId),
    event,
  };
}

/**
 * `ChangePublisher` over Ably's REST batch publish (`POST /messages`): one request for
 * every channel, each message `CHANGE_EVENT_NAME` with its event as JSON data.
 */
export class AblyRestChangePublisher implements ChangePublisher {
  private readonly authorization: string;
  private readonly fetch: typeof fetch;

  constructor(config: AblyConfig, options: { fetch?: typeof fetch } = {}) {
    this.authorization = ablyAuthorization(config);
    this.fetch = options.fetch ?? fetch;
  }

  async publish(messages: readonly ChangeMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const byChannel = new Map<string, ChangeEvent[]>();
    for (const { channel, event } of messages) {
      byChannel.set(channel, [...(byChannel.get(channel) ?? []), event]);
    }
    const body = [...byChannel].map(([channel, events]) => ({
      channels: [channel],
      messages: events.map((event) => ({
        name: CHANGE_EVENT_NAME,
        data: JSON.stringify(event),
        encoding: "json",
      })),
    }));
    const response = await this.fetch(`${ABLY_REST_URL}/messages`, {
      method: "POST",
      headers: { authorization: this.authorization, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CHANGE_PUBLISH_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Ably batch publish failed: ${response.status} ${detail}`.trim());
    }
  }
}

/** The control panel's change publisher; null when Ably is off (`ABLY_API_KEY` unset). */
export function getChangePublisher(env: Env = process.env): ChangePublisher | null {
  const config = getAblyConfig(env);
  return config ? new AblyRestChangePublisher(config) : null;
}
