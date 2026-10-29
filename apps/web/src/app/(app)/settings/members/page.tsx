import type { Metadata } from "next";
import { MembersSettings } from "@/screens/settings/members-settings";
import { SettingsPage } from "@/screens/settings/settings-page";

export const metadata: Metadata = { title: "Members · Omniralph" };

/**
 * Organization › Members: who belongs to the organization, invitations and joining by domain.
 * Every member sees the members and domains; admins change them and manage invitations.
 */
export default function MembersSettingsPage() {
  return (
    <SettingsPage title="Members" adminOnly>
      <MembersSettings />
    </SettingsPage>
  );
}
