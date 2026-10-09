import type { Metadata } from "next";
import { DESIRED_AGENT_VERSION_KEY, getAppSetting } from "@omniralph/db";
import { AGENT_PACKAGE } from "@omniralph/shared";
import { organizationAgentVersion } from "@/lib/agents/desired-version";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { AgentSettingsView } from "./agent-settings-view";

export const metadata: Metadata = { title: "Agent settings · Omniralph" };

export default async function AgentSettingsPage() {
  const admin = await requirePageUser("admin");
  const db = getDb();
  const [setting, resolved] = await Promise.all([
    getAppSetting(db, admin.organization.id, DESIRED_AGENT_VERSION_KEY),
    organizationAgentVersion(db, admin.organization.id),
  ]);
  return (
    <AgentSettingsView
      desiredVersion={typeof setting?.value === "string" ? setting.value : null}
      updatedAt={setting?.updatedAt.toISOString() ?? null}
      latest={
        resolved.tracksLatest
          ? {
              version: resolved.version,
              error: resolved.latestError,
              checkedAt: resolved.latestCheckedAt?.toISOString() ?? null,
            }
          : null
      }
      packageName={AGENT_PACKAGE}
    />
  );
}
