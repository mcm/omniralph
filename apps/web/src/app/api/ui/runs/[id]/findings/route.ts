import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { RunFindings } from "@/lib/api/runs";
import { requireRunAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { loadRunFindings } from "@/lib/runs/findings";

type Params = { id: string };

/**
 * A review run's findings, per pass, in any of the user's organizations: each pass's
 * findings grouped by file, with their dismissals and the files it skipped. Other run kinds
 * have none (400). A run outside the user's memberships is not found. A read: it publishes
 * no change event, and the run's `run` events (a pass finishing, a dismissal) refetch it.
 */
export const GET = apiHandler<"member", undefined, undefined, Params>(
  {},
  async ({ user, params }): Promise<RunFindings> => {
    const { run } = await requireRunAccess(user, params.id, {
      notFoundMessage: "That run doesn't exist.",
    });
    if (run.kind !== "review") {
      throw new ApiRouteError(400, "Only review runs have findings.", "no_findings");
    }
    const findings = await loadRunFindings(getDb(), run);
    if (!findings) throw ApiRouteError.notFound("That run doesn't exist.");
    return findings;
  },
);
