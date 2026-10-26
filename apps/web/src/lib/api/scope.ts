import "server-only";
import {
  getMemberOrganization,
  getRunIndexEntry,
  listOrganizationsForUser,
  type RunIndexEntry,
} from "@omniralph/db";
import { z } from "zod";
import { AuthorizationError, hasRole, type Role } from "@/lib/auth/roles";
import type { OrgUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { ApiRouteError } from "./handler";
import { requireUuid } from "./resource";

/** An organization a request covers, and the user's role there. */
export interface ScopedOrganization {
  id: string;
  name: string;
  role: Role;
}

function activeOrganization(user: OrgUser): ScopedOrganization {
  return { id: user.organization.id, name: user.organization.name, role: user.role };
}

/** The user's membership of `organizationId` (the active one without a query), or null. */
export async function membership(
  user: OrgUser,
  organizationId: string,
): Promise<ScopedOrganization | null> {
  if (organizationId === user.organization.id) return activeOrganization(user);
  return getMemberOrganization(getDb(), { userId: user.id, organizationId });
}

/**
 * The organizations a list request covers (`organization` query parameter): the active
 * organization by default, one of the user's memberships by ID, or every membership
 * (`all`). An organization the user isn't a member of is not found.
 */
export async function resolveOrganizationScope(
  user: OrgUser,
  organization: string | undefined,
): Promise<ScopedOrganization[]> {
  if (!organization) return [activeOrganization(user)];
  if (organization === "all") {
    const organizations = await listOrganizationsForUser(getDb(), user.id);
    return organizations.map(({ id, name, role }) => ({ id, name, role }));
  }
  const found = await membership(user, requireUuid(organization));
  if (!found) throw ApiRouteError.notFound();
  return [found];
}

/**
 * For another resource of any of the user's organizations (a connection's delivery log):
 * the user's membership of `organizationId` (null when the resource doesn't exist), which
 * must be at least `role`. A missing resource, or one of an organization the user isn't a
 * member of, is not found.
 */
export async function requireOrganizationAccess(
  user: OrgUser,
  organizationId: string | null,
  { role = "member", notFoundMessage }: { role?: Role; notFoundMessage?: string } = {},
): Promise<ScopedOrganization> {
  const organization = organizationId && (await membership(user, organizationId));
  if (!organization) throw ApiRouteError.notFound(notFoundMessage);
  if (!hasRole(organization, role)) {
    throw new AuthorizationError(`This action requires the ${role} role.`, "forbidden");
  }
  return organization;
}

/**
 * For a run's detail and actions: the run (by `runId`, which must be a UUID) in any of the
 * user's organizations, with the user's role there, which must be at least `role`. A
 * missing run, or one of an organization the user isn't a member of, is not found
 * (`notFoundMessage`).
 */
export async function requireRunAccess(
  user: OrgUser,
  runId: string,
  { role = "member", notFoundMessage }: { role?: Role; notFoundMessage?: string } = {},
): Promise<{ run: RunIndexEntry; organization: ScopedOrganization }> {
  if (!z.uuid().safeParse(runId).success) throw ApiRouteError.notFound(notFoundMessage);
  const run = await getRunIndexEntry(getDb(), runId);
  const organization = run && (await membership(user, run.organizationId));
  if (!run || !organization) throw ApiRouteError.notFound(notFoundMessage);
  if (!hasRole(organization, role)) {
    throw new AuthorizationError(`This action requires the ${role} role.`, "forbidden");
  }
  return { run, organization };
}
