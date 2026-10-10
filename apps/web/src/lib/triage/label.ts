/**
 * The `ralph:triage` label trigger: adding the label to an issue opens an
 * agent session on it (so triage reports there and replies reach it, as for
 * an `@omniralph /triage` mention) and starts triage in it. The label is
 * removed once triage is over, so adding it again triages again.
 */
import { randomUUID } from "node:crypto";
import {
  createTriageRun,
  getActiveTriageRun,
  getTriageRunBySession,
  setTriageRunSession,
  setTriageRunStatus,
  type Database,
  type TriageRun,
} from "@omniralph/db";
import type { LinearGateway } from "@/lib/linear/gateway";
import { isTriageLabel, TRIAGE_LABEL, type LinearWebhookEvent } from "@/lib/linear/webhook";
import { errorMessage, quietly } from "@/lib/ralph/notify";
import {
  startTriage,
  type SessionCreatedEvent,
  type StartTriageOutcome,
  type TriageDeps,
} from "./start";

export type TriageLabelEvent = Extract<LinearWebhookEvent, { kind: "triage_label_added" }>;

export type StartLabelTriageOutcome =
  /** The issue has a queued or running triage already: nothing else happens. */
  | { status: "already_running"; run: TriageRun }
  /** Linear wouldn't open an agent session on the issue. */
  | { status: "session_failed"; error: string }
  | { status: "started"; sessionId: string; outcome: StartTriageOutcome };

/**
 * The session a label run holds until Linear opens its real one: it marks the
 * issue as being triaged, so the session's own `created` webhook isn't taken
 * for a new ralph run (see `isOwnTriageSession`).
 */
const PENDING_SESSION_PREFIX = "pending-label:";

const isPending = (run: TriageRun) => run.linearAgentSessionId.startsWith(PENDING_SESSION_PREFIX);

/**
 * Whether a created agent session is triage's own, which ralph must not start
 * a run for: a session with a triage run, or one Linear opened for a label
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

/** Removes the `ralph:triage` label from the issue, if it has it. */
export async function removeTriageLabel(linear: LinearGateway, issueId: string): Promise<void> {
  const issue = await linear.getIssue(issueId);
  if (!issue.labels.some(isTriageLabel)) return;
  const label = await linear.findLabel(issue.teamId, TRIAGE_LABEL);
  if (label) await linear.removeIssueLabel(issue.id, label.id);
}

/** Removes the label, logging (not throwing) a failure. */
export const removeTriageLabelQuietly = (linear: LinearGateway, issueId: string) =>
  quietly(`Removing the ${TRIAGE_LABEL} label from ${issueId}`, () =>
    removeTriageLabel(linear, issueId),
  );

/** Handles an issue update that added the `ralph:triage` label. */
export async function startLabelTriage(
  event: TriageLabelEvent,
  deps: TriageDeps,
): Promise<StartLabelTriageOutcome> {
  const { db, linear, organizationId } = deps;

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
    sessionId = await linear.createAgentSessionOnIssue(event.issueId);
  } catch (error) {
    await setTriageRunStatus(db, run.id, "failed");
    console.error(`Opening an agent session on ${event.identifier ?? event.issueId} failed`, error);
    // Removing the label lets adding it again retry.
    await removeTriageLabelQuietly(linear, event.issueId);
    return { status: "session_failed", error: errorMessage(error) };
  }
  const withSession = (await setTriageRunSession(db, run.id, sessionId)) ?? {
    ...run,
    linearAgentSessionId: sessionId,
  };

  const outcome = await startTriage(
    {
      kind: "session_created",
      sessionId,
      issueId: event.issueId,
      issueIdentifier: event.identifier,
    },
    deps,
    { run: withSession },
  );
  // No job (in progress or done, or a failure): triage is over already.
  if (outcome.status !== "queued") await removeTriageLabelQuietly(linear, event.issueId);
  return { status: "started", sessionId, outcome };
}
