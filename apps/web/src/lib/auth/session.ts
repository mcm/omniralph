import "server-only";
import {
  getActiveOrganization,
  getMemberOrganization,
  listOrganizationsForUser,
  type UiTheme,
} from "@omniralph/db";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { z } from "zod";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";
import { assertRole, AuthorizationError, hasRole, type Role } from "./roles";
import {
  ACCESS_DENIED_PATH,
  ONBOARDING_PATH,
  ORGANIZATION_COOKIE,
  ORGANIZATION_SCOPE_COOKIE,
  SIGN_IN_PATH,
} from "./routes";

/** The organization the user is working in. */
export interface ActiveOrganization {
  id: string;
  name: string;
}

export interface CurrentUser {
  id: string;
  /** The active organization; `null` until the user creates, joins or picks one. */
  organization: ActiveOrganization | null;
  /** The user's role in the active organization; `null` without one. */
  role: Role | null;
  name: string | null;
  email: string | null;
  image: string | null;
  /** Remembered control panel theme; `null` follows the OS preference. */
  theme: UiTheme | null;
  /**
   * Whether the control panel shows advanced settings. Read only by the `(app)` layout
   * (and `useShowAdvanced`): no API handler, routing or run code reads it.
   */
  showAdvanced: boolean;
}

/** A signed-in user working in an organization. */
export type OrgUser = CurrentUser & { organization: ActiveOrganization; role: Role };

/**
 * The organization picked on this device (the cookie) while the user is still a member
 * of it, else the one they last picked anywhere.
 */
async function resolveOrganization(userId: string) {
  const db = getDb();
  const chosen = z.uuid().safeParse((await cookies()).get(ORGANIZATION_COOKIE)?.value);
  const onDevice = chosen.success
    ? await getMemberOrganization(db, { userId, organizationId: chosen.data })
    : null;
  return onDevice ?? (await getActiveOrganization(db, userId));
}

/** The signed-in user, or `null`. Cached per request: the root and `(app)` layouts both need it. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth();
  if (!session?.user?.id) return null;
  const { id, name, email, image, theme, showAdvanced } = session.user;
  const organization = await resolveOrganization(id);
  return {
    id,
    organization: organization ? { id: organization.id, name: organization.name } : null,
    role: organization?.role ?? null,
    name: name ?? null,
    email: email ?? null,
    image: image ?? null,
    theme,
    showAdvanced,
  };
});

/** One of the user's organizations, with their role in it. */
export interface OrganizationMembership {
  id: string;
  name: string;
  role: Role;
}

/**
 * Which organizations the user is looking at on this device: every one they belong to
 * ("All organizations"), or the active one. Page data queries filter by it, and check the
 * role of the organization that owns an item before acting on it.
 */
export type OrganizationScope =
  | { kind: "all"; organizations: OrganizationMembership[] }
  | { kind: "single"; organization: OrganizationMembership };

/** The signed-in user's organizations, with their role in each, ordered by name. Cached per request. */
export const getOrganizationMemberships = cache(async (): Promise<OrganizationMembership[]> => {
  const user = await getCurrentUser();
  if (!user) return [];
  const organizations = await listOrganizationsForUser(getDb(), user.id);
  return organizations.map(({ id, name, role }) => ({ id, name, role }));
});

/**
 * The signed-in user's organization scope on this device: `all` (every organization they
 * belong to, ordered by name) while the scope cookie says `all` and they belong to two or
 * more, else `single` (the active organization; e.g. after being removed from all but
 * one). `null` when signed out, or with no active organization and not `all`.
 * `requirePageUser()`, `requireUser()` and `/api/ui` keep acting on the active
 * organization either way.
 */
export const getOrganizationScope = cache(async (): Promise<OrganizationScope | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  if ((await cookies()).get(ORGANIZATION_SCOPE_COOKIE)?.value === "all") {
    const organizations = await getOrganizationMemberships();
    if (organizations.length >= 2) return { kind: "all", organizations };
  }
  if (!user.organization || !user.role) return null;
  return { kind: "single", organization: { ...user.organization, role: user.role } };
});

/**
 * For pages: the signed-in user with `role` (default `member`) in their active
 * organization. Redirects to sign-in, to onboarding (no active organization) or to
 * access denied otherwise.
 */
export async function requirePageUser(role: Role = "member"): Promise<OrgUser> {
  const user = await getCurrentUser();
  if (!user) redirect(SIGN_IN_PATH);
  if (!user.organization || !user.role) redirect(ONBOARDING_PATH);
  if (!hasRole(user, role)) redirect(`${ACCESS_DENIED_PATH}?reason=forbidden`);
  return user as OrgUser;
}

/**
 * For server actions and route handlers: the signed-in user with `role` in their
 * active organization; throws `AuthorizationError` otherwise. Every mutating action
 * for settings, repos, agents and members must call `requireUser("admin")` first.
 */
export async function requireUser(role: Role = "member"): Promise<OrgUser> {
  return assertRole(await getCurrentUser(), role) as OrgUser;
}

/**
 * For actions any signed-in user may take, with or without an organization (creating,
 * joining or switching organizations, the theme); throws `AuthorizationError` otherwise.
 */
export async function requireSignedInUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthorizationError("You must be signed in.", "unauthenticated");
  return user;
}
