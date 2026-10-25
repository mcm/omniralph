import { apiHandler } from "@/lib/api/handler";
import { inboxCountsQuerySchema, type InboxCountsResponse } from "@/lib/api/inbox";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { loadInboxCounts } from "@/lib/inbox/feed";

/**
 * How many items each Inbox tab has for the signed-in user (the sidebar badge), counted
 * exactly as `GET /api/ui/inbox` lists them, in a fixed number of queries.
 */
export const GET = apiHandler(
  { query: inboxCountsQuerySchema },
  async ({ user, query }): Promise<InboxCountsResponse> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    return loadInboxCounts(getDb(), { organizations, userId: user.id });
  },
);
