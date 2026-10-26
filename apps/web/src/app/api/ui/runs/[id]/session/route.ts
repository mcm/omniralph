import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { RunSession } from "@/lib/api/runs";
import { requireRunAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { loadRunSession, sessionQuerySchema } from "@/lib/runs/session";

type Params = { id: string };

/**
 * An epic's or request's Session, in any of the user's organizations: its pending requests,
 * the messages passed to its attempts (newest first, a page at a time: `cursor` is the
 * previous page's `nextCursor`), its guidance, its stories' recommendations and its progress
 * log. Other run kinds have none (400). A run outside the user's memberships is not found.
 */
export const GET = apiHandler<"member", undefined, typeof sessionQuerySchema, Params>(
  { query: sessionQuerySchema },
  async ({ user, params, query }): Promise<RunSession> => {
    const { run, organization } = await requireRunAccess(user, params.id, {
      notFoundMessage: "That run doesn't exist.",
    });
    if (run.kind !== "epic" && run.kind !== "request") {
      throw new ApiRouteError(400, "Only epic and request runs have a session.", "no_session");
    }
    const session = await loadRunSession(getDb(), run, organization, query.cursor);
    if (!session) throw ApiRouteError.notFound("That run doesn't exist.");
    return session;
  },
);
