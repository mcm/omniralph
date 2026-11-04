import type { Metadata } from "next";
import { ApiTokensSettings } from "@/screens/settings/api-tokens-settings";
import { SettingsPage } from "@/screens/settings/settings-page";

export const metadata: Metadata = { title: "API tokens · Omniralph" };

/**
 * You › API tokens: the signed-in member's personal API tokens for the active organization.
 * Every member's own.
 */
export default function ApiTokensSettingsPage() {
  return (
    <SettingsPage title="API tokens">
      <ApiTokensSettings />
    </SettingsPage>
  );
}
