import type { Metadata } from "next";
import { GeneralSettings } from "@/screens/settings/general-settings";
import { SettingsPage } from "@/screens/settings/settings-page";

export const metadata: Metadata = { title: "General · Omniralph" };

/**
 * Organization › General: the organization's name and leaving it. Every member sees it;
 * admins rename it.
 */
export default function GeneralSettingsPage() {
  return (
    <SettingsPage title="General">
      <GeneralSettings />
    </SettingsPage>
  );
}
