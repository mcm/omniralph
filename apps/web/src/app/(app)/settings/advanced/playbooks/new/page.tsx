import type { Metadata } from "next";
import { NewPlaybookEditor } from "@/screens/settings/playbooks/playbook-editor";

export const metadata: Metadata = { title: "New playbook · Omniralph" };

/** Advanced › Playbooks › New playbook (admins). */
export default function NewPlaybookPage() {
  return <NewPlaybookEditor />;
}
