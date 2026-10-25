import "server-only";
import {
  recordWebhookEvent,
  updateWebhookEventOutcome,
  type Database,
  type NewWebhookEvent,
  type WebhookEventOutcomeUpdate,
  type WebhookEventRun,
  type WebhookProvider,
} from "@omniralph/db";
import {
  describeIgnoreReason,
  failureReason,
  HANDLER_FAILED,
  type WebhookIgnoreReason,
} from "./reasons";

/** What a delivery did, as the log records it. */
export type DeliveryResult =
  | { outcome: "started_run" | "updated_run"; run?: WebhookEventRun | null }
  | { outcome: "duplicate"; run?: WebhookEventRun | null }
  | { outcome: "ignored"; reasonCode: WebhookIgnoreReason; run?: WebhookEventRun | null }
  | { outcome: "failed"; error: unknown };

/** The log's columns for a result (an ignore reason in plain language, a failure's message). */
export function deliveryOutcome(
  provider: WebhookProvider,
  result: DeliveryResult,
): WebhookEventOutcomeUpdate {
  switch (result.outcome) {
    case "ignored":
      return {
        outcome: "ignored",
        reasonCode: result.reasonCode,
        reason: describeIgnoreReason(result.reasonCode, provider),
        run: result.run ?? null,
      };
    case "failed":
      return {
        outcome: "failed",
        reasonCode: HANDLER_FAILED,
        reason: failureReason(result.error),
        run: null,
      };
    default:
      return { outcome: result.outcome, run: result.run ?? null };
  }
}

/**
 * One verified delivery's log row. The response's result is `record`ed once; work that
 * finishes later (deferred handlers) `settle`s the outcome, before or after the row is
 * written: a deferred task that runs before the response (no `defer`) changes the row
 * it will write, one that runs after it updates the row. Logging never fails or changes
 * the delivery: errors are logged.
 */
export class DeliveryLog {
  private written: Promise<string | null> | null = null;
  private settled: WebhookEventOutcomeUpdate | null = null;

  constructor(
    private readonly db: Database,
    private readonly base: Omit<NewWebhookEvent, keyof WebhookEventOutcomeUpdate>,
  ) {}

  /** Writes the row with the response's result (or what a finished deferred task settled). */
  async record(result: DeliveryResult): Promise<void> {
    if (this.written) return;
    const outcome = this.settled ?? deliveryOutcome(this.base.provider, result);
    this.written = recordWebhookEvent(this.db, { ...this.base, ...outcome }).catch(
      (error: unknown) => {
        console.error(`Recording ${this.describe()} failed`, error);
        return null;
      },
    );
    await this.written;
  }

  /** The written row's ID: null before `record`, or when writing it failed. */
  async id(): Promise<string | null> {
    return this.written ? await this.written : null;
  }

  /** Sets the outcome once deferred work has finished. */
  async settle(result: DeliveryResult): Promise<void> {
    const outcome = deliveryOutcome(this.base.provider, result);
    if (!this.written) {
      this.settled = outcome;
      return;
    }
    const id = await this.written;
    if (!id) return;
    await updateWebhookEventOutcome(this.db, id, outcome).catch((error: unknown) => {
      console.error(`Updating ${this.describe()} failed`, error);
    });
  }

  private describe(): string {
    return `${this.base.provider} webhook ${this.base.deliveryId ?? "(no delivery ID)"} (${this.base.event})`;
  }
}
