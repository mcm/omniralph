import type { Metadata } from "next";
import { AgentSettingsView } from "./agent-settings-view";

export const metadata: Metadata = { title: "Agent defaults · Omniralph" };

/** Settings › Agent defaults (admins): the concurrency and version every agent gets. */
export default function AgentSettingsPage() {
  return <AgentSettingsView tab="defaults" />;
}
