import "server-only";
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
   * Runs the handler after the response is sent (the route passes Next.js
   * `after`). Defaults to running it before responding.
   */
  defer?: (task: () => Promise<void>) => void | Promise<void>;
  now?: () => number;
}

type Outcome =
  | { status: "accepted"; kind: HandledLinearEvent["kind"] }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

const reply = (outcome: Outcome) => Response.json(outcome);

/**
 * `POST /api/webhooks/linear`: verifies the signature and timestamp (401),
 * classifies the event, drops events from workspaces other than the
 * connected one, claims the delivery ID (a redelivery is a no-op) and hands
 * the event to `handle` via `defer`.
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

  const deliveryId = req.headers.get(DELIVERY_HEADER)?.trim() || null;
  const delivery = deliveryId ? { provider: "linear" as const, deliveryId } : null;
  try {
    if (delivery && !(await claimWebhookDelivery(db, delivery))) {
      return reply({ status: "duplicate" });
    }
  } catch (error) {
    console.error(`Linear webhook ${deliveryId} failed`, error);
    return Response.json({ error: "internal_error" }, { status: 500 });
  }

  const context: LinearEventContext = { db, organizationId: integration.externalId };
  const task = async () => {
    try {
      await deps.handle(event, context);
    } catch (error) {
      console.error(
        `Linear ${event.kind} webhook ${deliveryId ?? "(no delivery ID)"} failed`,
        error,
      );
      // Let a redelivery of the same event try again.
      if (delivery) await releaseWebhookDelivery(db, delivery).catch(() => undefined);
    }
  };
  const defer = deps.defer ?? ((run: () => Promise<void>) => run());
  await defer(task);
  return reply({ status: "accepted", kind: event.kind });
}
