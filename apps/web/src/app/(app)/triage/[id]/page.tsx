import type { Metadata } from "next";
import { TriageRunDetailView } from "./triage-run-detail-view";

export const metadata: Metadata = { title: "Triage run · Omniralph" };

export default function TriageRunPage() {
  return <TriageRunDetailView />;
}
