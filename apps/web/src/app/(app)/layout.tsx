import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { ORGANIZATION_COOKIE, ORGANIZATION_SCOPE_COOKIE } from "@/lib/auth/routes";
import {
  getOrganizationMemberships,
  getOrganizationScope,
  requirePageUser,
} from "@/lib/auth/session";
import { themePreference } from "@/lib/theme";
import { PageFrame } from "./page-frame";

/**
 * Signed-in area: every page below requires a session and an active organization
 * (members and admins); users without one are sent to onboarding.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  const [organizations, scope, jar] = await Promise.all([
    getOrganizationMemberships(),
    getOrganizationScope(),
    cookies(),
  ]);
  return (
    <AppShell
      user={{
        id: user.id,
        organization: user.organization,
        role: user.role,
        scope: scope?.kind ?? "single",
        organizations,
        name: user.name,
        email: user.email,
        image: user.image,
      }}
      themePreference={themePreference(user.theme)}
      organizationCookie={jar.get(ORGANIZATION_COOKIE)?.value ?? null}
      scopeCookie={jar.get(ORGANIZATION_SCOPE_COOKIE)?.value ?? null}
      showAdvanced={user.showAdvanced}
      sound={user.sound}
    >
      <PageFrame>{children}</PageFrame>
    </AppShell>
  );
}
