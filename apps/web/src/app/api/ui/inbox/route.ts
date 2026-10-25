import { apiHandler } from "@/lib/api/handler";
import { inboxQuerySchema, type InboxFeed } from "@/lib/api/inbox";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { loadInboxFeed } from "@/lib/inbox/feed";

/**
 * One Inbox tab for the signed-in user, newest first: `needs-you` (default: work only a
 * person can unblock), `problems` (failed runs and system work, agents offline or failing
 * to update) or `running`. Covers the active organization, one of the user's
 * (`organization=<id>`) or all of them (`organization=all`). Items the user marked Done or
 * snoozed into the future are left out.
 */
export const GET = apiHandler(
  { query: inboxQuerySchema },
  async ({ user, query }): Promise<InboxFeed> => {
    const organizations = await resolveOrganizationScope(user, query.organization);
    const items = await loadInboxFeed(getDb(), { organizations, userId: user.id }, query.tab);
    return { items };
  },
);
