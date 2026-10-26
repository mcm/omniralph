"use client";

import { IconActivity, IconPackage, IconSettings, IconTool } from "@tabler/icons-react";
import { PageTabs } from "@/components/page-tabs";
import { AGENT_TABS, agentTabHref, type AgentTab } from "./agent-tabs";

const ICONS = {
  overview: IconActivity,
  settings: IconSettings,
  installables: IconPackage,
  "host-tools": IconTool,
} satisfies Record<AgentTab, unknown>;

/** Tabs between an agent's pages. */
export function AgentNav({ agentId, current }: { agentId: string; current: AgentTab }) {
  return (
    <PageTabs
      label="Agent pages"
      current={current}
      tabs={AGENT_TABS.map((tab) => ({
        ...tab,
        icon: ICONS[tab.value],
        href: agentTabHref(agentId, tab.value),
      }))}
    />
  );
}
