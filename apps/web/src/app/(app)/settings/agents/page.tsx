import type { Metadata } from "next";
import { hasRole } from "@/lib/auth/roles";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { listAgentDefinitions } from "@/lib/definitions";
import { AgentsView } from "./agents-view";

export const metadata: Metadata = { title: "Agents · Omniralph" };

/** The organization's agent definitions: built-ins first, then its own. Every member may look. */
export default async function AgentsPage() {
  const user = await requirePageUser("member");
  const agents = await listAgentDefinitions(getDb(), user.organization.id);

  return (
    <AgentsView
      isAdmin={hasRole(user, "admin")}
      agents={agents.map(({ definition, builtin }) => ({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        builtin,
        taskTypes: definition.taskTypes,
        model: definition.model,
      }))}
    />
  );
}
