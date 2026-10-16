import type { Metadata } from "next";
import { EditAgentView } from "../../agent-editor-view";

export const metadata: Metadata = { title: "Edit agent · Omniralph" };

/**
 * Edits one of the organization's agents. Admins only; built-ins (read-only) and unknown IDs,
 * including another organization's, are not found.
 */
export default function EditAgentPage() {
  return <EditAgentView />;
}
