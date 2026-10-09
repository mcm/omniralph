import type { Metadata } from "next";
import { listAgentOverview } from "@omniralph/db";
import { organizationAgentVersion } from "@/lib/agents/desired-version";
import { agentRow } from "@/lib/agents/rows";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { AgentsView } from "./agents-view";

export const metadata: Metadata = { title: "Agents · Omniralph" };

export default async function AgentsPage() {
  const user = await requirePageUser();
  const now = new Date();
  const db = getDb();
  const [agents, organizationVersion] = await Promise.all([
    listAgentOverview(db, user.organization.id),
    organizationAgentVersion(db, user.organization.id),
  ]);
  return (
    <AgentsView
      agents={agents.map((agent) =>
        agentRow(agent, now, organizationVersion.version, organizationVersion.tracksLatest),
      )}
      now={now.getTime()}
    />
  );
}
