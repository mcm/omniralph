import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasRole } from "@/lib/auth/roles";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getAgentDefinition, listTaskDefinitions } from "@/lib/definitions";
import { AgentDetailView } from "./agent-detail-view";

export const metadata: Metadata = { title: "Agent · Omniralph" };

/** The route segment as an ID (links encode the colon of `builtin:` IDs); malformed escapes match nothing. */
function decodeId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * One agent definition of the organization (a built-in or one of its rows)
 * and the tasks that run on it. Unknown IDs, including another
 * organization's, are not found.
 */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser("member");
  const id = decodeId((await params).id);
  const db = getDb();
  const [agent, tasks] = await Promise.all([
    getAgentDefinition(db, user.organization.id, id),
    listTaskDefinitions(db, user.organization.id),
  ]);
  if (!agent) notFound();

  return (
    <AgentDetailView
      isAdmin={hasRole(user, "admin")}
      agent={agent.definition}
      builtin={agent.builtin}
      tasks={tasks
        .filter((task) => task.definition.agentId === agent.definition.id)
        .map(({ definition, builtin }) => ({
          id: definition.id,
          name: definition.name,
          taskType: definition.taskType,
          builtin,
        }))}
    />
  );
}
