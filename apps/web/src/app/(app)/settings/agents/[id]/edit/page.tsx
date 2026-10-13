import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getAgentDefinition } from "@/lib/definitions";
import { loadHarnessChoices } from "@/lib/harnesses/editor-choices";
import { AgentForm } from "../../agent-form";
import { decodeId } from "../decode-id";

export const metadata: Metadata = { title: "Edit agent · Omniralph" };

/**
 * Edits one of the organization's agents. Admins only; built-ins (read-only)
 * and unknown IDs, including another organization's, are not found.
 */
export default async function EditAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser("admin");
  const id = decodeId((await params).id);
  const db = getDb();
  const agent = await getAgentDefinition(db, user.organization.id, id);
  if (!agent || agent.builtin) notFound();
  const choices = await loadHarnessChoices(db, user.organization.id);
  return <AgentForm agent={agent.definition} choices={choices} />;
}
