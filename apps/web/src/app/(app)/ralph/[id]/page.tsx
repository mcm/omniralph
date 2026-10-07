import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getIntegration, getRunDetail } from "@omniralph/db";
import { z } from "zod";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { ralphRunDetailView } from "@/lib/ralph/history";
import { RalphRunDetailView } from "./ralph-run-detail-view";

export const metadata: Metadata = { title: "Ralph run · Omniralph" };

export default async function RalphRunPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const db = getDb();
  // Another organization's run is not found.
  const [detail, integration] = await Promise.all([
    getRunDetail(db, user.organization.id, id),
    getIntegration(db, user.organization.id, "linear"),
  ]);
  if (!detail) notFound();
  return (
    <RalphRunDetailView run={ralphRunDetailView(detail)} linearConnected={integration !== null} />
  );
}
