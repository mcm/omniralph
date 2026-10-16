import { getTriageRunDetail, listRecentRunActivities } from "@omniralph/db";
import { z } from "zod";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireResourceInActiveOrganization } from "@/lib/api/resource";
import type { TriageRunDetail } from "@/lib/api/triage";
import { getDb } from "@/lib/db";
import { triageRunDetailView } from "@/lib/triage/view";

type Params = { id: string };

const detailQuery = z.object({ next: z.string().max(2000).optional() });

/** Activities of the run's jobs shown, the latest ones. */
const ACTIVITY_LIMIT = 200;

/**
 * A triage run of the active organization with its result, jobs and session activity:
 * polled by its page. `?next=` is the page asking: when the run is another of the user's
 * organizations', the 409 that switches to it comes back there.
 */
export const GET = apiHandler<"member", undefined, typeof detailQuery, Params>(
  { query: detailQuery },
  async ({ user, params, query }): Promise<TriageRunDetail> => {
    await requireResourceInActiveOrganization(user, "triage_run", params.id, {
      pathPrefix: `/triage/${params.id}`,
      next: query.next,
    });
    const db = getDb();
    const organizationId = user.organization.id;
    const detail = await getTriageRunDetail(db, organizationId, params.id);
    if (!detail) throw ApiRouteError.notFound();
    const activities = await listRecentRunActivities(
      db,
      organizationId,
      detail.jobs.map((job) => job.id),
      ACTIVITY_LIMIT,
    );
    return { run: triageRunDetailView(detail, activities) };
  },
);
