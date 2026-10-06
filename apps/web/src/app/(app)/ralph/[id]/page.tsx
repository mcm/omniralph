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
  await requirePageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const db = getDb();
  const [detail, integration] = await Promise.all([
    getRunDetail(db, id),
    getIntegration(db, "linear"),
  ]);
  if (!detail) notFound();
  return (
    <RalphRunDetailView run={ralphRunDetailView(detail)} linearConnected={integration !== null} />
  );
}
