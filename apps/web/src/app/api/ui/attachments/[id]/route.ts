import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import { attachmentQuerySchema } from "@/lib/api/features";
import { membership } from "@/lib/api/scope";
import type { OrgUser } from "@/lib/auth/session";
import {
  ATTACHMENT_NOT_FOUND_MESSAGE,
  downloadAttachment,
  removeAttachment,
} from "@/lib/attachments/service";
import { getDb } from "@/lib/db";

type Params = { id: string };

/** The attachment's organization: `organization` when it's one of the user's, else the active one. */
async function organizationOf(user: OrgUser, organization: string | undefined): Promise<string> {
  if (!organization) return user.organization.id;
  const found = await membership(user, organization);
  if (!found) throw ApiRouteError.notFound(ATTACHMENT_NOT_FOUND_MESSAGE);
  return found.id;
}

/**
 * An attachment's file (members of its organization): images and PDFs shown in the browser,
 * other files (or any with `?download=1`) downloaded.
 */
export const GET = apiHandler<"member", undefined, typeof attachmentQuerySchema, Params>(
  { query: attachmentQuerySchema },
  async ({ user, params, query }) =>
    downloadAttachment(
      { db: getDb() },
      await organizationOf(user, query.organization),
      params.id,
      query.download === "1",
    ),
);

/** Removes an attachment and its file (members of its organization). */
export const DELETE = apiHandler<"member", undefined, typeof attachmentQuerySchema, Params>(
  { query: attachmentQuerySchema },
  async ({ user, params, query }) =>
    removeAttachment({ db: getDb() }, await organizationOf(user, query.organization), params.id),
);
