import type { Metadata } from "next";
import { TriageRunsView } from "./triage-runs-view";

export const metadata: Metadata = { title: "Triage · Omniralph" };

export default function TriageRunsPage() {
  return <TriageRunsView />;
}
