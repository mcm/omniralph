import { apiHandler } from "@/lib/api/handler";
import { pinnableRepositoriesQuerySchema } from "@/lib/api/harnesses";
import { getDb } from "@/lib/db";
import { searchPinnableRepositories } from "@/lib/harnesses/manage";

/** The connected repositories matching `?query=` (at most 20): the pins picker's search. */
export const GET = apiHandler(
  { access: "admin", query: pinnableRepositoriesQuerySchema },
  async ({ user, query }) => ({
    repositories: await searchPinnableRepositories(getDb(), user.organization.id, query.query),
  }),
);
