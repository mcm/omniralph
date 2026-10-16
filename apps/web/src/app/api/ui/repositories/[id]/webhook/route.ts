import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { getDb } from "@/lib/db";
import { recreateGitLabWebhook } from "@/lib/repositories/manage";

/** Recreates the GitLab project's webhook and clears its webhook problems from the connection's health. */
export const POST = apiHandler<"admin", undefined, undefined, { id: string }>(
  { access: "admin" },
  async ({ user, params }) =>
    recreateGitLabWebhook(getDb(), user.organization.id, requireUuid(params.id)),
);
