import { getIntegration, getRunDetail } from "@omniralph/db";
import { z } from "zod";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { requireResourceInActiveOrganization } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { organizationDefinitions } from "@/lib/definitions";
import type { RalphRunDetailView } from "@/lib/ralph/display";
import { ralphRunDetailView } from "@/lib/ralph/history";

type Params = { id: string };

/** A coding run's detail (until the unified run detail replaces it). */
export interface RunDetail {
  run: RalphRunDetailView;
  /** False while no Linear workspace is connected. */
  linearConnected: boolean;
}

const detailQuery = z.object({ next: z.string().max(2000).optional() });

/**
 * A coding run of the active organization with its stories, lanes, requests, messages,
 * guidance, progress log and jobs: polled by its page. `?next=` is the page asking: when the
 * run is another of the user's organizations', the 409 that switches to it comes back there.
 */
export const GET = apiHandler<"member", undefined, typeof detailQuery, Params>(
  { query: detailQuery },
  async ({ user, params, query }): Promise<RunDetail> => {
    await requireResourceInActiveOrganization(user, "ralph_run", params.id, {
      pathPrefix: `/runs/${params.id}`,
      next: query.next,
    });
    const db = getDb();
    const organizationId = user.organization.id;
    const [detail, integration] = await Promise.all([
      getRunDetail(db, organizationId, params.id),
      getIntegration(db, organizationId, "linear"),
    ]);
    if (!detail) throw ApiRouteError.notFound();
    return {
      run: await ralphRunDetailView(detail, organizationDefinitions(db, organizationId)),
      linearConnected: integration !== null,
    };
  },
);
