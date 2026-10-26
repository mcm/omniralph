import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { updateRepositoryReviewSettings } from "@/lib/repositories/save";

/**
 * Saves the repository's review settings and agent pins (`RepositorySettingsInput`, checked
 * by the save so its errors read like the form's). Newly pinned agents pre-clone it.
 */
export const PUT = apiHandler<"admin", z.ZodUnknown, undefined, { id: string }>(
  { access: "admin", body: z.unknown() },
  async ({ user, params, body }) =>
    updateRepositoryReviewSettings(user, requireUuid(params.id), body),
);
