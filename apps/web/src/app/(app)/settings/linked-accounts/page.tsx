import type { Metadata } from "next";
import { SettingsPage } from "@/screens/settings/settings-page";

export const metadata: Metadata = { title: "Linked chat accounts · Omniralph" };

/** You › Linked chat accounts: the signed-in user's Slack and Discord accounts. */
export default function LinkedAccountsSettingsPage() {
  return <SettingsPage title="Linked chat accounts" />;
}
