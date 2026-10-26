import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import type { RepositoryList } from "@/lib/api/repositories";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { loadRepositoryList } from "@/lib/repositories/list";

const listQuery = z.object({ organization: z.string().optional() });

/**
 * The Repos rail: every connected repository of the active organization, one of the user's
 * organizations (`organization=<id>`) or all of them (`organization=all`), with its
 * switches and status, capped at 500 (`truncated`). Another organization answers 404.
 */
export const GET = apiHandler(
  { query: listQuery },
  async ({ user, query }): Promise<RepositoryList> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    return loadRepositoryList(getDb(), organizations);
  },
);
