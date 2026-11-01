import "server-only";
import {
  ACTIVE_TRIAGE_RUN_STATUSES,
  getRunBySession,
  getTriageRunBySession,
  type Database,
  type TriageRun,
} from "@omniralph/db";
import { parseInstruction } from "@omniralph/ralph";
import { getDispatcher } from "@/lib/dispatch";
import { cleanupAfterIssueCompleted } from "@/lib/ralph/cleanup";
import { wakeRunsForIssue } from "@/lib/ralph/reconcile";
import { handleReply } from "@/lib/ralph/reply";
import type { RalphDeps } from "@/lib/ralph/run";
import { ACKNOWLEDGEMENT, isMention, startRun, type SessionCreatedEvent } from "@/lib/ralph/start";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { isOwnTriageSession, startLabelTriage } from "@/lib/triage/label";
import { handleTriageReply, type SessionPromptedEvent } from "@/lib/triage/reply";
import { postActivity } from "@/lib/ralph/notify";
import { trackerConversation } from "@/lib/ralph/conversation";
import { startTriage } from "@/lib/triage/start";
import { workItemTrackerFor } from "@/lib/work-items/get-tracker";
import type { WorkItem } from "@/lib/work-items/tracker";
import { getTrackerGateway } from "./client";
import {
  hasCapability,
  type HandledTrackerEvent,
  type IssueSummary,
  type TrackerGateway,
  type Viewer,
} from "@omniralph/tracker";

export type { HandledTrackerEvent } from "@omniralph/tracker";

export interface TrackerEventContext {
  db: Database;
  /** The organization that connected the workspace: the event only touches its runs and repositories. */
  organizationId: string;
  /** The tracker workspace the event came from. */
  workspaceId: string;
}

/**
 * How long the acknowledgement waits for a token refresh before using the
 * current (still valid) token; the webhook also caps the whole
 * acknowledgement (`ACKNOWLEDGE_TIMEOUT_MS` in `ingest.ts`).
 */
export const ACKNOWLEDGE_REFRESH_TIMEOUT_MS = 2_000;

/**
 * Posts what the tracker needs before the webhook responds: a new agent session
 * must get an activity within 10 seconds (Linear's limit; a tracker without
 * sessions needs none), so it is acknowledged
 * with a thought right away (without waiting long for a token refresh). Failures
 * are logged; the event is still handled.
 */
export async function acknowledgeTrackerEvent(
  event: HandledTrackerEvent,
  context: TrackerEventContext,
  tracker?: TrackerGateway,
): Promise<void> {
  if (event.kind !== "issue_delegated" && event.kind !== "issue_mentioned") return;
  try {
    const gateway =
      tracker ??
      (await getTrackerGateway({
        db: context.db,
        organizationId: context.organizationId,
        refreshTimeoutMs: ACKNOWLEDGE_REFRESH_TIMEOUT_MS,
      }));
    // Only a session waits for an acknowledgement; a comment thread doesn't.
    if (!hasCapability(gateway, "sessions")) return;
    await gateway.sessions.createActivity(
      event.sessionId,
      { type: "thought", body: ACKNOWLEDGEMENT },
      { ephemeral: true },
    );
  } catch (error) {
    console.error(`Acknowledging agent session ${event.sessionId} failed`, error);
  }
}

const isActiveTriage = (run: TriageRun) =>
  (ACTIVE_TRIAGE_RUN_STATUSES as readonly string[]).includes(run.status);

/** What a delegation into a finished triage session says when the item still needs refining. */
export function stillNeedsRefiningMessage(identifier: string): string {
  return `${identifier} still has open questions, so Om didn't start building it. Answer them here to triage it again, then delegate it to Om again.`;
}

/**
 * A new agent session: `/triage` always starts triage; a mention runs what it asks for
 * (`startRun`); a session that already has its run (a redelivery) goes to that run; a
 * delegation reads the work item's readiness first and triages an item that needs
 * refining (in the delegation's own session) instead of building it. When the work item
 * can't be read, the delegation starts a run as before. Triage's own sessions are left
 * alone while triage runs; a finished triage session the tracker opens again is a delegation
 * into it (the tracker reusing Om's existing session on the issue), which builds a ready item
 * there and says what is still open otherwise.
 */
async function startSession(event: SessionCreatedEvent, ralph: RalphDeps): Promise<void> {
  const { db, organizationId } = ralph;
  if (parseInstruction(event.commentBody).wantsTriage) {
    await startTriage(event, ralph);
    return;
  }
  const triage = await getTriageRunBySession(db, event.sessionId);
  if (triage ? isActiveTriage(triage) : await isOwnTriageSession(db, organizationId, event)) {
    return;
  }
  if (isMention(event) || (await getRunBySession(db, event.sessionId))) {
    await startRun(event, ralph);
    return;
  }
  let item: WorkItem;
  try {
    const tracker = await workItemTrackerFor({ db, organizationId, gateway: ralph.tracker });
    item = await tracker.get(event.issueId);
  } catch (error) {
    console.error(
      `Reading the readiness of ${event.issueIdentifier ?? event.issueId} failed; starting a run`,
      error,
    );
    await startRun(event, ralph);
    return;
  }
  if (item.readiness !== "needs_refining") {
    await startRun(event, ralph);
  } else if (triage) {
    await postActivity(trackerConversation(ralph.tracker, event.sessionId, event.issueId), {
      type: "response",
      body: stillNeedsRefiningMessage(item.identifier),
    });
  } else {
    await startTriage(event, ralph, { delegation: { identifier: item.identifier } });
  }
}

/**
 * A delegation the tracker sent as an empty prompt into a finished triage session (should it
 * reuse Om's existing session on the issue rather than open one): the session as a delegation's
 * `created` event, when the session has no run yet and the issue is delegated to Om now;
 * otherwise null (a reply, for triage or ralph).
 */
async function delegationIntoTriageSession(
  event: SessionPromptedEvent,
  ralph: RalphDeps,
): Promise<SessionCreatedEvent | null> {
  if (event.signal || event.body.trim()) return null;
  const triage = await getTriageRunBySession(ralph.db, event.sessionId);
  if (!triage || isActiveTriage(triage)) return null;
  if (await getRunBySession(ralph.db, event.sessionId)) return null;
  let issue: IssueSummary;
  let viewer: Viewer;
  try {
    [issue, viewer] = await Promise.all([
      ralph.tracker.getIssue(triage.trackerIssueId),
      ralph.tracker.getViewer(),
    ]);
  } catch (error) {
    console.error(`Checking whether ${triage.trackerIssueId} was delegated to Om failed`, error);
    return null;
  }
  if (!issue.delegateId || issue.delegateId !== viewer.id) return null;
  return {
    kind: "issue_delegated",
    sessionId: event.sessionId,
    issueId: issue.id,
    issueIdentifier: issue.identifier,
  };
}

/**
 * Acts on a verified, deduplicated tracker event after the webhook response:
 * a delegation or a mention (a new agent session) starts a ralph run or triage
 * (`startSession`); a triage request (the `coding:triage` label added to an issue) starts
 * triage; an issue's state change (or
 * removal) advances the runs waiting on it or building it (and, when it is
 * completed, cleans up its runs' merged PRs/MRs), then starts triage when the
 * same update added the label; a reply in an agent
 * session is the run's guidance (or, in a triage session, an answer to triage's
 * open questions).
 */
export async function handleTrackerEvent(
  event: HandledTrackerEvent,
  context: TrackerEventContext,
  deps: Partial<Omit<RalphDeps, "db" | "organizationId" | "tracker">> & {
    tracker?: TrackerGateway;
  } = {},
): Promise<void> {
  const { db, organizationId } = context;
  const tracker = deps.tracker ?? (await getTrackerGateway({ db, organizationId }));
  const ralph: RalphDeps = {
    db,
    organizationId,
    tracker,
    dispatcher: deps.dispatcher ?? getDispatcher(),
    adapterFor: deps.adapterFor ?? scmAdapterFor,
    ...(deps.chat && { chat: deps.chat }),
  };
  if (event.kind === "issue_delegated" || event.kind === "issue_mentioned") {
    await startSession(event, ralph);
  } else if (event.kind === "session_prompted") {
    const delegation = await delegationIntoTriageSession(event, ralph);
    if (delegation) await startSession(delegation, ralph);
    // Triage sessions' replies go to triage; every other session is ralph's.
    else if (!(await handleTriageReply(event, ralph))) await handleReply(event, ralph);
  } else if (event.kind === "triage_requested") await startLabelTriage(event, ralph);
  else {
    // Done: the issue's merged PRs/MRs are cleaned up (logged, never failing the delivery).
    if (event.stateType === "completed" && !event.removed) {
      await cleanupAfterIssueCompleted(ralph, event.issueId);
    }
    await wakeRunsForIssue(event.issueId, ralph);
    if (event.triageLabelId) {
      await startLabelTriage(
        {
          kind: "triage_requested",
          issueId: event.issueId,
          identifier: event.identifier,
          labelId: event.triageLabelId,
        },
        ralph,
      );
    }
  }
}
