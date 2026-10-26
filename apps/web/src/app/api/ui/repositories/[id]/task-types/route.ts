import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { apiHandler } from "@/lib/api/handler";
import type { RepositoryTaskTypes } from "@/lib/api/repositories";
import { requireUuid } from "@/lib/api/resource";
import { loadRepositoryTaskTypes } from "@/lib/repositories/detail";
import { updateRepositoryTaskTypes } from "@/lib/repositories/save";

type Params = { id: string };

/** The repository's Reviews, Coding and Ask switches (`repositoryTaskTypesSchema`). */
export const GET = apiHandler<"admin", undefined, undefined, Params>(
  { access: "admin" },
  async ({ user, params }): Promise<RepositoryTaskTypes> =>
    loadRepositoryTaskTypes(user.organization.id, requireUuid(params.id)),
);

/**
 * Saves the repository's switches (`RepositoryTaskTypesInput`: `{ reviews, coding, ask }`,
 * each on or off) and answers them. Turning Coding on without a work item match answers 409.
 */
export const PUT = apiHandler<"admin", z.ZodUnknown, undefined, Params>(
  { access: "admin", body: z.unknown() },
  async ({ user, params, body }): Promise<RepositoryTaskTypes | ActionResult> =>
    updateRepositoryTaskTypes(user, requireUuid(params.id), body),
);
