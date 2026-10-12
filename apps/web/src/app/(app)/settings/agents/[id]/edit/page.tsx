import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { getAgentDefinition } from "@/lib/definitions";
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
  const agent = await getAgentDefinition(getDb(), user.organization.id, id);
  if (!agent || agent.builtin) notFound();
  return <AgentForm agent={agent.definition} />;
}
