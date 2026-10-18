import type { Metadata } from "next";
import { RoutingSettingsView } from "./routing-settings-view";

export const metadata: Metadata = { title: "Routing · Omniralph" };

/**
 * The organization's routing rules: which repository an issue builds in. Every member sees
 * them; admins edit them.
 */
export default function RoutingSettingsPage() {
  return <RoutingSettingsView />;
}
