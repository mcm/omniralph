"use client";

import { IconAdjustments, IconTool } from "@tabler/icons-react";
import { PageTabs } from "@/components/page-tabs";

const tabs = [
  { value: "defaults", label: "Defaults", icon: IconAdjustments, href: "/settings/agent-defaults" },
  {
    value: "host-tools",
    label: "Host tools",
    icon: IconTool,
    href: "/settings/agent-defaults/host-tools",
  },
] as const;

/** A Settings › Agent defaults tab. */
export type AgentSettingsTab = (typeof tabs)[number]["value"];

export const AGENT_SETTINGS_TAB_LABELS: Record<AgentSettingsTab, string> = {
  defaults: "Defaults",
  "host-tools": "Host tools",
};

/** Tabs between the organization's agent defaults and its host tool catalog. */
export function AgentSettingsNav({ current }: { current: AgentSettingsTab }) {
  return <PageTabs label="Agent defaults pages" current={current} tabs={tabs} />;
}
