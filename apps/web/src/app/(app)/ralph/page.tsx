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

export const metadata: Metadata = { title: "Ralph runs · Omniralph" };

export default async function RalphRunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePageUser();
  const db = getDb();
  const params = parseRalphRunListParams(await searchParams);
  const [page, repositories, integration] = await Promise.all([
    listRuns(db, {
      status: params.status ?? undefined,
      repositoryId: params.repositoryId ?? undefined,
      page: params.page,
      pageSize: RALPH_RUN_PAGE_SIZE,
    }),
    listRalphRunRepositories(db),
    getIntegration(db, "linear"),
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
