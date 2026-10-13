"use client";

import Link from "next/link";
import { Tabs, TabsList, TabsTrigger } from "@iamthemcmaster/ui";
import {
  IconCode,
  IconGavel,
  IconHistory,
  IconServer,
  IconSettings,
} from "@tabler/icons-react";
import { useCurrentUser } from "@/components/current-user";

const tabs = [
  { value: "reviews", label: "Reviews", icon: IconHistory, adminOnly: false },
  { value: "rules", label: "Rules", icon: IconGavel, adminOnly: false },
  { value: "settings", label: "Review settings", icon: IconSettings, adminOnly: false },
  { value: "coding", label: "Coding", icon: IconCode, adminOnly: true },
  { value: "harnesses", label: "Harnesses", icon: IconServer, adminOnly: false },
] as const;

/** A repository page, as its tab and route segment. */
export type RepositoryPage = (typeof tabs)[number]["value"];

/**
 * Tabs between a repository's pages. Each tab is a link, so leaving a tab with unsaved
 * settings asks first (the unsaved-changes guard watches link clicks).
 */
export function RepositoryNav({
  repositoryId,
  current,
}: {
  repositoryId: string;
  current: RepositoryPage;
}) {
  const isAdmin = useCurrentUser().role === "admin";
  return (
    <Tabs variant="underline" value={current}>
      <TabsList aria-label="Repository pages" className="repository-tabs">
        {tabs
          .filter((tab) => isAdmin || !tab.adminOnly)
          .map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value} asChild>
              <Link href={`/repositories/${repositoryId}/${value}`}>
                <Icon size={14} />
                {label}
              </Link>
            </TabsTrigger>
          ))}
      </TabsList>
    </Tabs>
  );
}
