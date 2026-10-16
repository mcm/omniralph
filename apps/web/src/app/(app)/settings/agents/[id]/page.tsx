import type { Metadata } from "next";
import { AgentDetailView } from "./agent-detail-view";

export const metadata: Metadata = { title: "Agent · Omniralph" };

/**
 * One agent definition of the organization (a built-in or one of its rows) and the tasks
 * that run on it. Unknown IDs, including another organization's, are not found.
 */
export default function AgentPage() {
  return <AgentDetailView />;
}
