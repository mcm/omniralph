import type { Metadata } from "next";
import { RoutingRulesSettings } from "@/screens/settings/routing/routing-rules-settings";
import { SettingsPage } from "@/screens/settings/settings-page";

export const metadata: Metadata = { title: "Routing rules · Omniralph" };

/** Advanced › Routing rules: which repo an issue builds in. Opens by URL whatever the user's "Show advanced settings". */
export default function RoutingRulesSettingsPage() {
  return (
    <SettingsPage title="Routing rules" adminOnly>
      <RoutingRulesSettings />
    </SettingsPage>
  );
}
