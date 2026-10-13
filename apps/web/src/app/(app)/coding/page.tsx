import type { Metadata } from "next";
import {
  getIntegration,
  listRalphRunRepositories,
  listRuns,
  RALPH_RUN_PAGE_SIZE,
} from "@omniralph/db";
import { requirePageUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { parseRalphRunListParams } from "@/lib/ralph/display";
import { ralphRunRow } from "@/lib/ralph/history";
import { RalphRunsView } from "./ralph-runs-view";

export const metadata: Metadata = { title: "Coding tasks · Omniralph" };

export default async function RalphRunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser();
  const organizationId = user.organization.id;
  const db = getDb();
  const params = parseRalphRunListParams(await searchParams);
  const [page, repositories, integration] = await Promise.all([
    listRuns(db, organizationId, {
      status: params.status ?? undefined,
      repositoryId: params.repositoryId ?? undefined,
      page: params.page,
      pageSize: RALPH_RUN_PAGE_SIZE,
    }),
    listRalphRunRepositories(db, organizationId),
    getIntegration(db, organizationId, "linear"),
  ]);
  return (
    <RalphRunsView
      runs={page.runs.map(ralphRunRow)}
      repositories={repositories}
      params={params}
      total={page.total}
      pageSize={page.pageSize}
      linearConnected={integration !== null}
    />
  );
}
