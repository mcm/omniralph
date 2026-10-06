import "server-only";
import type { Database } from "@omniralph/db";
import { getDispatcher } from "@/lib/dispatch";
import { wakeRunsForIssue } from "@/lib/ralph/reconcile";
import { handleReply } from "@/lib/ralph/reply";
import type { RalphDeps } from "@/lib/ralph/run";
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
 * How long the acknowledgement waits for a token refresh before using the
 * current (still valid) token; the webhook also caps the whole
 * acknowledgement (`ACKNOWLEDGE_TIMEOUT_MS` in `ingest.ts`).
 */
export const ACKNOWLEDGE_REFRESH_TIMEOUT_MS = 2_000;

/**
 * Posts what Linear needs before the webhook responds: a new agent session
 * must get an activity within 10 seconds, so it is acknowledged with a
 * thought right away (without waiting long for a token refresh). Failures
 * are logged; the event is still handled.
 */
export async function acknowledgeLinearEvent(
  event: HandledLinearEvent,
  context: LinearEventContext,
  linear?: LinearGateway,
): Promise<void> {
  if (event.kind !== "session_created") return;
  try {
    const gateway =
      linear ??
      (await getLinearGateway({
        db: context.db,
        refreshTimeoutMs: ACKNOWLEDGE_REFRESH_TIMEOUT_MS,
      }));
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
 * a new agent session starts a ralph run; an issue's state change (or
 * removal) advances the runs waiting on it or building it; a reply in an agent
 * session is the run's guidance.
 */
export async function handleLinearEvent(
  event: HandledLinearEvent,
  context: LinearEventContext,
  deps: Partial<Omit<RalphDeps, "db">> = {},
): Promise<void> {
  const db = context.db;
  const linear = deps.linear ?? (await getLinearGateway({ db }));
  const ralph: RalphDeps = {
    db,
    linear,
    dispatcher: deps.dispatcher ?? getDispatcher(),
    adapterFor: deps.adapterFor ?? scmAdapterFor,
  };
  if (event.kind === "session_created") await startRun(event, ralph);
  else if (event.kind === "session_prompted") await handleReply(event, ralph);
  else await wakeRunsForIssue(event.issueId, ralph);
}
