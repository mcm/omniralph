import { fieldErrors } from "@omniralph/shared";
import { listRunIndex, loadRunListEntries } from "@omniralph/db";
import { apiHandler, ApiRouteError } from "@/lib/api/handler";
import type { RunList } from "@/lib/api/runs";
import { resolveOrganizationScope } from "@/lib/api/scope";
import { getDb } from "@/lib/db";
import { encodeRunCursor, runListQuerySchema, runListSearch, runRow } from "@/lib/runs/list";

/**
 * A page of runs of every kind (epic, request, review, triage, ask), newest first: the
 * active organization's, one of the user's organizations' (`organization=<id>`) or all of
 * them (`organization=all`). Filters combine; an unknown filter value answers 400.
 */
export const GET = apiHandler({}, async ({ user, request }): Promise<RunList> => {
  const parsed = runListQuerySchema.safeParse(runListSearch(new URL(request.url).searchParams));
  if (!parsed.success) {
    const errors = fieldErrors(parsed.error);
    throw new ApiRouteError(
      400,
      Object.values(errors)[0] ?? "The request is invalid.",
      "invalid_request",
      errors,
    );
  }
  const query = parsed.data;
  const organizations = await resolveOrganizationScope(user, query.organization);
  const db = getDb();
  const page = await listRunIndex(db, {
    organizationIds: organizations.map((o) => o.id),
    kinds: query.kind,
    statuses: query.status,
    origins: query.origin,
    repositoryIds: query.repository,
    agentId: query.agent,
    cursor: query.cursor,
    limit: query.limit,
  });
  const byId = new Map(organizations.map((o) => [o.id, o]));
  const entries = await loadRunListEntries(db, page.runs);
  return {
    runs: entries.map((entry) => runRow(entry, byId.get(entry.organizationId)!)),
    nextCursor: page.next && encodeRunCursor(page.next),
  };
});
