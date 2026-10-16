import type { Metadata } from "next";
import { HarnessDetailView } from "../harness-detail-view";

export const metadata: Metadata = { title: "Harness installables · Omniralph" };

export default function HarnessInstallablesPage() {
  return <HarnessDetailView tab="installables" />;
}
