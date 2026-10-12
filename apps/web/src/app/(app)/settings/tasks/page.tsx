import type { Metadata } from "next";
import { hasRole } from "@/lib/auth/roles";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { listAgentDefinitions, listTaskDefinitions } from "@/lib/definitions";
import { TasksView } from "./tasks-view";

export const metadata: Metadata = { title: "Tasks · Omniralph" };

/** The organization's task definitions, grouped by task type. Every member may look. */
export default async function TasksPage() {
  const user = await requirePageUser("member");
  const db = getDb();
  const [tasks, agents] = await Promise.all([
    listTaskDefinitions(db, user.organization.id),
    listAgentDefinitions(db, user.organization.id),
  ]);
  const agentNames = new Map(agents.map(({ definition }) => [definition.id, definition.name]));

  return (
    <TasksView
      isAdmin={hasRole(user, "admin")}
      tasks={tasks.map(({ definition, builtin }) => ({
        id: definition.id,
        name: definition.name,
        description: definition.description,
        builtin,
        taskType: definition.taskType,
        agentId: definition.agentId,
        agentName: agentNames.get(definition.agentId) ?? null,
        triggers: definition.triggers,
        sink: definition.sink,
        pool: definition.pool,
      }))}
    />
  );
}
