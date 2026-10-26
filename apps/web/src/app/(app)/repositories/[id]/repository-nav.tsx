"use client";

import { IconGavel, IconServer, IconSettings } from "@tabler/icons-react";
import { PageTabs } from "@/components/page-tabs";

const tabs = [
  { value: "rules", label: "Rules", icon: IconGavel },
  { value: "settings", label: "Review settings", icon: IconSettings },
  { value: "agents", label: "Agents", icon: IconServer },
] as const;

/** A repository page, as its tab and route segment. */
export type RepositoryPage = (typeof tabs)[number]["value"];

/** Tabs between a repository's pages. */
export function RepositoryNav({
  repositoryId,
  current,
}: {
  repositoryId: string;
  current: RepositoryPage;
}) {
  return (
    <PageTabs
      label="Repository pages"
      current={current}
      tabs={tabs.map((tab) => ({ ...tab, href: `/repositories/${repositoryId}/${tab.value}` }))}
    />
  );
}
