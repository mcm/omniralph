"use client";

import { useRouter } from "next/navigation";
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
  { value: "reviews", label: "Reviews", icon: IconHistory },
  { value: "rules", label: "Rules", icon: IconGavel },
  { value: "settings", label: "Review settings", icon: IconSettings },
  { value: "coding-tasks", label: "Coding Tasks", icon: IconCode, adminOnly: true },
  { value: "harnesses", label: "Harnesses", icon: IconServer },
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
  const isAdmin = useCurrentUser().role === "admin";
  return (
    <Tabs
      variant="underline"
      value={current}
      onValueChange={(value) => router.push(`/repositories/${repositoryId}/${value}`)}
    >
      <TabsList aria-label="Repository pages" className="repository-tabs">
        {tabs
          .filter((tab) => isAdmin || !("adminOnly" in tab))
          .map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value}>
              <Icon size={14} />
              {label}
            </TabsTrigger>
          ))}
      </TabsList>
    </Tabs>
  );
}
