import type { Metadata } from "next";
import { RalphRunDetailView } from "./ralph-run-detail-view";

export const metadata: Metadata = { title: "Coding task · Omniralph" };

export default function RalphRunPage() {
  return <RalphRunDetailView />;
}
