import type { Metadata } from "next";
import { OrganizationSettingsView } from "./organization-settings-view";

export const metadata: Metadata = { title: "Organization · Omniralph" };

/**
 * Settings of the active organization. Every member sees its members and email
 * domains; admins also see pending invitations and can change everything.
 */
export default function OrganizationSettingsPage() {
  return <OrganizationSettingsView />;
}
