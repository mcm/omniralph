import "server-only";
import {
  ACTIVE_RALPH_RUN_STATUSES,
  ACTIVE_TRIAGE_RUN_STATUSES,
  getIntegrationById,
  getRepositoryWithConnection,
  getRunBySession,
  getTriageRunBySession,
  type Database,
  type ScmConnection,
  type WebhookEventDetail,
} from "@omniralph/db";
import type { ScmAdapter } from "@omniralph/scm";
import { ApiRouteError } from "@/lib/api/handler";
import type { JobDispatcher } from "@/lib/dispatch";
import { getTrackerGateway } from "@/lib/tracker/client";
import { trackerAdapter } from "@/lib/tracker/adapters";
import { openIssueConversation } from "@/lib/tracker/sessions";
import {
  acknowledgeTrackerEvent,
  handleTrackerEvent,
  type HandledTrackerEvent,
} from "@/lib/tracker/events";
import type { TrackerEvent, TrackerGateway, TrackerProvider } from "@omniralph/tracker";
import { hitRateLimit } from "@/lib/rate-limit";
import { replayWebhookDelivery } from "@/lib/webhooks/ingest";

/** Replays a user may start per minute. */
export const DELIVERY_REPLAY_LIMIT = 10;

export const REPLAY_TRUNCATED_MESSAGE =
  "This delivery was too large to keep, so it can't be replayed.";
export const REPLAY_CONNECTION_REMOVED_MESSAGE =
  "The connection this delivery came through was removed, so it can't be replayed.";

export interface ReplayDeps {
  db: Database;
  dispatcher: JobDispatcher;
  adapterFor?: (db: Database, connection: ScmConnection) => ScmAdapter;
  /** The organization's tracker (default: the connected one). */
  linear?: (organizationId: string) => Promise<TrackerGateway>;
}

/** 429 past `DELIVERY_REPLAY_LIMIT` replays in a minute. */
export async function hitReplayLimit(db: Database, userId: string): Promise<void> {
  const limit = await hitRateLimit(db, {
    key: `webhook_replay:user:${userId}`,
    limit: DELIVERY_REPLAY_LIMIT,
    windowSeconds: 60,
  });
  if (limit.limited) {
    throw new ApiRouteError(
      429,
      `That's a lot of replays in a minute. Try again in ${limit.retryAfterSeconds} seconds.`,
      "rate_limited",
    );
  }
}

/**
 * Replays a stored delivery (the caller checked the user may) with today's settings,
 * through the same processing as a live delivery; returns the replay's delivery log ID.
 * 400 for a payload that wasn't kept or a connection or repo that is gone; a tracker
 * agent-session event whose run is still active is 409, one whose run finished opens a
 * new conversation on the issue and replays there.
 */
export async function replayDelivery(
  deps: ReplayDeps,
  event: WebhookEventDetail,
  replayedBy: string,
): Promise<string> {
  if (event.payloadTruncated || event.payload === null || typeof event.payload !== "object") {
    throw new ApiRouteError(400, REPLAY_TRUNCATED_MESSAGE, "payload_truncated");
  }
  const id =
    event.provider === "linear"
      ? await replayTracker(
          deps,
          event,
          event.provider,
          event.payload as Record<string, unknown>,
          replayedBy,
        )
      : await replayCodeHost(deps, event, event.provider, replayedBy);
  if (!id) throw new ApiRouteError(500, "The replay ran, but recording it failed.");
  return id;
}

const connectionRemoved = () =>
  new ApiRouteError(400, REPLAY_CONNECTION_REMOVED_MESSAGE, "connection_removed");

async function replayCodeHost(
  deps: ReplayDeps,
  event: WebhookEventDetail,
  provider: "github" | "gitlab",
  replayedBy: string,
): Promise<string | null> {
  const found = event.repository
    ? await getRepositoryWithConnection(deps.db, event.repository.id, event.organizationId)
    : null;
  // The repo was removed or disconnected, or now comes through another connection.
  if (!found || found.connection.id !== event.scmConnectionId || found.repository.disconnectedAt) {
    throw connectionRemoved();
  }
  const { db, dispatcher, adapterFor, linear } = deps;
  return replayWebhookDelivery(
    {
      db,
      dispatcher,
      ...(adapterFor && { adapterFor }),
      ...(linear && { linear: () => linear(event.organizationId) }),
    },
    {
      provider,
      repository: found.repository,
      connection: found.connection,
      event: event.event,
      deliveryId: event.deliveryId,
      body: event.payload,
      replayOfId: event.id,
      replayedBy,
    },
  );
}

async function replayTracker(
  deps: ReplayDeps,
  stored: WebhookEventDetail,
  provider: TrackerProvider,
  payload: Record<string, unknown>,
  replayedBy: string,
): Promise<string | null> {
  const { db } = deps;
  const integration = stored.integrationId
    ? await getIntegrationById(db, stored.integrationId)
    : null;
  if (!integration || integration.organizationId !== stored.organizationId) {
    throw connectionRemoved();
  }
  const organizationId = integration.organizationId;
  const adapter = trackerAdapter(provider);
  const loadGateway = () =>
    deps.linear ? deps.linear(organizationId) : getTrackerGateway({ db, organizationId, provider });
  let gateway: TrackerGateway | undefined;
  const withGateway = async () => (gateway ??= await loadGateway());
  let event: TrackerEvent = adapter.parseDelivery(payload);
  if (
    event.kind === "issue_delegated" ||
    event.kind === "issue_mentioned" ||
    event.kind === "session_prompted"
  ) {
    event =
      (await inNewSessionIfFinished(deps, organizationId, event, payload, withGateway)) ?? event;
  }
  return adapter.replayDelivery(
    {
      db,
      acknowledge: async (e: HandledTrackerEvent, context) =>
        acknowledgeTrackerEvent(e, context, await withGateway()),
      handle: async (e: HandledTrackerEvent, context) =>
        handleTrackerEvent(e, context, {
          linear: await withGateway(),
          dispatcher: deps.dispatcher,
        }),
    },
    {
      integration,
      payload,
      event,
      deliveryId: stored.deliveryId,
      replayOfId: stored.id,
      replayedBy,
    },
  );
}

type SessionEvent = Extract<
  HandledTrackerEvent,
  { kind: "issue_delegated" | "issue_mentioned" | "session_prompted" }
>;

/**
 * An agent-session event of a run: 409 while the run is active; once it finished, the
 * event moves to a new conversation on the issue (a reply becomes the new session's
 * request). An event that reached no run replays in its own session (null).
 */
async function inNewSessionIfFinished(
  deps: ReplayDeps,
  organizationId: string,
  event: SessionEvent,
  payload: Record<string, unknown>,
  gateway: () => Promise<TrackerGateway>,
): Promise<SessionEvent | null> {
  const ralph = await getRunBySession(deps.db, event.sessionId);
  const triage = ralph ? null : await getTriageRunBySession(deps.db, event.sessionId);
  const run =
    ralph?.organizationId === organizationId
      ? {
          active: (ACTIVE_RALPH_RUN_STATUSES as readonly string[]).includes(ralph.status),
          issueId: ralph.linearIssueId,
          identifier: ralph.linearIdentifier,
        }
      : triage?.organizationId === organizationId
        ? {
            active: (ACTIVE_TRIAGE_RUN_STATUSES as readonly string[]).includes(triage.status),
            issueId: triage.linearIssueId,
            identifier: null,
          }
        : null;
  if (!run) return null;
  if (run.active) {
    const identifier = run.identifier ?? payloadIdentifier(payload) ?? "this work item";
    throw new ApiRouteError(409, `Om is still working on ${identifier}.`, "run_active");
  }
  const issueId = event.issueId ?? run.issueId;
  if (!issueId) {
    throw new ApiRouteError(400, "This delivery has no work item to replay on.", "no_work_item");
  }
  let sessionId: string;
  try {
    sessionId = await openIssueConversation(await gateway(), issueId);
  } catch (error) {
    console.error(`Opening an agent session on ${issueId} to replay a delivery failed`, error);
    throw new ApiRouteError(
      502,
      "The tracker couldn't open a new agent session for the replay. Try again.",
      "tracker_failed",
    );
  }
  if (event.kind !== "session_prompted") return { ...event, sessionId };
  // The reply becomes the new session's request, as a mention's comment; an empty one
  // (a signal) a delegation.
  const fields = {
    sessionId,
    issueId,
    issueIdentifier: run.identifier ?? payloadIdentifier(payload),
    creatorName: event.authorName,
  };
  return event.body.trim()
    ? { kind: "issue_mentioned", ...fields, commentBody: event.body }
    : { kind: "issue_delegated", ...fields };
}

/** The issue's identifier in an agent-session payload (`agentSession.issue.identifier`). */
function payloadIdentifier(payload: Record<string, unknown>): string | undefined {
  const session = payload.agentSession;
  if (typeof session !== "object" || session === null) return undefined;
  const issue = (session as Record<string, unknown>).issue;
  if (typeof issue !== "object" || issue === null) return undefined;
  const identifier = (issue as Record<string, unknown>).identifier;
  return typeof identifier === "string" && identifier ? identifier : undefined;
}
