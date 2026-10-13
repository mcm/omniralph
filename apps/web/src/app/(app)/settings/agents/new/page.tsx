import type { Metadata } from "next";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { loadHarnessChoices } from "@/lib/harnesses/editor-choices";
import { AgentForm } from "../agent-form";

export const metadata: Metadata = { title: "New agent · Omniralph" };

/** Creates one of the organization's agents. Admins only. */
export default async function NewAgentPage() {
  const user = await requirePageUser("admin");
  const choices = await loadHarnessChoices(getDb(), user.organization.id);
  return <AgentForm agent={null} choices={choices} />;
}
