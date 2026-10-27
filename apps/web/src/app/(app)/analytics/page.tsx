import type { Metadata } from "next";
import { Suspense } from "react";
import { getOrganizationScope, requirePageUser } from "@/lib/auth/session";
import { AnalyticsView } from "./analytics-view";

export const metadata: Metadata = { title: "Analytics · Omniralph" };

/**
 * Analytics: stories, reviews, attempt success and tokens over 7, 30 or 90 days, for the
 * active organization or all of the user's ("All organizations"). Any member may read it.
 */
export default async function AnalyticsPage() {
  const user = await requirePageUser();
  const scope = await getOrganizationScope();
  return (
    <Suspense>
      <AnalyticsView scope={scope?.kind === "all" ? "all" : user.organization.id} />
    </Suspense>
  );
}
