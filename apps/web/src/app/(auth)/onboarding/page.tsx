import type { Metadata } from "next";
import {
  listJoinableOrganizations,
  listOrganizationsForUser,
  listPendingInvitationsForEmail,
} from "@omniralph/db";
import { redirect } from "next/navigation";
import { SIGN_IN_PATH } from "@/lib/auth/routes";
import { getCurrentUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { OnboardingView } from "./onboarding-view";

export const metadata: Metadata = { title: "Organizations · Omniralph" };

/**
 * Where signed-in users without an active organization land (and where anyone can
 * create another one): create an organization, answer invitations, join an
 * organization open to their email domain, or pick one they already belong to.
 */
export default async function OnboardingPage() {
  const user = await getCurrentUser();
  if (!user) redirect(SIGN_IN_PATH);
  const db = getDb();
  const [invitations, joinable, memberships] = await Promise.all([
    user.email ? listPendingInvitationsForEmail(db, user.email) : [],
    user.email ? listJoinableOrganizations(db, user.email) : [],
    listOrganizationsForUser(db, user.id),
  ]);

  return (
    <OnboardingView
      hasActiveOrganization={user.organization !== null}
      email={user.email}
      invitations={invitations.map((i) => ({
        id: i.id,
        organizationId: i.organizationId,
        organizationName: i.organizationName,
        role: i.role,
        expiresAt: i.expiresAt.toISOString(),
      }))}
      joinable={joinable.map((o) => ({ id: o.id, name: o.name }))}
      memberships={memberships.map((o) => ({ id: o.id, name: o.name, role: o.role }))}
    />
  );
}
