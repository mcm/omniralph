import { apiHandler } from "@/lib/api/handler";
import { askRepositoriesQuerySchema, type AskRepositoryList } from "@/lib/api/ask";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { askRepositories } from "@/lib/ask/chats";
import { getDb } from "@/lib/db";

/**
 * The repos a new chat can pick, each with its organization: the scope's connected repos
 * with Ask on, by organization name, then path.
 */
export const GET = apiHandler(
  { query: askRepositoriesQuerySchema },
  async ({ user, query }): Promise<AskRepositoryList> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    return askRepositories(getDb(), organizations);
  },
);
