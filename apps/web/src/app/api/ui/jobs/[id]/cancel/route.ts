import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { cancelJob } from "@/lib/jobs/cancel";

/** Cancels the job (admins): see `cancelJob`. A running job answers a cancel-requested warning. */
export const POST = apiHandler<"admin", undefined, undefined, { id: string }>(
  { access: "admin" },
  async ({ user, params }) => cancelJob(getDb(), user.organization.id, requireUuid(params.id)),
);
