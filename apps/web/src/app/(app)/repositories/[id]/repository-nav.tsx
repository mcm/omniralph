"use client";

import { useRouter } from "next/navigation";
import { TabsLine, TabsLineList, TabsLineTrigger } from "@iamthemcmaster/ui";
import { IconHistory, IconSettings } from "@tabler/icons-react";

const tabs = [
  { value: "reviews", label: "Reviews", icon: IconHistory },
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
    <TabsLine
      value={current}
      onValueChange={(value) => router.push(`/repositories/${repositoryId}/${value}`)}
    >
      <TabsLineList aria-label="Repository pages">
        {tabs.map(({ value, label, icon: Icon }) => (
          <TabsLineTrigger key={value} value={value}>
            <Icon size={14} />
            {label}
          </TabsLineTrigger>
        ))}
      </TabsLineList>
    </TabsLine>
  );
}
