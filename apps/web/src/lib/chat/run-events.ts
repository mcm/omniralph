/**
 * Run events: what a run started from chat has for its thread (an answer, a
 * question, an approval request, its end) is stored in `chat_run_events`
 * instead of posted, so the chat responder is the only one that speaks in the
 * thread and relays the run in context. Linear-delegated runs keep their
 * notices (`lib/ralph/chat-notify.ts`).
 */
import { after } from "next/server";
import {
  recordRunEvent,
  threadRunOf,
  type ChatRunEventKind,
  type ThreadRunRef,
} from "@omniralph/db";
import { markRunEventsPending } from "@/lib/chat/pending-run-events";
import type { ChatTarget } from "@/lib/ralph/conversation";
import { MAX_BODY_CHARS, sanitizeCapped } from "@/lib/review/sanitize";

export type { ChatRunEventKind };

/** An event's body: its text for the thread, and structured details of its kind. */
export type ChatRunEventBody = { text: string } & Record<string, unknown>;

export interface ChatRunEventInput {
  organizationId: string;
  run: ThreadRunRef;
  kind: ChatRunEventKind;
  body: ChatRunEventBody;
  /** Identifies the event within its run (e.g. `response`, `permission:<requestId>`). */
  key: string;
}

/** The idempotency key of a run's event. */
export function runEventKey(run: ThreadRunRef, key: string): string {
  const ref = "jobId" in run ? `job:${run.jobId}` : `ralph:${run.ralphRunId}`;
  return `chat-run-event:${ref}:${key}`;
}

/** Every string in `value` sanitized for the thread (links only to `allowedHosts`). */
function sanitizeValue(value: unknown, allowedHosts: readonly string[]): unknown {
  if (typeof value === "string") return sanitizeCapped(value, { allowedHosts }, MAX_BODY_CHARS);
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, allowedHosts));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sanitizeValue(v, allowedHosts)]),
    );
  }
  return value;
}

/** An event body sanitized with the thread's `allowedHosts` (`loadChatTarget`). */
export function sanitizeRunEventBody(
  body: ChatRunEventBody,
  allowedHosts: readonly string[],
): ChatRunEventBody {
  return sanitizeValue(body, allowedHosts) as ChatRunEventBody;
}

/**
 * Wakes the chat responder for a thread once the current request has
 * responded (`after()`), so it relays the thread's new run events. Outside a
 * request (a script, a test) nothing is scheduled: the
 * `/api/cron/chat-run-events` cron picks the events up.
 */
export function scheduleThreadWake(chatThreadId: string): void {
  try {
    after(async () => {
      const { defaultWakeDeps, processThreadRunEvents } = await import("./agent/wake");
      try {
        await processThreadRunEvents(await defaultWakeDeps(), chatThreadId);
      } catch (error) {
        console.error(`Waking the chat responder for thread ${chatThreadId} failed`, error);
      }
    });
  } catch {
    // Not in a request: the cron catches up.
  }
}

/**
 * Records an event of a run mapped to `target`'s thread, sanitized for it,
 * once per run and `key`, and wakes the responder for the thread
 * (`scheduleThreadWake`), marking it pending for the cron
 * (`markRunEventsPending`). False when nothing was recorded: already recorded,
 * or the run isn't mapped to a thread of the organization (logged).
 */
export async function recordChatRunEvent(
  target: ChatTarget,
  input: ChatRunEventInput,
): Promise<boolean> {
  const { db } = target.channel;
  const threadRun = await threadRunOf(db, input.organizationId, input.run);
  if (!threadRun || threadRun.chatThreadId !== target.thread.id) {
    console.warn(
      `Skipping a ${input.kind} event of ${runEventKey(input.run, input.key)}: the run isn't mapped to thread ${target.thread.id}`,
    );
    return false;
  }
  const { created } = await recordRunEvent(db, {
    organizationId: input.organizationId,
    threadRun,
    kind: input.kind,
    body: sanitizeRunEventBody(input.body, target.allowedHosts),
    idempotencyKey: runEventKey(input.run, input.key),
  });
  if (created) {
    // For the cron, in case the wake-up misses it.
    await markRunEventsPending();
    scheduleThreadWake(target.thread.id);
  }
  return created;
}
