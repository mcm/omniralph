import { getAgentOverview, listAgentPinSyncJobs, listRecentAgentAudit } from "@omniralph/db";
import { z } from "zod";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { HarnessDetail } from "@/lib/api/harnesses";
import { requireResourceInActiveOrganization } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { organizationAgentVersion } from "@/lib/harnesses/desired-version";
import { clientIp } from "@/lib/harnesses/request";
import { deleteAgent } from "@/lib/harnesses/manage";
import { withHarnessLastSeen } from "@/lib/harnesses/last-seen";
import { harnessRow } from "@/lib/harnesses/rows";

/** Number of audit events the pages show. */
const AUDIT_LIMIT = 50;
/** How far back pinned repositories' sync jobs are shown. */
const PIN_SYNC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** npm's `latest` is read at most every 5 minutes (cached); never let it hold up a poll for long. */
const NPM_TIMEOUT_MS = 2_000;

type Params = { id: string };

const detailQuery = z.object({ next: z.string().max(2000).optional() });

/**
 * One harness of the active organization, with what all its tabs show: polled by its pages.
 * `?next=` is the page asking: when the harness is another of the user's organizations',
 * the 409 that switches to it comes back there.
 */
export const GET = apiHandler<"admin", undefined, typeof detailQuery, Params>(
  { access: "admin", query: detailQuery },
  async ({ user, params, query }): Promise<HarnessDetail> => {
    await requireResourceInActiveOrganization(user, "agent", params.id, {
      pathPrefix: `/harnesses/${params.id}`,
      next: query.next,
    });
    const db = getDb();
    const orgId = user.organization.id;
    const now = new Date();
    const [harness, audit, version, pinSyncJobs] = await Promise.all([
      getAgentOverview(db, orgId, params.id).then(withHarnessLastSeen),
      listRecentAgentAudit(db, params.id, AUDIT_LIMIT),
      organizationAgentVersion(db, orgId, { timeoutMs: NPM_TIMEOUT_MS }),
      listAgentPinSyncJobs(db, orgId, params.id, new Date(now.getTime() - PIN_SYNC_WINDOW_MS)),
    ]);
    if (!harness) throw ApiRouteError.notFound();
    return {
      harness: harnessRow(harness, now, version.version, version.tracksLatest),
      globalDesiredVersion: version.tracksLatest
        ? version.version
          ? `${version.version} (latest on npm)`
          : "the latest on npm"
        : version.version,
      audit: audit.map((entry) => ({
        id: entry.id,
        event: entry.event,
        ip: entry.ip,
        detail: entry.detail,
        createdAt: entry.createdAt.toISOString(),
      })),
      pinSyncJobs: pinSyncJobs.map((job) => ({
        ...job,
        createdAt: job.createdAt.toISOString(),
        finishedAt: job.finishedAt?.toISOString() ?? null,
      })),
    };
  },
);

/** Deletes the harness (revoking it first if it isn't), removing it from the Harnesses pages. */
export const DELETE = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params, request }) =>
    deleteAgent(params.id, {
      organizationId: user.organization.id,
      userId: user.id,
      ip: clientIp(request.headers),
    }),
);
