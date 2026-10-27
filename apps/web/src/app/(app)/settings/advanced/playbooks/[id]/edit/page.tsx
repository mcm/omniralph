import type { Metadata } from "next";
import { decodeId } from "@/lib/api/playbooks";
import { EditPlaybookEditor } from "@/screens/settings/playbooks/playbook-editor";

export const metadata: Metadata = { title: "Edit playbook · Omniralph" };

/** Advanced › Playbooks › one custom playbook's editor (admins). */
export default async function EditPlaybookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditPlaybookEditor id={decodeId(id)} />;
}
