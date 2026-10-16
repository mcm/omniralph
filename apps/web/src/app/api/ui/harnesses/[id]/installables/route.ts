import { getHarnessOverview, listHarnessInstallJobs } from "@omniralph/db";
import { z } from "zod";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { HarnessInstallables } from "@/lib/api/harnesses";
import { getDb } from "@/lib/db";

/** How far back the Installables tab lists install jobs. */
const INSTALL_JOBS_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The harness's reported installables and its install jobs of the last 24 hours (Installables tab). */
export const GET = apiHandler<"admin", undefined, undefined, { id: string }>(
  { access: "admin" },
  async ({ user, params }): Promise<HarnessInstallables> => {
    if (!z.uuid().safeParse(params.id).success) throw ApiRouteError.notFound();
    const db = getDb();
    const orgId = user.organization.id;
    const since = new Date(Date.now() - INSTALL_JOBS_WINDOW_MS);
    const [harness, installJobs] = await Promise.all([
      getHarnessOverview(db, orgId, params.id),
      listHarnessInstallJobs(db, orgId, params.id, since),
    ]);
    if (!harness) throw ApiRouteError.notFound();
    return {
      installables: harness.reportedInstallables.map(({ name, version }) => ({ name, version })),
      installJobs: installJobs.map((job) => ({
        id: job.id,
        status: job.status,
        name: job.name,
        version: job.version,
        installedVersion: job.installedVersion,
        error: job.error,
        createdAt: job.createdAt.toISOString(),
      })),
    };
  },
);
