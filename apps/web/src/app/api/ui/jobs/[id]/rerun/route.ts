import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";
import { rerunJob } from "@/lib/jobs/rerun";

/** Reruns a failed, canceled or expired job (members of its organization): see `rerunJob`. Work already queued or running answers a warning. */
export const POST = apiHandler<"member", undefined, undefined, { id: string }>(
  { access: "member" },
  async ({ user, params }) =>
    rerunJob(getDb(), getDispatcher(), user.organization.id, requireUuid(params.id)),
);
