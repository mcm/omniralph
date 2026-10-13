import type { Metadata } from "next";
import { renderHarnessPage } from "../harness-page";

export const metadata: Metadata = { title: "Harness settings · Omniralph" };

export default async function HarnessSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  return renderHarnessPage(params, "settings");
}
