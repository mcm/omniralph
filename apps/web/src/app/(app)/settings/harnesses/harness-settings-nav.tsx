"use client";

import { IconAdjustments, IconTool } from "@tabler/icons-react";
import { PageTabs } from "@/components/page-tabs";

const tabs = [
  { value: "defaults", label: "Defaults", icon: IconAdjustments, href: "/settings/harnesses" },
  {
    value: "host-tools",
    label: "Host tools",
    icon: IconTool,
    href: "/settings/harnesses/host-tools",
  },
] as const;

/** A Settings › Harness defaults tab. */
export type HarnessSettingsTab = (typeof tabs)[number]["value"];

export const HARNESS_SETTINGS_TAB_LABELS: Record<HarnessSettingsTab, string> = {
  defaults: "Defaults",
  "host-tools": "Host tools",
};

/** Tabs between the organization's harness defaults and its host tool catalog. */
export function HarnessSettingsNav({ current }: { current: HarnessSettingsTab }) {
  return <PageTabs label="Harness defaults pages" current={current} tabs={tabs} />;
}
