import type { Metadata } from "next";
import { SettingsPage } from "@/screens/settings/settings-page";

export const metadata: Metadata = { title: "Playbooks · Omniralph" };

/** Advanced › Playbooks: the organization's playbooks. Opens by URL whatever the user's "Show advanced settings". */
export default function PlaybooksSettingsPage() {
  return <SettingsPage title="Playbooks" />;
}
