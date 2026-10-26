import type { Metadata } from "next";
import { AgentDetailView } from "../agent-detail-view";

export const metadata: Metadata = { title: "Agent settings · Omniralph" };

export default function AgentSettingsPage() {
  return <AgentDetailView tab="settings" />;
}
