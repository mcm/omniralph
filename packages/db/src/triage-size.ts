/**
 * Work items' t-shirt sizes as triage last decided them: the `outcome.size` of each issue's
 * newest triage run that has an outcome (`triage_runs.last_result`). The Inbox's PRD-ready
 * items and the Backlog show them.
 */
import { TRIAGE_SIZES, type TriageSize } from "@omniralph/shared";
import { sql } from "drizzle-orm";
import type { Database } from "./client.js";

type Queryable = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/** An issue of an organization (Linear issue IDs are per organization's workspace). */
export interface TriageIssueRef {
  organizationId: string;
  trackerIssueId: string;
}

const isTriageSize = (value: unknown): value is TriageSize =>
  typeof value === "string" && (TRIAGE_SIZES as readonly string[]).includes(value);

/** The map key of an issue in `triageSizesOf`'s result. */
export const triageIssueKey = (issue: TriageIssueRef) =>
  `${issue.organizationId}:${issue.trackerIssueId}`;

/**
 * The sizes of issues of any organizations, in one query, by `triageIssueKey`. Every asked
 * issue is in the map: null when no triage of it has an outcome, or the outcome has no
 * valid size.
 */
export async function triageSizesOf(
  db: Queryable,
  issues: readonly TriageIssueRef[],
): Promise<Map<string, TriageSize | null>> {
  const sizes = new Map<string, TriageSize | null>(issues.map((i) => [triageIssueKey(i), null]));
  if (issues.length === 0) return sizes;
  const pairs = sql.join(
    [...sizes.keys()].map((key) => {
      const colon = key.indexOf(":");
      return sql`(${key.slice(0, colon)}::uuid, ${key.slice(colon + 1)})`;
    }),
    sql`, `,
  );
  const result = await db.execute<{
    organization_id: string;
    tracker_issue_id: string;
    size: string | null;
  }>(sql`
    select distinct on (t.organization_id, t.tracker_issue_id) t.organization_id,
      t.tracker_issue_id, t.last_result -> 'outcome' ->> 'size' as size
    from triage_runs t
    where (t.organization_id, t.tracker_issue_id) in (${pairs})
      and jsonb_typeof(t.last_result -> 'outcome') = 'object'
    order by t.organization_id, t.tracker_issue_id, t.created_at desc, t.id desc`);
  for (const row of result.rows) {
    const key = triageIssueKey({
      organizationId: row.organization_id,
      trackerIssueId: row.tracker_issue_id,
    });
    sizes.set(key, isTriageSize(row.size) ? row.size : null);
  }
  return sizes;
}

/**
 * The size of each of the organization's Linear issues (by Linear issue ID) from its newest
 * triage run with an outcome, in one query. Every asked issue is in the map: null when no
 * triage of it has an outcome, or the outcome has no valid size.
 */
export async function latestTriageSizes(
  db: Queryable,
  organizationId: string,
  issueIds: readonly string[],
): Promise<Map<string, TriageSize | null>> {
  const unique = [...new Set(issueIds)];
  const sizes = await triageSizesOf(
    db,
    unique.map((trackerIssueId) => ({ organizationId, trackerIssueId })),
  );
  return new Map(
    unique.map((id) => [
      id,
      sizes.get(triageIssueKey({ organizationId, trackerIssueId: id })) ?? null,
    ]),
  );
}
