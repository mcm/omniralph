import type { Metadata } from "next";
import { NewAgentView } from "../agent-editor-view";

export const metadata: Metadata = { title: "New agent · Omniralph" };

/** Creates one of the organization's agents. Admins only. */
export default function NewAgentPage() {
  return <NewAgentView />;
}
