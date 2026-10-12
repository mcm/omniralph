import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { deriveHarnessRequirements, deriveTaskRequirements } from "@omniralph/tasks";
import { hasRole } from "@/lib/auth/roles";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getAgentDefinition, getTaskDefinition } from "@/lib/definitions";
import { findTaskReferrers } from "@/lib/definitions/referrers";
import { decodeId } from "../../agents/[id]/decode-id";
import { TaskDetailView } from "./task-detail-view";

export const metadata: Metadata = { title: "Task · Omniralph" };

/**
 * One task definition of the organization (a built-in or one of its rows),
 * what its runs need and what uses it. Unknown IDs, including another
 * organization's, are not found.
 */
export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser("member");
  const id = decodeId((await params).id);
  const db = getDb();
  const organizationId = user.organization.id;
  const task = await getTaskDefinition(db, organizationId, id);
  if (!task) notFound();
  const { definition } = task;

  const [agent, prDescriptionTask, referrers] = await Promise.all([
    getAgentDefinition(db, organizationId, definition.agentId),
    definition.prDescriptionTaskId
      ? getTaskDefinition(db, organizationId, definition.prDescriptionTaskId)
      : null,
    findTaskReferrers(db, organizationId, definition.id),
  ]);

  return (
    <TaskDetailView
      isAdmin={hasRole(user, "admin")}
      task={definition}
      builtin={task.builtin}
      agentName={agent?.definition.name ?? null}
      prDescriptionTaskName={prDescriptionTask?.definition.name ?? null}
      // The version is stored with a custom task when it was saved (a built-in's is derived from
      // the code); installables and host tools follow the agent as it is now, as its runs' jobs do.
      requirements={{
        ...(task.requirements ?? deriveTaskRequirements(definition)),
        ...deriveHarnessRequirements(definition, agent?.definition),
      }}
      referrers={referrers}
    />
  );
}
