import type { Metadata } from "next";
import { LinkedAccountsSettings } from "@/screens/settings/linked-accounts-settings";
import { SettingsPage } from "@/screens/settings/settings-page";

export const metadata: Metadata = { title: "Linked chat accounts · Omniralph" };

/**
 * You › Linked chat accounts: the signed-in user's Slack and Discord accounts, in every
 * organization. Every member's own.
 */
export default function LinkedAccountsSettingsPage() {
  return (
    <SettingsPage title="Linked chat accounts">
      <LinkedAccountsSettings />
    </SettingsPage>
  );
}
