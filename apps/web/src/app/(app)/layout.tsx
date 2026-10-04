import { AppShell } from "@/components/app-shell";
import { requirePageUser } from "@/lib/auth/session";

/** Signed-in area: every page below requires a session (members and admins). */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  return <AppShell user={user}>{children}</AppShell>;
}
