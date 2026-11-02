import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { RunTriageSummary } from "@/lib/api/runs";
import { requireRunAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { loadRunTriageSummary } from "@/lib/runs/triage-summary";

type Params = { id: string };

/**
 * A triage run's summary, in any of the user's organizations: its outcome, what the last
 * triage decided and left open, and the issue as it read before triage. Other run kinds
 * have none (400). `answerQuestions` says whether the user may answer its open questions. A run outside the user's memberships is not found. A read: the run's
 * `run` events refetch it.
 */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<RunTriageSummary> => {
    const { run, organization } = await requireRunAccess(user, params.id, {
      notFoundMessage: "That run doesn't exist.",
    });
    if (run.kind !== "triage") {
      throw new ApiRouteError(400, "Only triage runs have a triage summary.", "no_triage");
    }
    const summary = await loadRunTriageSummary(getDb(), run, organization.role);
    if (!summary) throw ApiRouteError.notFound("That run doesn't exist.");
    return summary;
  },
);
