import type { Metadata } from "next";
import { SettingsPage } from "@/screens/settings/settings-page";

export const metadata: Metadata = { title: "Members · Omniralph" };

/** Organization › Members: who belongs to the organization, invitations and joining by domain. */
export default function MembersSettingsPage() {
  return <SettingsPage title="Members" />;
}
