import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import { requireUuid } from "@/lib/api/resource";
import { updateRepositoryTaskTypes } from "@/lib/repositories/save";

/** Saves which task types the repository runs (`RepositoryTaskTypesInput`). */
export const PUT = apiHandler<"admin", z.ZodUnknown, undefined, { id: string }>(
  { access: "admin", body: z.unknown() },
  async ({ user, params, body }) => updateRepositoryTaskTypes(user, requireUuid(params.id), body),
);
