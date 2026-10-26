import type { Metadata } from "next";
import { FleetView } from "@/screens/fleet/fleet-view";

export const metadata: Metadata = { title: "Fleet · Omniralph" };

/** An agent beside Fleet's table (`src/screens/fleet`); on its own where only one pane fits. */
export default async function FleetAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <FleetView agentId={id} />;
}
