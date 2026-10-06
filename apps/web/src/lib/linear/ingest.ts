import "server-only";
import { createHash } from "node:crypto";
import {
  claimWebhookDelivery,
  getIntegration,
  releaseWebhookDelivery,
  type Database,
} from "@omniralph/db";
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
 * classifies the event, drops events from workspaces other than the
 * connected one, claims the delivery ID (or body hash without one; a
 * redelivery is a no-op), runs `acknowledge` (within
 * `ACKNOWLEDGE_TIMEOUT_MS`) and hands the event to `handle` via `defer`.
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
  if (event.kind === "ignored") return reply({ status: "ignored", reason: event.reason });

  const organizationId = typeof payload.organizationId === "string" ? payload.organizationId : null;
  const integration = await getIntegration(db, "linear");
  if (!integration || integration.externalId !== organizationId) {
    return reply({ status: "ignored", reason: "unknown_workspace" });
  }

  const deliveryId = linearDeliveryKey(req.headers.get(DELIVERY_HEADER), rawBody);
  const delivery = { provider: "linear" as const, deliveryId };
  try {
    if (!(await claimWebhookDelivery(db, delivery))) {
      return reply({ status: "duplicate" });
    }
  } catch (error) {
    console.error(`Linear webhook ${deliveryId} failed`, error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }

  const context: LinearEventContext = { db, organizationId: integration.externalId };
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
    }
  };
  const defer = deps.defer ?? ((run: () => Promise<void>) => run());
  await defer(task);
  return reply({ status: "accepted", kind: event.kind });
}
