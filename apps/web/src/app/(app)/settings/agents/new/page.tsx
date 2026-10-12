import type { Metadata } from "next";
import { requirePageUser } from "@/lib/auth/session";
import { AgentForm } from "../agent-form";

export const metadata: Metadata = { title: "New agent · Omniralph" };

/** Creates one of the organization's agents. Admins only. */
export default async function NewAgentPage() {
  await requirePageUser("admin");
  return <AgentForm agent={null} />;
}
