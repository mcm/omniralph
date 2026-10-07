import type { Metadata } from "next";
import {
  getOrganization,
  listMembers,
  listOrganizationDomains,
  listPendingInvitationsForOrganization,
} from "@omniralph/db";
import { notFound } from "next/navigation";
import { hasRole } from "@/lib/auth/roles";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { OrganizationSettingsView } from "./organization-settings-view";

export const metadata: Metadata = { title: "Organization · Omniralph" };

/**
 * Settings of the active organization. Every member sees its members and email
 * domains; admins also see pending invitations and can change everything.
 */
export default async function OrganizationSettingsPage() {
  const user = await requirePageUser("member");
  const isAdmin = hasRole(user, "admin");
  const db = getDb();
  const organizationId = user.organization.id;
  const [organization, members, domains, invitations] = await Promise.all([
    getOrganization(db, organizationId),
    listMembers(db, organizationId),
    listOrganizationDomains(db, organizationId),
    isAdmin ? listPendingInvitationsForOrganization(db, organizationId) : [],
  ]);
  if (!organization) notFound();

  return (
    <OrganizationSettingsView
      isAdmin={isAdmin}
      currentUserId={user.id}
      organization={{ name: organization.name, allowDomainJoin: organization.allowDomainJoin }}
      domains={domains}
      members={members.map((m) => ({
        id: m.userId,
        name: m.name,
        email: m.email,
        image: m.image,
        role: m.role,
        joinedAt: m.createdAt.toISOString(),
      }))}
      invitations={invitations.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        createdAt: i.createdAt.toISOString(),
        expiresAt: i.expiresAt.toISOString(),
      }))}
    />
  );
}
