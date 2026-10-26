import type { Metadata } from "next";
import { IntegrationsView } from "./integrations-view";

export const metadata: Metadata = { title: "Integrations · Omniralph" };

/**
 * Settings › Integrations (admins): Linear, Slack and Discord connections and the tasks chat
 * runs. Connect routes redirect back here with their outcome (`?linear=connected`, …).
 */
export default function IntegrationsPage() {
  return <IntegrationsView />;
}
