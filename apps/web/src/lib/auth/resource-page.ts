import "server-only";
import {
  getResourceOrganizationId,
  setActiveOrganization,
  type OrganizationResource,
} from "@omniralph/db";
import { notFound, redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import type { OrgUser } from "./session";

/**
 * For detail pages: makes sure the resource's organization is the active one before
 * the page loads it (scoped to `user.organization`). A resource of another of the
 * user's organizations switches to that organization and reloads `path` (with
 * `searchParams`), so the whole app shell shows it; a missing resource, or one of an organization the user isn't a
 * member of, is not found.
 */
export async function enterResourceOrganization(
  user: OrgUser,
  resource: OrganizationResource,
  id: string,
  path: string,
  searchParams: Record<string, string | string[] | undefined> = {},
): Promise<void> {
  const db = getDb();
  const organizationId = await getResourceOrganizationId(db, resource, id);
  if (!organizationId) notFound();
  if (organizationId === user.organization.id) return;
  if (!(await setActiveOrganization(db, { userId: user.id, organizationId }))) notFound();
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    for (const item of [value ?? []].flat()) query.append(key, item);
  }
  redirect(query.size > 0 ? `${path}?${query}` : path);
}
