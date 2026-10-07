import type { Metadata } from "next";
import { DESIRED_AGENT_VERSION_KEY, getAppSetting } from "@omniralph/db";
import { AGENT_PACKAGE } from "@omniralph/shared";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { AgentSettingsView } from "./agent-settings-view";

export const metadata: Metadata = { title: "Agent settings · Omniralph" };

export default async function AgentSettingsPage() {
  const admin = await requirePageUser("admin");
  const setting = await getAppSetting(getDb(), admin.organization.id, DESIRED_AGENT_VERSION_KEY);
  return (
    <AgentSettingsView
      desiredVersion={typeof setting?.value === "string" ? setting.value : null}
      updatedAt={setting?.updatedAt.toISOString() ?? null}
      packageName={AGENT_PACKAGE}
    />
  );
}
