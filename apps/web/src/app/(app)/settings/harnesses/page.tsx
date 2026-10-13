import type { Metadata } from "next";
import { renderHarnessSettings } from "./harness-settings-page";

export const metadata: Metadata = { title: "Harness defaults · Omniralph" };

export default async function HarnessSettingsPage() {
  return renderHarnessSettings("defaults");
}
