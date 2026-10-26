import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import type { AgentList } from "@/lib/api/agents";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { loadFleet } from "@/lib/fleet/load";

const listQuery = z.object({ organization: z.string().optional() });

/**
 * Fleet: the agents of the active organization, one of the user's organizations
 * (`organization=<id>`) or all of them (`organization=all`), each with its organization,
 * status and pins, and the summary cells. Another organization answers 404.
 */
export const GET = apiHandler(
  { query: listQuery },
  async ({ user, query }): Promise<AgentList> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    return loadFleet(getDb(), organizations);
  },
);
