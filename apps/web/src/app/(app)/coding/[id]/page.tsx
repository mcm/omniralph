import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntegration, getRunDetail } from "@omniralph/db";
import { z } from "zod";
import { enterResourceOrganization } from "@/lib/auth/resource-page";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { organizationDefinitions } from "@/lib/definitions";
import { ralphRunDetailView } from "@/lib/ralph/history";
import { RalphRunDetailView } from "./ralph-run-detail-view";

export const metadata: Metadata = { title: "Coding task · Omniralph" };

export default async function RalphRunPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  await enterResourceOrganization(user, "ralph_run", id, `/coding/${id}`);
  const db = getDb();
  const [detail, integration] = await Promise.all([
    getRunDetail(db, user.organization.id, id),
    getIntegration(db, user.organization.id, "linear"),
  ]);
  if (!detail) notFound();
  const run = await ralphRunDetailView(detail, organizationDefinitions(db, user.organization.id));
  return (
    <RalphRunDetailView
      run={run}
      linearConnected={integration !== null}
      year={new Date().getFullYear()}
    />
  );
}
