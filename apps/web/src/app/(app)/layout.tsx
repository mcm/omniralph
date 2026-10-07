import { listOrganizationsForUser } from "@omniralph/db";
import { AppShell } from "@/components/app-shell";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

/**
 * Signed-in area: every page below requires a session and an active organization
 * (members and admins); users without one are sent to onboarding.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  const organizations = await listOrganizationsForUser(getDb(), user.id);
  return (
    <AppShell user={user} organizations={organizations.map((o) => ({ id: o.id, name: o.name }))}>
      {children}
    </AppShell>
  );
}
