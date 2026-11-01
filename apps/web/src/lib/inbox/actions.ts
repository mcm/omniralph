import "server-only";
/**
 * `POST /api/ui/inbox/items/{key}`: what a person does with an Inbox item. The key is checked
 * by deriving it again in the user's organizations (whatever their own Done or Snooze): an
 * item that no longer derives was handled. Then:
 *
 * - Done on a manual story, and Skip: the story's work item goes to the done or canceled
 *   state through the work item tracker, and the run goes on (`finishManualStory`).
 * - Done on any other item, Snooze and Restore: the user's own state of the item
 *   (`inbox_item_states`), an `inbox_state` change on the user's channel only.
 * - Start anyway: the blocked epic ignores its outside blockers (`startEpicAnyway`).
 * - Resume and Retry: the run's retry (`retryRun`), or a system attempt's rerun (`rerunJob`).
 *
 * Every action is open to any member of the item's organization.
 */
import {
  clearInboxItemState,
  findInboxItem,
  getRunIndexEntry,
  setInboxItemState,
  type Database,
  type InboxCandidate,
} from "@omniralph/db";
import { ApiRouteError } from "@/lib/api/handler";
import {
  INBOX_SNOOZE_MAX_MS,
  INBOX_SNOOZE_MIN_MS,
  type InboxItemActionRequest,
  type InboxItemActionResult,
} from "@/lib/api/inbox";
import type { ScopedOrganization } from "@/lib/api/scope";
import { hasRole } from "@/lib/auth/roles";
import { getDispatcher } from "@/lib/dispatch";
import { rerunJob } from "@/lib/jobs/rerun";
import { getLinearGatewayOrDisconnected } from "@/lib/tracker/linear/client";
import { finishManualStory, startEpicAnyway } from "@/lib/ralph/person-actions";
import type { RalphDeps } from "@/lib/ralph/run";
import { retryRun } from "@/lib/runs/retry";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { inboxItemActions } from "./feed";

export const ITEM_HANDLED_MESSAGE = "This item was already handled.";

const ACTION_REFUSALS: Record<Exclude<InboxItemActionRequest["action"], "restore">, string> = {
  done: "This item can't be marked done.",
  skip: "Only a manual story can be skipped.",
  snooze: "This item can't be snoozed.",
  start_anyway: "Only an epic waiting on blockers can be started anyway.",
  resume: "Only a stopped run can be resumed.",
  retry: "This item can't be retried.",
};

export interface InboxActor {
  userId: string;
  /** The name notes in the run's conversation give. */
  name: string | undefined;
}

/**
 * Carries out `request` on the item `key` of one of `organizations` (the user's
 * memberships). 404 when the key derives no item there, 400 when the item doesn't offer
 * the action (or a snooze is out of range).
 */
export async function actOnInboxItem(
  db: Database,
  organizations: readonly ScopedOrganization[],
  actor: InboxActor,
  key: string,
  request: InboxItemActionRequest,
  now = new Date(),
): Promise<InboxItemActionResult> {
  const item = await findInboxItem(db, {
    organizationIds: organizations.map((o) => o.id),
    key,
    now,
  });
  const organization = item && organizations.find((o) => o.id === item.organizationId);
  if (!item || !organization) throw ApiRouteError.notFound(ITEM_HANDLED_MESSAGE);
  if (!hasRole(organization, "member")) throw ApiRouteError.notFound(ITEM_HANDLED_MESSAGE);
  const { action } = request;
  if (action !== "restore" && !inboxItemActions(item).includes(action)) {
    throw new ApiRouteError(400, ACTION_REFUSALS[action], "action_not_allowed");
  }
  const stateKey = { userId: actor.userId, organizationId: organization.id, key };
  const result = (fields: Partial<InboxItemActionResult> = {}): InboxItemActionResult => ({
    key,
    action,
    state: null,
    snoozedUntil: null,
    runId: null,
    warning: null,
    ...fields,
  });

  switch (action) {
    case "restore":
      await clearInboxItemState(db, stateKey);
      return result();
    case "snooze": {
      const until = snoozeUntil(request.until, now);
      await setInboxItemState(db, { ...stateKey, state: "snoozed", snoozedUntil: until });
      return result({ state: "snoozed", snoozedUntil: until.toISOString() });
    }
    case "done":
      if (item.facts.kind === "manual_story") return finishStory(db, item, actor, "done", result);
      await setInboxItemState(db, { ...stateKey, state: "done", snoozedUntil: null });
      return result({ state: "done" });
    case "skip":
      return finishStory(db, item, actor, "skip", result);
    case "start_anyway": {
      const run = runOf(item);
      const started = await startEpicAnyway(await ralphDeps(db, organization.id), run, actor.name);
      if (started.status === "gone") throw ApiRouteError.notFound(ITEM_HANDLED_MESSAGE);
      return result({ runId: run });
    }
    case "resume":
    case "retry": {
      if (item.facts.kind === "failed_system") {
        const rerun = await rerunJob(db, getDispatcher(), organization.id, item.facts.job.id);
        if (!rerun.ok) throw new ApiRouteError(400, rerun.error, "not_retryable");
        return result({ warning: rerun.warning ?? null });
      }
      const entry = await getRunIndexEntry(db, runOf(item));
      if (!entry) throw ApiRouteError.notFound(ITEM_HANDLED_MESSAGE);
      const detail = await retryRun(db, entry, organization, { kind: "run" }, actor);
      return result({ runId: detail.id, warning: detail.warning });
    }
  }
}

/** The run an item that acts on its run is about. */
function runOf(item: InboxCandidate): string {
  if (!item.run) throw ApiRouteError.notFound(ITEM_HANDLED_MESSAGE);
  return item.run.id;
}

/** When a snooze ends: required, 5 minutes to 30 days ahead. */
function snoozeUntil(until: string | undefined, now: Date): Date {
  const at = until ? new Date(until) : null;
  const ahead = at ? at.getTime() - now.getTime() : NaN;
  if (!at || !(ahead >= INBOX_SNOOZE_MIN_MS && ahead <= INBOX_SNOOZE_MAX_MS)) {
    throw new ApiRouteError(400, "Snooze for 5 minutes to 30 days.", "invalid_request", {
      until: "Snooze for 5 minutes to 30 days.",
    });
  }
  return at;
}

async function finishStory(
  db: Database,
  item: InboxCandidate,
  actor: InboxActor,
  outcome: "done" | "skip",
  result: (fields?: Partial<InboxItemActionResult>) => InboxItemActionResult,
): Promise<InboxItemActionResult> {
  if (item.facts.kind !== "manual_story") {
    throw new ApiRouteError(400, ACTION_REFUSALS.skip, "action_not_allowed");
  }
  const finished = await finishManualStory(
    await ralphDeps(db, item.organizationId),
    item.facts.story.id,
    outcome,
    actor.name,
  );
  if (finished.status === "gone") throw ApiRouteError.notFound(ITEM_HANDLED_MESSAGE);
  if (finished.status === "failed") {
    throw new ApiRouteError(502, finished.message, "tracker_failed");
  }
  return result({ runId: item.run?.id ?? null });
}

async function ralphDeps(db: Database, organizationId: string): Promise<RalphDeps> {
  return {
    db,
    organizationId,
    linear: await getLinearGatewayOrDisconnected({ db, organizationId }),
    dispatcher: getDispatcher(),
    adapterFor: scmAdapterFor,
  };
}
