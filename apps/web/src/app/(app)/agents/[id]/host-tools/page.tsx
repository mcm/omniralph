import type { Metadata } from "next";
import { AgentDetailView } from "../agent-detail-view";

export const metadata: Metadata = { title: "Agent host tools · Omniralph" };

export default function AgentHostToolsPage() {
  return <AgentDetailView tab="host-tools" />;
}
