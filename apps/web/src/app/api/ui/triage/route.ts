import { listTriageRuns, TRIAGE_RUN_PAGE_SIZE } from "@omniralph/db";
import { z } from "zod";
import { apiHandler } from "@/lib/api/handler";
import type { TriageRunList } from "@/lib/api/triage";
import { getDb } from "@/lib/db";
import { parseTriageRunListParams } from "@/lib/triage/display";
import { triageRunRow } from "@/lib/triage/view";

const listQuery = z.object({ status: z.string().optional(), page: z.string().optional() });

/**
 * A page of the active organization's triage runs, newest first, filtered by status (an
 * unknown one is ignored): the Triage page, polled.
 */
export const GET = apiHandler(
  { query: listQuery },
  async ({ user, query }): Promise<TriageRunList> => {
    const params = parseTriageRunListParams(query);
    const page = await listTriageRuns(getDb(), user.organization.id, {
      status: params.status ?? undefined,
      page: params.page,
      pageSize: TRIAGE_RUN_PAGE_SIZE,
    });
    return {
      runs: page.runs.map(triageRunRow),
      page: params.page,
      pageSize: page.pageSize,
      total: page.total,
    };
  },
);
