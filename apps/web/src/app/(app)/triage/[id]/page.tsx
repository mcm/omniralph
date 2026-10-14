import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTriageRunDetail, listRecentRunActivities } from "@omniralph/db";
import { z } from "zod";
import { enterResourceOrganization } from "@/lib/auth/resource-page";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { triageRunDetailView } from "@/lib/triage/view";
import { TriageRunDetailView } from "./triage-run-detail-view";

export const metadata: Metadata = { title: "Triage run · Omniralph" };

/** Activities of the run's jobs shown, the latest ones. */
const ACTIVITY_LIMIT = 200;

export default async function TriageRunPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePageUser();
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  await enterResourceOrganization(user, "triage_run", id, `/triage/${id}`);
  const db = getDb();
  const detail = await getTriageRunDetail(db, user.organization.id, id);
  if (!detail) notFound();
  const activities = await listRecentRunActivities(
    db,
    user.organization.id,
    detail.jobs.map((job) => job.id),
    ACTIVITY_LIMIT,
  );
  return (
    <TriageRunDetailView
      run={triageRunDetailView(detail, activities)}
      year={new Date().getFullYear()}
    />
  );
}
