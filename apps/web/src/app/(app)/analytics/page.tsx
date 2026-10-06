import type { Metadata } from "next";
import { getAnalytics, getRalphAnalytics, listAnalyticsRepositories } from "@omniralph/db";
import { analyticsData, parseAnalyticsParams, ralphAnalyticsData } from "@/lib/analytics/display";
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
  const filter = { days: params.days, repositoryId: params.repositoryId ?? undefined };
  const [analytics, ralph] = await Promise.all([
    getAnalytics(db, filter),
    getRalphAnalytics(db, filter),
  ]);
  return (
    <AnalyticsView
      analytics={analyticsData(analytics)}
      ralph={ralphAnalyticsData(ralph)}
      repositories={repositories}
      params={params}
    />
  );
}
