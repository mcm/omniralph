/**
 * An attempt's transcript (`GET /api/ui/runs/{id}/attempts/{attemptId}/transcript`): its
 * query and cursor.
 */
import type { TranscriptCursor } from "@omniralph/db";
import { z } from "zod";
import { TRANSCRIPT_DEFAULT_LIMIT, TRANSCRIPT_MAX_LIMIT } from "@/lib/api/runs";

/** `{at, id}` of the last event, as an opaque base64url string. */
export function encodeTranscriptCursor(cursor: TranscriptCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id])).toString("base64url");
}

const cursorShape = z.tuple([z.iso.datetime(), z.uuid()]);

/** The cursor `encodeTranscriptCursor` wrote, or null when `value` isn't one. */
export function decodeTranscriptCursor(value: string): TranscriptCursor | null {
  try {
    const parsed = cursorShape.safeParse(JSON.parse(Buffer.from(value, "base64url").toString()));
    return parsed.success ? { at: parsed.data[0], id: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

const LIMIT_MESSAGE = `The limit must be a number from 1 to ${TRANSCRIPT_MAX_LIMIT}.`;

export const transcriptQuerySchema = z.object({
  cursor: z
    .string()
    .transform((value, ctx) => {
      const cursor = decodeTranscriptCursor(value);
      if (!cursor) ctx.addIssue({ code: "custom", message: "The cursor is invalid." });
      return cursor ?? z.NEVER;
    })
    .optional(),
  limit: z.coerce
    .number({ error: LIMIT_MESSAGE })
    .int({ error: LIMIT_MESSAGE })
    .min(1, { error: LIMIT_MESSAGE })
    .max(TRANSCRIPT_MAX_LIMIT, { error: LIMIT_MESSAGE })
    .default(TRANSCRIPT_DEFAULT_LIMIT),
});
