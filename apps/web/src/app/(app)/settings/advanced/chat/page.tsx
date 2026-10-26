import type { Metadata } from "next";
import { SettingsPage } from "@/screens/settings/settings-page";

export const metadata: Metadata = { title: "Chat channel overrides · Omniralph" };

/** Advanced › Chat channel overrides: the playbooks chat runs per channel. Opens by URL whatever the user's "Show advanced settings". */
export default function ChatOverridesSettingsPage() {
  return <SettingsPage title="Chat channel overrides" />;
}
