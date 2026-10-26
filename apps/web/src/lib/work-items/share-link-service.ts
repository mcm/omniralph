import "server-only";
import {
  createWorkItemShareLink,
  getWorkItemShareLink,
  listActiveWorkItemShareLinks,
  revokeWorkItemShareLink,
  type Database,
  type ShareLinkActor,
  type WorkItemKey,
  type WorkItemShareLink,
} from "@omniralph/db";
import { ApiRouteError } from "@/lib/api/handler";
import { membership } from "@/lib/api/scope";
import type { CreateShareLinkResponse, ShareLink } from "@/lib/api/work-items";
import type { OrgUser } from "@/lib/auth/session";
import type { ResolvedWorkItem } from "./item";
import {
  hashSharePassword,
  hashShareToken,
  MAX_ACTIVE_SHARE_LINKS,
  newShareToken,
  SHARE_LINK_LIMIT_MESSAGE,
  SHARE_LINK_NOT_FOUND_MESSAGE,
  SHARE_LINK_TTL_MS,
  sharePath,
} from "./share-links";

/** "Share review link" for members: create, list and revoke a work item's review links. */

function toShareLink(link: WorkItemShareLink & { createdByName?: string | null }): ShareLink {
  return {
    id: link.id,
    protected: link.passwordHash !== null,
    createdAt: link.createdAt.toISOString(),
    expiresAt: link.expiresAt.toISOString(),
    createdBy: link.createdByName ? { name: link.createdByName } : null,
  };
}

/** The item's active links, oldest first, without tokens. */
export async function listShareLinks(db: Database, key: WorkItemKey): Promise<ShareLink[]> {
  return (await listActiveWorkItemShareLinks(db, key)).map(toShareLink);
}

/**
 * Creates a link to the item (30 days; password-protected when `password` isn't empty) and
 * records `share_link_created`. 400 once the item has `MAX_ACTIVE_SHARE_LINKS` active links.
 * The answer carries the link's URL, the only time its token leaves the server.
 */
export async function createShareLink(
  db: Database,
  resolved: Pick<ResolvedWorkItem, "key">,
  actor: ShareLinkActor,
  input: { password: string; baseUrl: string; now?: Date },
): Promise<CreateShareLinkResponse> {
  const now = input.now ?? new Date();
  const token = newShareToken();
  const created = await createWorkItemShareLink(db, {
    ...resolved.key,
    tokenHash: hashShareToken(token),
    passwordHash: input.password === "" ? null : await hashSharePassword(input.password),
    expiresAt: new Date(now.getTime() + SHARE_LINK_TTL_MS),
    actor,
    maxActive: MAX_ACTIVE_SHARE_LINKS,
    now,
  });
  if (created.status === "limit") {
    throw new ApiRouteError(400, SHARE_LINK_LIMIT_MESSAGE, "share_link_limit");
  }
  return {
    link: toShareLink({ ...created.link, createdByName: actor.name }),
    url: `${input.baseUrl}${sharePath(token)}`,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Revokes a link of an item in one of the user's organizations and records
 * `share_link_revoked`; a link already revoked stays so. 404 for a link of an organization
 * the user isn't a member of.
 */
export async function revokeShareLink(
  db: Database,
  user: OrgUser,
  linkId: string,
  actor: ShareLinkActor,
): Promise<{ ok: true }> {
  const link = UUID.test(linkId) ? await getWorkItemShareLink(db, linkId) : null;
  if (!link || !(await membership(user, link.organizationId))) {
    throw ApiRouteError.notFound(SHARE_LINK_NOT_FOUND_MESSAGE);
  }
  if (!link.revokedAt) await revokeWorkItemShareLink(db, { id: link.id, actor });
  return { ok: true };
}
