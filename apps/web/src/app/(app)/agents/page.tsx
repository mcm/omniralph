import type { Metadata } from "next";
import { getDesiredAgentVersion, listAgentOverview } from "@omniralph/db";
import { agentRow } from "@/lib/agents/rows";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { AgentsView } from "./agents-view";

export const metadata: Metadata = { title: "Agents · Omniralph" };

export default async function AgentsPage() {
  await requirePageUser();
  const now = new Date();
  const db = getDb();
  const [agents, desiredVersion] = await Promise.all([
    listAgentOverview(db),
    getDesiredAgentVersion(db),
  ]);
  return (
    <AgentsView
      agents={agents.map((agent) => agentRow(agent, now, desiredVersion))}
      now={now.getTime()}
    />
  );
}
