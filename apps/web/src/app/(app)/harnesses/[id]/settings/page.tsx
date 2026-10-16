import type { Metadata } from "next";
import { HarnessDetailView } from "../harness-detail-view";

export const metadata: Metadata = { title: "Harness settings · Omniralph" };

export default function HarnessSettingsPage() {
  return <HarnessDetailView tab="settings" />;
}
