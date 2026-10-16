import type { Metadata } from "next";
import { HarnessSettingsView } from "../harness-settings-view";

export const metadata: Metadata = { title: "Host tools · Harness defaults · Omniralph" };

/** Settings › Harness defaults › Host tools (admins): the organization's host tool catalog. */
export default function HostToolsSettingsPage() {
  return <HarnessSettingsView tab="host-tools" />;
}
