import type { Metadata } from "next";
import { Suspense } from "react";
import { SettingsLayoutView } from "@/screens/settings/settings-layout-view";

export const metadata: Metadata = { title: "Settings · Omniralph" };

/**
 * Settings: one area for everything an organization configures, with its own section nav
 * beside the open page (`src/screens/settings`). Every member sees every page; admins edit.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <SettingsLayoutView>{children}</SettingsLayoutView>
    </Suspense>
  );
}
