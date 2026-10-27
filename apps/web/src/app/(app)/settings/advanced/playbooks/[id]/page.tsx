import type { Metadata } from "next";
import { decodeId } from "@/lib/api/playbooks";
import { PlaybookDetail } from "@/screens/settings/playbooks/playbook-detail";

export const metadata: Metadata = { title: "Playbook · Omniralph" };

/** Advanced › Playbooks › one playbook (`builtin:` IDs arrive URI-encoded). */
export default async function PlaybookSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PlaybookDetail id={decodeId(id)} />;
}
