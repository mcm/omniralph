"use client";

import { useRouter } from "next/navigation";
import { Tabs, TabsList, TabsTrigger } from "@iamthemcmaster/ui";
import { IconHistory, IconListCheck, IconSettings } from "@tabler/icons-react";

const tabs = [
  { value: "reviews", label: "Reviews", icon: IconHistory },
  { value: "rules", label: "Rules", icon: IconListCheck },
  { value: "settings", label: "Settings", icon: IconSettings },
] as const;

/** Tabs between a repository's pages. */
export function RepositoryNav({
  repositoryId,
  current,
}: {
  repositoryId: string;
  current: (typeof tabs)[number]["value"];
}) {
  const router = useRouter();
  return (
    <Tabs
      variant="underline"
      value={current}
      onValueChange={(value) => router.push(`/repositories/${repositoryId}/${value}`)}
    >
      <TabsList aria-label="Repository pages">
        {tabs.map(({ value, label, icon: Icon }) => (
          <TabsTrigger key={value} value={value}>
            <Icon size={14} />
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
