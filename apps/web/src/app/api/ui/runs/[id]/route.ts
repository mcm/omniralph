import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { RunDetail } from "@/lib/api/runs";
import { requireRunAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { loadRunDetail } from "@/lib/runs/detail";

type Params = { id: string };

/**
 * A run of any kind (epic, request, review, triage, ask) in any of the user's
 * organizations: its list row plus its steps, attempts (newest first) and details, with
 * the actions open to the user. Transcripts are served per attempt
 * (`…/attempts/{attemptId}/transcript`). A run outside the user's memberships is not found.
 */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<RunDetail> => {
    const { run, organization } = await requireRunAccess(user, params.id, {
      notFoundMessage: "That run doesn't exist.",
    });
    const detail = await loadRunDetail(getDb(), run, organization, user.id);
    if (!detail) throw ApiRouteError.notFound("That run doesn't exist.");
    return detail;
  },
);
