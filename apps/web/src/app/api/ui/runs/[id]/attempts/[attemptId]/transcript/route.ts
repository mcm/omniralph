import { isRunAttempt, listAttemptTranscript } from "@omniralph/db";
import { z } from "zod";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { TranscriptPageView } from "@/lib/api/runs";
import { requireRunAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { encodeTranscriptCursor, transcriptQuerySchema } from "@/lib/runs/transcript";

type Params = { id: string; attemptId: string };

/**
 * What one attempt of a run reported (`run_activities`), oldest first, a page at a time
 * (`limit` 1–500, default 200; `nextCursor` is null on the last page). An attempt of
 * another run is not found.
 */
export const GET = apiHandler<"member", undefined, typeof transcriptQuerySchema, Params>(
  { query: transcriptQuerySchema },
  async ({ user, params, query }): Promise<TranscriptPageView> => {
    const { run } = await requireRunAccess(user, params.id, {
      notFoundMessage: "That run doesn't exist.",
    });
    const db = getDb();
    if (
      !z.uuid().safeParse(params.attemptId).success ||
      !(await isRunAttempt(db, run, params.attemptId))
    ) {
      throw ApiRouteError.notFound("That attempt doesn't exist.");
    }
    const page = await listAttemptTranscript(db, params.attemptId, {
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      events: page.events.map((event) => ({
        id: event.id,
        type: event.type,
        body: event.body,
        parameter: event.parameter,
        at: event.at.toISOString(),
      })),
      nextCursor: page.next && encodeTranscriptCursor(page.next),
    };
  },
);
