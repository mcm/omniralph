import { apiHandler } from "@/lib/api/handler";
import { getDb } from "@/lib/db";
import { userDisplayName } from "@/lib/user-display";
import { revokeShareLink } from "@/lib/work-items/share-link-service";

/** Revokes a review link (members of its item's organization; 404 otherwise). */
export const DELETE = apiHandler<"member", undefined, undefined, { linkId: string }>(
  {},
  async ({ user, params }) =>
    revokeShareLink(getDb(), user, params.linkId, {
      userId: user.id,
      name: userDisplayName(user),
    }),
);
