import { apiHandler } from "@/lib/api/handler";
import { inboxItemActionRequestSchema, type InboxItemActionResult } from "@/lib/api/inbox";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { actOnInboxItem } from "@/lib/inbox/actions";
import { userDisplayName } from "@/lib/user-display";

type Params = { key: string };

/**
 * Acts on an Inbox item of any of the user's organizations (members), by its key
 * (`{action, until?}`, see `inboxItemActionRequestSchema`): Done, Skip (a manual story),
 * Snooze, Restore, Start anyway (a blocked epic), Resume (a stopped run) or Retry. 404
 * ("This item was already handled.") when the key no longer derives an item, 400 when the
 * item doesn't offer the action.
 */
export const POST = apiHandler<"member", typeof inboxItemActionRequestSchema, undefined, Params>(
  { access: "member", body: inboxItemActionRequestSchema },
  async ({ user, params, body }): Promise<InboxItemActionResult> => {
    const organizations = await resolveOrganizationScope(user, "all");
    return actOnInboxItem(
      getDb(),
      organizations,
      { userId: user.id, name: userDisplayName(user) },
      itemKey(params.key),
      body,
    );
  },
);

/** The key as sent: path segments may arrive percent-encoded (`:` and `,`). */
function itemKey(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
