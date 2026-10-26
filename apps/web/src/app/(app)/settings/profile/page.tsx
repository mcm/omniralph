import type { Metadata } from "next";
import { SettingsPage } from "@/screens/settings/settings-page";

export const metadata: Metadata = { title: "Profile & theme · Omniralph" };

/** You › Profile & theme: the signed-in user's own display preferences. */
export default function ProfileSettingsPage() {
  return <SettingsPage title="Profile & theme" />;
}
