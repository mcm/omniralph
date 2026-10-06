import "server-only";
import type { Database } from "@omniralph/db";
import type { LinearWebhookEvent } from "./webhook";

export type HandledLinearEvent = Exclude<LinearWebhookEvent, { kind: "ignored" }>;

export interface LinearEventContext {
  db: Database;
  /** The connected workspace the event came from. */
  organizationId: string;
}

/**
 * Acts on a verified, deduplicated Linear event (start a ralph run, handle a
 * reply, wake waiting runs). Runs after the webhook response. The ralph
 * orchestrator implements it; until then events are accepted and dropped.
 */
export async function handleLinearEvent(
  _event: HandledLinearEvent,
  _context: LinearEventContext,
): Promise<void> {}
