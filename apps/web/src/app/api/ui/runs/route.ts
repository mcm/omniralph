import {
  getIntegration,
  listRalphRunRepositories,
  listRuns,
  RALPH_RUN_PAGE_SIZE,
} from "@omniralph/db";
import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import type { RunList } from "@/lib/api/runs";
import { getDb } from "@/lib/db";
import { parseRalphRunListParams } from "@/lib/ralph/display";
import { ralphRunRow } from "@/lib/ralph/history";

const listQuery = z.object({
  status: z.string().optional(),
  repository: z.string().optional(),
  page: z.string().optional(),
});

/**
 * A page of the active organization's coding runs, newest first, filtered by status and
 * repository (unknown values are ignored), with the repositories to filter by: the Coding
 * tasks page, polled.
 */
export const GET = apiHandler({ query: listQuery }, async ({ user, query }): Promise<RunList> => {
  const db = getDb();
  const organizationId = user.organization.id;
  const params = parseRalphRunListParams(query);
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
  return {
    runs: page.runs.map(ralphRunRow),
    repositories: repositories.map(({ id, provider, fullPath }) => ({ id, provider, fullPath })),
    page: params.page,
    pageSize: page.pageSize,
    total: page.total,
    linearConnected: integration !== null,
  };
});
