import "server-only";
import {
  getMemberOrganization,
  getResourceOrganizationId,
  type OrganizationResource,
} from "@omniralph/db";
import { z } from "zod";
import { safeCallbackPath } from "@/lib/auth/routes";
import type { OrgUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { createEnterOrganizationPath } from "@/lib/organizations/enter";
import { ApiRouteError } from "./handler";
import { ENTER_ORGANIZATION } from "./schemas";

/** Shown while the client switches to the resource's organization. */
export const ENTER_ORGANIZATION_MESSAGE = "This belongs to another of your organizations.";

/** A resource's `id` from the route: anything but a UUID is not found (before it reaches a query). */
export function requireUuid(id: string): string {
  if (!z.uuid().safeParse(id).success) throw ApiRouteError.notFound();
  return id;
}

/**
 * For the handlers of a resource's detail: makes sure the resource (by `id`, which must
 * be a UUID) is in the active organization before the handler loads it, scoped to
 * `user.organization`. A resource of another of the user's organizations answers 409
 * `ENTER_ORGANIZATION` with the signed path that switches to it and goes to `next` (the
 * page the client is on, when it's one of the resource's own pages under `pathPrefix`,
 * else `pathPrefix`): the API counterpart of `enterResourceOrganization`. A missing
 * resource, or one of an organization the user isn't a member of, is not found.
 */
export async function requireResourceInActiveOrganization(
  user: OrgUser,
  resource: OrganizationResource,
  id: string,
  { pathPrefix, next }: { pathPrefix: string; next?: string | null },
): Promise<void> {
  requireUuid(id);
  const db = getDb();
  const organizationId = await getResourceOrganizationId(db, resource, id);
  if (!organizationId) throw ApiRouteError.notFound();
  if (organizationId === user.organization.id) return;
  if (!(await getMemberOrganization(db, { userId: user.id, organizationId }))) {
    throw ApiRouteError.notFound();
  }
  const requested = safeCallbackPath(next);
  const onResource =
    requested === pathPrefix ||
    requested.startsWith(`${pathPrefix}/`) ||
    requested.startsWith(`${pathPrefix}?`);
  const enterPath = await createEnterOrganizationPath({
    userId: user.id,
    organizationId,
    next: onResource ? requested : pathPrefix,
  });
  throw new ApiRouteError(
    409,
    ENTER_ORGANIZATION_MESSAGE,
    ENTER_ORGANIZATION,
    undefined,
    enterPath,
  );
}
