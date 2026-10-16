import type { Metadata } from "next";
import { HarnessDetailView } from "../harness-detail-view";

export const metadata: Metadata = { title: "Harness host tools · Omniralph" };

export default function HarnessHostToolsPage() {
  return <HarnessDetailView tab="host-tools" />;
}
