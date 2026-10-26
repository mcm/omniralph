import type { Metadata } from "next";
import { SettingsPage } from "@/screens/settings/settings-page";

export const metadata: Metadata = { title: "Add connection · Omniralph" };

/** Connections › Add connection: connect a code host, tracker or chat workspace. */
export default function AddConnectionSettingsPage() {
  return <SettingsPage title="Add connection" />;
}
