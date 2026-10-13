"use client";

import { IconCode, IconGavel, IconHistory, IconServer, IconSettings } from "@tabler/icons-react";
import { useCurrentUser } from "@/components/current-user";
import { PageTabs } from "@/components/page-tabs";

const tabs = [
  { value: "reviews", label: "Reviews", icon: IconHistory, adminOnly: false },
  { value: "rules", label: "Rules", icon: IconGavel, adminOnly: false },
  { value: "settings", label: "Review settings", icon: IconSettings, adminOnly: false },
  { value: "coding", label: "Coding", icon: IconCode, adminOnly: true },
  { value: "harnesses", label: "Harnesses", icon: IconServer, adminOnly: false },
] as const;

/** A repository page, as its tab and route segment. */
export type RepositoryPage = (typeof tabs)[number]["value"];

/** Tabs between a repository's pages; Coding is for admins only. */
export function RepositoryNav({
  repositoryId,
  current,
}: {
  repositoryId: string;
  current: RepositoryPage;
}) {
  const isAdmin = useCurrentUser().role === "admin";
  return (
    <PageTabs
      label="Repository pages"
      current={current}
      tabs={tabs
        .filter((tab) => isAdmin || !tab.adminOnly)
        .map((tab) => ({ ...tab, href: `/repositories/${repositoryId}/${tab.value}` }))}
    />
  );
}
