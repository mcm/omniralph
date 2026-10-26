import type { Metadata } from "next";
import { AgentSettingsView } from "../agent-settings-view";

export const metadata: Metadata = { title: "Host tools · Agent defaults · Omniralph" };

/** Settings › Agent defaults › Host tools (admins): the organization's host tool catalog. */
export default function HostToolsSettingsPage() {
  return <AgentSettingsView tab="host-tools" />;
}
