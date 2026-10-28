import "server-only";
/**
 * An epic's or request's Session (`GET /api/ui/runs/{id}/session`): its query and cursor,
 * and the view of what `getRunSession` read.
 */
import {
  getRunSession,
  loadRunListEntries,
  type Database,
  type RunIndexEntry,
  type RunSessionCursor,
  type RunSessionMessage,
} from "@omniralph/db";
import { z } from "zod";
import type { RunMessageState, RunSession } from "@/lib/api/runs";
import type { ScopedOrganization } from "@/lib/api/scope";
import { describeAttempt } from "@omniralph/shared";
import { attemptLabelBase, storyIssueUrl } from "./detail";
import { runRow } from "./list";

/** `{at, id}` of the last message of a page, as an opaque base64url string. */
export function encodeSessionCursor(cursor: RunSessionCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id])).toString("base64url");
}

const cursorShape = z.tuple([z.iso.datetime(), z.uuid()]);

/** The cursor `encodeSessionCursor` wrote, or null when `value` isn't one. */
export function decodeSessionCursor(value: string): RunSessionCursor | null {
  try {
    const parsed = cursorShape.safeParse(JSON.parse(Buffer.from(value, "base64url").toString()));
    return parsed.success ? { at: parsed.data[0], id: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

export const sessionQuerySchema = z.object({
  cursor: z
    .string()
    .transform((value, ctx) => {
      const cursor = decodeSessionCursor(value);
      if (!cursor) ctx.addIssue({ code: "custom", message: "The cursor is invalid." });
      return cursor ?? z.NEVER;
    })
    .optional(),
});

/** Where a message is, from its timestamps and its attempt's status. */
export function messageState(
  message: Pick<RunSessionMessage, "kind" | "deliveredAt" | "consumedAt"> & {
    attempt: Pick<RunSessionMessage["attempt"], "status">;
  },
): RunMessageState {
  if (message.deliveredAt) return "delivered";
  if (message.consumedAt) return message.kind === "guidance" ? "guidance" : "undelivered";
  return message.attempt.status === "queued" || message.attempt.status === "running"
    ? "waiting"
    : "undelivered";
}

/**
 * The Session of the epic or request `run` for a user of `organization`: the page of
 * messages after `cursor` (the first without one), each with its attempt's label. Null
 * when the run is gone.
 */
export async function loadRunSession(
  db: Database,
  run: RunIndexEntry,
  organization: ScopedOrganization,
  cursor?: RunSessionCursor | null,
): Promise<RunSession | null> {
  const [[entry], session] = await Promise.all([
    loadRunListEntries(db, [run]),
    getRunSession(db, run.id, { cursor }),
  ]);
  if (!entry || !session) return null;
  const row = runRow(entry, organization);
  const base = attemptLabelBase(row);
  return {
    pendingRequests: session.pendingRequests.map((request) => ({
      ...request,
      createdAt: request.createdAt.toISOString(),
    })),
    messages: session.messages.map((message) => {
      const settledAt = message.deliveredAt ?? message.consumedAt;
      return {
        id: message.id,
        kind: message.kind,
        text: message.text,
        author: message.author,
        attempt: {
          id: message.attempt.id,
          label: describeAttempt({
            type: message.attempt.type,
            status: message.attempt.status,
            context: { ...base, story: message.attempt.story, agent: message.attempt.agent },
          }),
        },
        state: messageState(message),
        createdAt: message.createdAt.toISOString(),
        settledAt: settledAt?.toISOString() ?? null,
      };
    }),
    nextCursor: session.next && encodeSessionCursor(session.next),
    guidance: session.guidance,
    recommendations: session.recommendations.map(({ story, ...recommendation }) => ({
      ...recommendation,
      story: { ...story, url: storyIssueUrl(row.workItem?.url ?? null, story.identifier) },
    })),
    progressLog: session.progressLog,
  };
}
