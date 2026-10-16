import type { Metadata } from "next";
import { RalphRunsView } from "./ralph-runs-view";

export const metadata: Metadata = { title: "Coding tasks · Omniralph" };

export default function RalphRunsPage() {
  return <RalphRunsView />;
}
