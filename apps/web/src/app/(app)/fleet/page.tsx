import type { Metadata } from "next";
import { FleetView } from "@/screens/fleet/fleet-view";

export const metadata: Metadata = { title: "Fleet · Omniralph" };

/** Fleet: the agents of the user's scope, beside the first one's panel when both fit (`src/screens/fleet`). */
export default function FleetPage() {
  return <FleetView />;
}
