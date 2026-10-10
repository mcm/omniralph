import "server-only";
import type { Database } from "@omniralph/db";
import { parseInstruction } from "@omniralph/ralph";
import { getDispatcher } from "@/lib/dispatch";
import { cleanupAfterIssueCompleted } from "@/lib/ralph/cleanup";
import { wakeRunsForIssue } from "@/lib/ralph/reconcile";
import { handleReply } from "@/lib/ralph/reply";
import type { RalphDeps } from "@/lib/ralph/run";
import { ACKNOWLEDGEMENT, startRun } from "@/lib/ralph/start";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { isOwnTriageSession, startLabelTriage } from "@/lib/triage/label";
import { handleTriageReply } from "@/lib/triage/reply";
import { startTriage } from "@/lib/triage/start";
import { getLinearGateway } from "./client";
import type { LinearGateway } from "./gateway";
import type { LinearWebhookEvent } from "./webhook";

export type HandledLinearEvent = Exclude<LinearWebhookEvent, { kind: "ignored" }>;

export interface LinearEventContext {
  db: Database;
  /** The organization that connected the workspace: the event only touches its runs and repositories. */
  organizationId: string;
  /** The Linear workspace the event came from. */
  workspaceId: string;
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
        organizationId: context.organizationId,
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
 * a new agent session starts a ralph run (or triage, when its instruction
 * contains `/triage`; the sessions triage opens itself are left alone); the
 * `ralph:triage` label added to an issue starts triage; an issue's state change (or
 * removal) advances the runs waiting on it or building it (and, when it is
 * completed, cleans up its runs' merged PRs/MRs), then starts triage when the
 * same update added the label; a reply in an agent
 * session is the run's guidance (or, in a triage session, an answer to triage's
 * open questions).
 */
export async function handleLinearEvent(
  event: HandledLinearEvent,
  context: LinearEventContext,
  deps: Partial<Omit<RalphDeps, "db" | "organizationId">> = {},
): Promise<void> {
  const { db, organizationId } = context;
  const linear = deps.linear ?? (await getLinearGateway({ db, organizationId }));
  const ralph: RalphDeps = {
    db,
    organizationId,
    linear,
    dispatcher: deps.dispatcher ?? getDispatcher(),
    adapterFor: deps.adapterFor ?? scmAdapterFor,
  };
  if (event.kind === "session_created") {
    if (parseInstruction(event.commentBody).wantsTriage) await startTriage(event, ralph);
    else if (!(await isOwnTriageSession(db, organizationId, event))) await startRun(event, ralph);
  } else if (event.kind === "session_prompted") {
    // Triage sessions' replies go to triage; every other session is ralph's.
    if (!(await handleTriageReply(event, ralph))) await handleReply(event, ralph);
  } else if (event.kind === "triage_label_added") await startLabelTriage(event, ralph);
  else {
    // Done: the issue's merged PRs/MRs are cleaned up (logged, never failing the delivery).
    if (event.stateType === "completed" && !event.removed) {
      await cleanupAfterIssueCompleted(ralph, event.issueId);
    }
    await wakeRunsForIssue(event.issueId, ralph);
    if (event.triageLabelId) {
      await startLabelTriage(
        {
          kind: "triage_label_added",
          issueId: event.issueId,
          identifier: event.identifier,
          labelId: event.triageLabelId,
        },
        ralph,
      );
    }
  }
}
