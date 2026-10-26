import "server-only";
import { getAblyConfig, type AblyConfig } from "./token";

type Env = Record<string, string | undefined>;

/** Ably's REST endpoint for publishing. */
export const ABLY_REST_URL = "https://rest.ably.io";

/** A wake publish that takes longer than this is abandoned (dispatch must not hang on Ably). */
const PUBLISH_TIMEOUT_MS = 5_000;

/** The `authorization` header of an Ably REST request, with the API key (basic auth). */
export function ablyAuthorization(config: AblyConfig): string {
  return `Basic ${Buffer.from(`${config.keyName}:${config.keySecret}`).toString("base64")}`;
}

/** Publishes wake messages (name `wake`, no data) that make agents claim at once. */
export interface WakePublisher {
  /** Publishes a wake to the channel; throws when it fails. */
  wake(channel: string): Promise<void>;
}

/** `WakePublisher` over Ably's REST API, authenticated with the API key. */
export class AblyRestWakePublisher implements WakePublisher {
  private readonly authorization: string;
  private readonly fetch: typeof fetch;

  constructor(config: AblyConfig, options: { fetch?: typeof fetch } = {}) {
    this.authorization = ablyAuthorization(config);
    this.fetch = options.fetch ?? fetch;
  }

  async wake(channel: string): Promise<void> {
    const response = await this.fetch(
      `${ABLY_REST_URL}/channels/${encodeURIComponent(channel)}/messages`,
      {
        method: "POST",
        headers: { authorization: this.authorization, "content-type": "application/json" },
        body: JSON.stringify({ name: "wake" }),
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Ably publish to ${channel} failed: ${response.status} ${detail}`.trim());
    }
  }
}

/** The control panel's wake publisher; null (no client) when Ably is off. */
export function getWakePublisher(env: Env = process.env): WakePublisher | null {
  const config = getAblyConfig(env);
  return config ? new AblyRestWakePublisher(config) : null;
}
