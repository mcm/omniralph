import "server-only";
import type { Database } from "@omniralph/db";
import { ACKNOWLEDGEMENT, startRun } from "@/lib/ralph/start";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { getLinearGateway } from "./client";
import type { LinearGateway } from "./gateway";
import type { LinearWebhookEvent } from "./webhook";

export type HandledLinearEvent = Exclude<LinearWebhookEvent, { kind: "ignored" }>;

export interface LinearEventContext {
  db: Database;
  /** The connected workspace the event came from. */
  organizationId: string;
}

/**
 * Posts what Linear needs before the webhook responds: a new agent session
 * must get an activity within 10 seconds, so it is acknowledged with a
 * thought right away. Failures are logged; the event is still handled.
 */
export async function acknowledgeLinearEvent(
  event: HandledLinearEvent,
  context: LinearEventContext,
  linear?: LinearGateway,
): Promise<void> {
  if (event.kind !== "session_created") return;
  try {
    const gateway = linear ?? (await getLinearGateway({ db: context.db }));
    await gateway.createActivity(
      event.sessionId,
      { type: "thought", body: ACKNOWLEDGEMENT },
      { ephemeral: true },
    );
  } catch (error) {
    console.error(`Acknowledging Linear agent session ${event.sessionId} failed`, error);
  }
}

/**
 * Acts on a verified, deduplicated Linear event after the webhook response:
 * a new agent session starts a ralph run. Replies and issue state changes are
 * accepted and dropped until the orchestrator handles them.
 */
export async function handleLinearEvent(
  event: HandledLinearEvent,
  context: LinearEventContext,
): Promise<void> {
  if (event.kind !== "session_created") return;
  const linear = await getLinearGateway({ db: context.db });
  await startRun(event, { db: context.db, linear, adapterFor: scmAdapterFor });
}
