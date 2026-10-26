import { getJob } from "@omniralph/db";
import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { membership } from "@/lib/api/scope";
import { AuthorizationError, hasRole } from "@/lib/auth/roles";
import { getDb } from "@/lib/db";
import { cancelJob } from "@/lib/jobs/cancel";

/**
 * Cancels the job (members of its organization, which may be any of the user's
 * memberships, as the Runs screen opens runs of every one): see `cancelJob`. A running job
 * answers a cancel-requested warning. A job of an organization the user isn't a member of
 * doesn't exist.
 */
export const POST = apiHandler<"member", undefined, undefined, { id: string }>(
  { access: "member" },
  async ({ user, params }) => {
    const db = getDb();
    const id = requireUuid(params.id);
    const job = await getJob(db, id);
    const organization = job && (await membership(user, job.organizationId));
    if (!organization) return { ok: false, error: "That job doesn't exist." };
    if (!hasRole(organization, "member")) {
      throw new AuthorizationError("This action requires the member role.", "forbidden");
    }
    return cancelJob(db, organization.id, id);
  },
);
