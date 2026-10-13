import type { Metadata } from "next";
import { renderHarnessPage } from "./harness-page";

export const metadata: Metadata = { title: "Harness · Omniralph" };

export default async function HarnessPage({ params }: { params: Promise<{ id: string }> }) {
  return renderHarnessPage(params, "overview");
}
