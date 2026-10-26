import type { Metadata } from "next";
import { SettingsPage } from "@/screens/settings/settings-page";

export const metadata: Metadata = { title: "General · Omniralph" };

/** Organization › General: the organization's name. Every member sees it; admins change it. */
export default function GeneralSettingsPage() {
  return <SettingsPage title="General" />;
}
