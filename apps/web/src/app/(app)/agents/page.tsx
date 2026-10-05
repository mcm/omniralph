import type { Metadata } from "next";
import { listAgentOverview } from "@omniralph/db";
import { agentRow } from "@/lib/agents/rows";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { AgentsView } from "./agents-view";

export const metadata: Metadata = { title: "Agents · Omniralph" };

export default async function AgentsPage() {
  await requirePageUser();
  const now = new Date();
  const agents = await listAgentOverview(getDb());
  return <AgentsView agents={agents.map((agent) => agentRow(agent, now))} now={now.getTime()} />;
}
