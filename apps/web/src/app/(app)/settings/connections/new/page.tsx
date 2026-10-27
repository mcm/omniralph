import type { Metadata } from "next";
import { AddConnectionSettings } from "@/screens/settings/add-connection-settings";

export const metadata: Metadata = { title: "Add connection · Omniralph" };

/**
 * Connections › Add connection: connect a code host, tracker or chat workspace. Linear, Slack
 * and Discord connect flows that didn't connect land here (`?slack=denied`, …).
 */
export default function AddConnectionSettingsPage() {
  return <AddConnectionSettings />;
}
