import type { Metadata } from "next";
import { HarnessDetailView } from "./harness-detail-view";

export const metadata: Metadata = { title: "Harness · Omniralph" };

export default function HarnessPage() {
  return <HarnessDetailView tab="overview" />;
}
