"use client";

import Link from "next/link";
import type { ComponentType } from "react";
import { Tabs, TabsList, TabsTrigger } from "@iamthemcmaster/ui";

/** One tab of a page: its route and how the strip shows it. */
export interface PageTab {
  value: string;
  label: string;
  href: string;
  icon: ComponentType<{ size?: number }>;
}

/**
 * Tabs between the pages of one resource (a repository, a harness, a settings page). Each tab is
 * a link, so leaving a tab with unsaved settings asks first (the unsaved-changes guard watches
 * link clicks). The strip scrolls on its own when the tabs don't fit.
 */
export function PageTabs({
  label,
  tabs,
  current,
}: {
  /** The tab list's accessible name, e.g. "Harness pages". */
  label: string;
  tabs: readonly PageTab[];
  current: string;
}) {
  return (
    <Tabs variant="underline" value={current}>
      <TabsList aria-label={label} className="page-tabs">
        {tabs.map(({ value, label: tabLabel, href, icon: Icon }) => (
          <TabsTrigger key={value} value={value} asChild>
            <Link href={href}>
              <Icon size={14} />
              {tabLabel}
            </Link>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
