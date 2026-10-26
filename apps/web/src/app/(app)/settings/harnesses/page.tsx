import type { Metadata } from "next";
import { HarnessSettingsView } from "./harness-settings-view";

export const metadata: Metadata = { title: "Harness defaults · Omniralph" };

/** Settings › Harness defaults (admins): the concurrency and version every harness gets. */
export default function HarnessSettingsPage() {
  return <HarnessSettingsView tab="defaults" />;
}
