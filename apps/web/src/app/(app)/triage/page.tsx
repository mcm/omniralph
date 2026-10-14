import type { Metadata } from "next";
import { listTriageRuns, TRIAGE_RUN_PAGE_SIZE } from "@omniralph/db";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { parseTriageRunListParams } from "@/lib/triage/display";
import { triageRunRow } from "@/lib/triage/view";
import { TriageRunsView } from "./triage-runs-view";

export const metadata: Metadata = { title: "Triage · Omniralph" };

export default async function TriageRunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser();
  const params = parseTriageRunListParams(await searchParams);
  const page = await listTriageRuns(getDb(), user.organization.id, {
    status: params.status ?? undefined,
    page: params.page,
    pageSize: TRIAGE_RUN_PAGE_SIZE,
  });
  return (
    <TriageRunsView
      runs={page.runs.map(triageRunRow)}
      params={params}
      total={page.total}
      pageSize={page.pageSize}
    />
  );
}
