"use client";

import { IconActivity, IconPackage, IconSettings, IconTool } from "@tabler/icons-react";
import { PageTabs } from "@/components/page-tabs";
import { HARNESS_TABS, harnessTabHref, type HarnessTab } from "./harness-tabs";

const ICONS = {
  overview: IconActivity,
  settings: IconSettings,
  installables: IconPackage,
  "host-tools": IconTool,
} satisfies Record<HarnessTab, unknown>;

/** Tabs between a harness's pages. */
export function HarnessNav({ agentId, current }: { agentId: string; current: HarnessTab }) {
  return (
    <PageTabs
      label="Harness pages"
      current={current}
      tabs={HARNESS_TABS.map((tab) => ({
        ...tab,
        icon: ICONS[tab.value],
        href: harnessTabHref(agentId, tab.value),
      }))}
    />
  );
}
