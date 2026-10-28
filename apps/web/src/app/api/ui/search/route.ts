import { apiHandler } from "@/lib/api/handler";
import { searchQuerySchema, type SearchResponse } from "@/lib/api/search";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { search } from "@/lib/search/search";

/**
 * Search and jump: the runs, Backlog work items, repos, agents and Settings pages matching
 * `q` in the active organization, one of the user's organizations (`organization=<id>`) or
 * all of them (`organization=all`), grouped by kind, best match first (`limit` per kind).
 * A query shorter than two characters answers the user's five most recently opened items.
 * Another organization answers 404.
 */
export const GET = apiHandler(
  { query: searchQuerySchema },
  async ({ user, query }): Promise<SearchResponse> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    return search({ db: getDb() }, user.id, organizations, query);
  },
);
