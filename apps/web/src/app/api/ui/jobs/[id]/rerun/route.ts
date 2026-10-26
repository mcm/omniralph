import { getJob } from "@omniralph/db";
import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { requireOrganizationAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { JOB_NOT_FOUND, rerunJob } from "@/lib/jobs/rerun";

/**
 * Reruns a failed, canceled or expired job (members of its organization, which may be any
 * of the user's memberships, as the Repos rail offers Retry for every organization's repos):
 * see `rerunJob`. Work already queued or running answers a warning. A job of an
 * organization the user isn't a member of is not found (404).
 */
export const POST = apiHandler<"member", undefined, undefined, { id: string }>(
  { access: "member" },
  async ({ user, params }) => {
    const db = getDb();
    const id = requireUuid(params.id);
    const job = await getJob(db, id);
    const organization = await requireOrganizationAccess(user, job?.organizationId ?? null, {
      notFoundMessage: JOB_NOT_FOUND,
    });
    return rerunJob(db, getDispatcher(), organization.id, id);
  },
);
