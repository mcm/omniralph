import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { cancelJob } from "@/lib/jobs/cancel";

/** Cancels the job (members of its organization): see `cancelJob`. A running job answers a cancel-requested warning. */
export const POST = apiHandler<"member", undefined, undefined, { id: string }>(
  { access: "member" },
  async ({ user, params }) => cancelJob(getDb(), user.organization.id, requireUuid(params.id)),
);
