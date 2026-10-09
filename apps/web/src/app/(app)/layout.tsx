import { listOrganizationsForUser } from "@omniralph/db";
import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { ORGANIZATION_COOKIE } from "@/lib/auth/routes";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

/**
 * Signed-in area: every page below requires a session and an active organization
 * (members and admins); users without one are sent to onboarding.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  const organizations = await listOrganizationsForUser(getDb(), user.id);
  const organizationCookie = (await cookies()).get(ORGANIZATION_COOKIE)?.value ?? null;
  return (
    <AppShell
      user={user}
      organizations={organizations.map((o) => ({ id: o.id, name: o.name }))}
      organizationCookie={organizationCookie}
    >
      {children}
    </AppShell>
  );
}
