import { apiHandler } from "@/lib/api/handler";
import { codingMatchCheckInputSchema, type CodingMatchCheck } from "@/lib/api/repositories";
import { requireRepositoryAccess } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { checkCodingMatch } from "@/lib/repositories/cards";

/**
 * The conflicts an unsaved work item match would have (admins of the repo's organization):
 * `{ warnings }` naming each other repo whose match conflicts, as the Coding save answers
 * them. Saves and publishes nothing.
 */
export const POST = apiHandler<
  "member",
  typeof codingMatchCheckInputSchema,
  undefined,
  { id: string }
>(
  { body: codingMatchCheckInputSchema },
  async ({ user, params, body }): Promise<CodingMatchCheck> => {
    const { repository } = await requireRepositoryAccess(user, params.id, "admin");
    return checkCodingMatch(getDb(), repository, body.workItemMatch);
  },
);
