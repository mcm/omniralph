import "server-only";
import { createHash } from "node:crypto";
import {
  claimWebhookDelivery,
  getActiveTriageRun,
  getIntegrationByExternalId,
  getRunBySession,
  getTriageRunBySession,
  releaseWebhookDelivery,
  type Database,
} from "@omniralph/db";
import { DeliveryLog, type DeliveryResult } from "@/lib/webhooks/delivery-log";
import type { HandledLinearEvent, LinearEventContext } from "./events";
import { classifyWebhook, DELIVERY_HEADER, SIGNATURE_HEADER, verifyWebhook } from "./webhook";

export interface LinearWebhookDeps {
  db: Database;
  /** `LINEAR_WEBHOOK_SECRET`; deliveries are rejected when it's unset. */
  secret: string | undefined;
  handle: (event: HandledLinearEvent, context: LinearEventContext) => Promise<void>;
  /**
   * Runs before the response (after the delivery is claimed), e.g. the
   * acknowledgement Linear needs within 10 seconds of a new agent session.
   */
  acknowledge?: (event: HandledLinearEvent, context: LinearEventContext) => Promise<void>;
  /**
   * Runs the handler after the response is sent (the route passes Next.js
   * `after`). Defaults to running it before responding.
   */
  defer?: (task: () => Promise<void>) => void | Promise<void>;
  /** Overrides `ACKNOWLEDGE_TIMEOUT_MS` (tests). */
  acknowledgeTimeoutMs?: number;
  now?: () => number;
}

/**
 * The longest the response waits for `acknowledge`, well inside Linear's
 * 10 seconds: past it the webhook responds and the acknowledgement finishes
 * (or fails) on its own.
 */
export const ACKNOWLEDGE_TIMEOUT_MS = 6_000;

/**
 * The delivery's dedupe key: Linear's delivery ID, or a hash of the signed
 * body for a delivery without one (the body carries `webhookTimestamp`, so
 * only a replay of the same delivery matches).
 */
export function linearDeliveryKey(deliveryId: string | null | undefined, rawBody: string): string {
  const id = deliveryId?.trim();
  if (id) return id;
  return `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
}

type Outcome =
  | { status: "accepted"; kind: HandledLinearEvent["kind"] }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

const reply = (outcome: Outcome) => Response.json(outcome);

/**
 * `POST /api/webhooks/linear`: verifies the signature and timestamp (401),
 * classifies the event and finds the organization that connected its workspace
 * (events from other workspaces are dropped without a trace), records it in the
 * delivery log (`webhook_events`) and hands it to `processVerifiedLinearDelivery`.
 */
export async function handleLinearWebhook(
  req: Request,
  deps: LinearWebhookDeps,
): Promise<Response> {
  const { db, secret } = deps;
  if (!secret) return Response.json({ error: "not_configured" }, { status: 503 });
  const rawBody = await req.text();
  const verified = verifyWebhook(
    rawBody,
    req.headers.get(SIGNATURE_HEADER),
    secret,
    (deps.now ?? Date.now)(),
  );
  if (!verified.ok) {
    const status = verified.reason === "invalid_json" ? 400 : 401;
    return Response.json({ error: verified.reason }, { status });
  }
  const { payload } = verified;

  const event = classifyWebhook(payload);
  // Linear's `organizationId` is the workspace, which belongs to one of our organizations.
  const workspaceId = typeof payload.organizationId === "string" ? payload.organizationId : null;
  let integration: Awaited<ReturnType<typeof getIntegrationByExternalId>> = null;
  try {
    integration = workspaceId ? await getIntegrationByExternalId(db, "linear", workspaceId) : null;
  } catch (error) {
    // An ignored event never needed its workspace: it's still ignored.
    if (event.kind !== "ignored") throw error;
    console.error("Looking up the workspace of an ignored Linear webhook failed", error);
  }
  const deliveryId = linearDeliveryKey(req.headers.get(DELIVERY_HEADER), rawBody);
  const log =
    integration &&
    new DeliveryLog(db, {
      organizationId: integration.organizationId,
      provider: "linear",
      source: { integrationId: integration.id },
      deliveryId,
      event: linearEventName(payload),
      rawBody,
    });
  if (event.kind === "ignored") {
    await log?.record({ outcome: "ignored", reasonCode: event.code });
    return reply({ status: "ignored", reason: event.reason });
  }
  if (!integration || !log) return reply({ status: "ignored", reason: "unknown_workspace" });
  return processVerifiedLinearDelivery(deps, { event, integration, deliveryId, log });
}

/** The delivery's event as the log names it: its type and action (`AgentSessionEvent.created`). */
export function linearEventName(payload: Record<string, unknown>): string {
  const type = typeof payload.type === "string" && payload.type ? payload.type : "unknown";
  return typeof payload.action === "string" && payload.action ? `${type}.${payload.action}` : type;
}

/**
 * A verified, classified Linear event of a connected workspace: claims the delivery (a
 * redelivery is a no-op), runs `acknowledge` (within `ACKNOWLEDGE_TIMEOUT_MS`) and hands
 * the event to `handle` via `defer`. The delivery log gets the run the handler started or
 * reached, or its failure, once the handler is done.
 */
export async function processVerifiedLinearDelivery(
  deps: LinearWebhookDeps,
  input: {
    event: HandledLinearEvent;
    integration: { organizationId: string; externalId: string };
    deliveryId: string;
    log: DeliveryLog;
  },
): Promise<Response> {
  const { db } = deps;
  const { event, integration, deliveryId, log } = input;
  const delivery = { provider: "linear" as const, deliveryId };
  try {
    if (!(await claimWebhookDelivery(db, delivery))) {
      await log.record({ outcome: "duplicate" });
      return reply({ status: "duplicate" });
    }
  } catch (error) {
    console.error(`Linear webhook ${deliveryId} failed`, error);
    await log.record({ outcome: "failed", error });
    return Response.json({ error: "internal_error" }, { status: 500 });
  }

  const context: LinearEventContext = {
    db,
    organizationId: integration.organizationId,
    workspaceId: integration.externalId,
  };
  let acknowledging: Promise<void> | undefined;
  if (deps.acknowledge) {
    acknowledging = deps.acknowledge(event, context).catch((error: unknown) => {
      console.error(`Acknowledging Linear ${event.kind} webhook failed`, error);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      acknowledging.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(
          () => resolve(true),
          deps.acknowledgeTimeoutMs ?? ACKNOWLEDGE_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (timedOut) {
      console.error(`Acknowledging Linear ${event.kind} webhook timed out; responding anyway`);
    }
  }
  const task = async () => {
    try {
      // A slow acknowledgement still lands before the handler's own activities.
      await acknowledging;
      await deps.handle(event, context);
    } catch (error) {
      console.error(`Linear ${event.kind} webhook ${deliveryId} failed`, error);
      // Let a redelivery of the same event try again.
      await releaseWebhookDelivery(db, delivery).catch(() => undefined);
      await log.settle({ outcome: "failed", error });
      return;
    }
    await log.settle(
      await linearEventResult(db, integration.organizationId, event).catch((error: unknown) => {
        console.error(`Finding the run of Linear webhook ${deliveryId} failed`, error);
        return initialResult(event);
      }),
    );
  };
  // Until the handler is done: what the event is meant to do.
  await log.record(initialResult(event));
  const defer = deps.defer ?? ((run: () => Promise<void>) => run());
  await defer(task);
  return reply({ status: "accepted", kind: event.kind });
}

function initialResult(event: HandledLinearEvent): DeliveryResult {
  return {
    outcome:
      event.kind === "session_created" || event.kind === "triage_label_added"
        ? "started_run"
        : "updated_run",
  };
}

/**
 * What a handled event did: the run of its agent session (a ralph or triage run), or the
 * triage run a triage label started. An agent session event that reached no run did
 * nothing; an issue's state change (which may wake several runs) links none.
 */
async function linearEventResult(
  db: Database,
  organizationId: string,
  event: HandledLinearEvent,
): Promise<DeliveryResult> {
  const outcome = initialResult(event).outcome as "started_run" | "updated_run";
  if (event.kind === "session_created" || event.kind === "session_prompted") {
    const ralph = await getRunBySession(db, event.sessionId);
    if (ralph?.organizationId === organizationId) {
      return { outcome, run: { id: ralph.id, kind: ralph.mode } };
    }
    const triage = await getTriageRunBySession(db, event.sessionId);
    if (triage?.organizationId === organizationId) {
      return { outcome, run: { id: triage.id, kind: "triage" } };
    }
    return { outcome: "ignored", reasonCode: "no_run" };
  }
  if (event.kind === "triage_label_added") {
    const triage = await getActiveTriageRun(db, organizationId, event.issueId);
    return triage ? { outcome, run: { id: triage.id, kind: "triage" } } : { outcome };
  }
  return { outcome };
}
