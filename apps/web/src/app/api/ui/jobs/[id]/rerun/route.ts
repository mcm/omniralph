import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { rerunJob } from "@/lib/jobs/rerun";

/** Reruns a failed job (admins): see `rerunJob`. Work already queued or running answers a warning. */
export const POST = apiHandler<"admin", undefined, undefined, { id: string }>(
  { access: "admin" },
  async ({ user, params }) =>
    rerunJob(getDb(), getDispatcher(), user.organization.id, requireUuid(params.id)),
);
