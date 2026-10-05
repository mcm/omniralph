import type { Metadata } from "next";
import { getAnalytics, listAnalyticsRepositories } from "@omniralph/db";
import { analyticsData, parseAnalyticsParams } from "@/lib/analytics/display";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { AnalyticsView } from "./analytics-view";

export const metadata: Metadata = { title: "Analytics · Omniralph" };

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePageUser();
  const db = getDb();
  const repositories = await listAnalyticsRepositories(db);
  const params = parseAnalyticsParams(
    await searchParams,
    repositories.map((r) => r.id),
  );
  const analytics = await getAnalytics(db, {
    days: params.days,
    repositoryId: params.repositoryId ?? undefined,
  });
  return (
    <AnalyticsView
      analytics={analyticsData(analytics)}
      repositories={repositories}
      params={params}
    />
  );
}
