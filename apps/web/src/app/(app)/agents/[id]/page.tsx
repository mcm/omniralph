import type { Metadata } from "next";
import { AgentDetailView } from "./agent-detail-view";

export const metadata: Metadata = { title: "Agent · Omniralph" };

export default function AgentPage() {
  return <AgentDetailView tab="overview" />;
}
