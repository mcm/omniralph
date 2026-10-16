import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { disconnectRepository } from "@/lib/repositories/manage";

/**
 * Disconnects the repository: reviews stop, its pins and (GitLab) webhook are removed, its
 * review history is kept.
 */
export const DELETE = apiHandler<"admin", undefined, undefined, { id: string }>(
  { access: "admin" },
  async ({ user, params }) =>
    disconnectRepository(getDb(), user.organization.id, requireUuid(params.id)),
);
