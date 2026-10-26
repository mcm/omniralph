import type { Metadata } from "next";
import { AgentDetailView } from "../agent-detail-view";

export const metadata: Metadata = { title: "Agent installables · Omniralph" };

export default function AgentInstallablesPage() {
  return <AgentDetailView tab="installables" />;
}
