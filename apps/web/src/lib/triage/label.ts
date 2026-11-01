/**
 * The triage label trigger (`coding:triage`, or the older `ralph:triage`): adding the label to an issue opens an
 * agent session on it (so triage reports there and replies reach it, as for
 * an `@omniralph /triage` mention; on a tracker without sessions, triage
 * reports in the issue's comments) and starts triage in it. The label is
 * removed once triage is over, so adding it again triages again.
 */
import { randomUUID } from "node:crypto";
import {
  createTriageRun,
  getActiveTriageRun,
  getRunByIssue,
  getTriageRunBySession,
  setTriageRunSession,
  setTriageRunStatus,
  type Database,
  type TriageRun,
} from "@omniralph/db";
import {
  hasCapability,
  isTriageLabel,
  type TrackerGateway,
  type TriageRequestedEvent,
} from "@omniralph/tracker";
import { openIssueConversation } from "@/lib/tracker/sessions";
import { errorMessage, quietly } from "@/lib/ralph/notify";
import {
  startTriage,
  type SessionCreatedEvent,
  type StartTriageOutcome,
  type TriageDeps,
} from "./start";

export type TriageLabelEvent = TriageRequestedEvent;

export type StartLabelTriageOutcome =
  /** The issue has a queued or running triage already: nothing else happens. */
  | { status: "already_running"; run: TriageRun }
  /** The tracker wouldn't open an agent session on the issue. */
  | { status: "session_failed"; error: string }
  | { status: "started"; sessionId: string; outcome: StartTriageOutcome };

/**
 * The session a label run holds until the tracker opens its real one: it marks the
 * issue as being triaged, so the session's own `created` webhook isn't taken
 * for a new ralph run (see `isOwnTriageSession`).
 */
const PENDING_SESSION_PREFIX = "pending-label:";

const isPending = (run: TriageRun) => run.linearAgentSessionId.startsWith(PENDING_SESSION_PREFIX);

/**
 * Whether a created agent session is triage's own, which ralph must not start
 * a run for: a session with a triage run, or one the tracker opened for a label
 * run that hasn't recorded it yet.
 */
export async function isOwnTriageSession(
  db: Database,
  organizationId: string,
  event: Pick<SessionCreatedEvent, "sessionId" | "issueId">,
): Promise<boolean> {
  if (await getTriageRunBySession(db, event.sessionId)) return true;
  const active = await getActiveTriageRun(db, organizationId, event.issueId);
  return !!active && active.trigger === "label" && isPending(active);
}

/** Removes the triage labels from the issue, if it has any. */
export async function removeTriageLabel(tracker: TrackerGateway, issueId: string): Promise<void> {
  const issue = await tracker.getIssue(issueId);
  for (const name of issue.labels.filter(isTriageLabel)) {
    const label = await tracker.findLabel(issue.teamId, name);
    if (label) await tracker.removeIssueLabel(issue.id, label.id);
  }
}

/**
 * Once triage applied its PRD: when the issue is still delegated to Om (a delegation of a
 * work item that needed refining is triaged in that delegation's session, so Om stays its
 * delegate), the delegate is removed. Delegating the issue to Om again is then a change
 * the tracker acts on, which starts the run; while Om stays the delegate, it sends nothing
 * for it. Left alone while a coding run of the issue is active (it is that run's
 * delegation). Returns whether the delegate was removed; a failure is logged, not thrown.
 */
export async function releaseTriageDelegation(
  deps: Pick<TriageDeps, "db" | "organizationId" | "tracker">,
  issueId: string,
): Promise<boolean> {
  // Without delegation the tracker has no delegate to remove.
  if (!hasCapability(deps.tracker, "delegation")) return false;
  try {
    const [issue, viewer] = await Promise.all([
      deps.tracker.getIssue(issueId),
      deps.tracker.getViewer(),
    ]);
    if (!issue.delegateId || issue.delegateId !== viewer.id) return false;
    if (await getRunByIssue(deps.db, deps.organizationId, issue.id, { activeOnly: true })) {
      return false;
    }
    await deps.tracker.delegation.delegateIssue(issue.id, null);
    return true;
  } catch (error) {
    console.error(`Removing Om as the delegate of ${issueId} after triage failed`, error);
    return false;
  }
}

/** Removes the label, logging (not throwing) a failure. */
export const removeTriageLabelQuietly = (tracker: TrackerGateway, issueId: string) =>
  quietly(`Removing the triage label from ${issueId}`, () => removeTriageLabel(tracker, issueId));

/** Handles an issue update that added a triage label. */
export async function startLabelTriage(
  event: TriageLabelEvent,
  deps: TriageDeps,
): Promise<StartLabelTriageOutcome> {
  const { db, tracker, organizationId } = deps;

  // Claim the issue before opening the session: a concurrent label event (or
  // mention) finds this run, and the session's `created` webhook is ours.
  const { run, created } = await createTriageRun(db, {
    organizationId,
    linearIssueId: event.issueId,
    linearAgentSessionId: `${PENDING_SESSION_PREFIX}${randomUUID()}`,
    trigger: "label",
  });
  // The label is removed when that run ends.
  if (!created) return { status: "already_running", run };

  let sessionId: string;
  try {
    sessionId = await openIssueConversation(tracker, event.issueId);
  } catch (error) {
    await setTriageRunStatus(db, run.id, "failed");
    console.error(`Opening an agent session on ${event.identifier ?? event.issueId} failed`, error);
    // Removing the label lets adding it again retry.
    await removeTriageLabelQuietly(tracker, event.issueId);
    return { status: "session_failed", error: errorMessage(error) };
  }
  const withSession = (await setTriageRunSession(db, run.id, sessionId)) ?? {
    ...run,
    linearAgentSessionId: sessionId,
  };

  const outcome = await startTriage(
    {
      kind: "issue_delegated",
      sessionId,
      issueId: event.issueId,
      issueIdentifier: event.identifier,
    },
    deps,
    { run: withSession },
  );
  // No job (in progress or done, or a failure): triage is over already.
  if (outcome.status !== "queued") await removeTriageLabelQuietly(tracker, event.issueId);
  return { status: "started", sessionId, outcome };
}
