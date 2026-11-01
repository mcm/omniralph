// Backlog rows for the Backlog screen's tests, as `GET /api/ui/backlog` answers them.
import { TEST_ORGANIZATION_ID } from "@/components/query-test-utils";
import type { Backlog } from "@/lib/api/backlog";
import type { WorkItemRow } from "@/lib/api/work-items";

export const BETA_ID = "22222222-2222-4222-8222-222222222222";
export const REPO_PORTAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
export const REPO_WEB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";

/** A Ready to start item of Acme that routes to acme/portal, size M, with overrides. */
export function workItemRow(overrides: Partial<WorkItemRow> = {}): WorkItemRow {
  return {
    id: "linear-issue-412",
    tracker: "linear",
    identifier: "SOC-412",
    title: "Export invoices as CSV",
    url: "https://linear.app/acme/issue/SOC-412",
    organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
    repository: { id: REPO_PORTAL, provider: "gitlab", fullPath: "acme/portal" },
    kind: null,
    size: "M",
    group: "ready",
    blocked: false,
    blockers: [],
    triageRunning: false,
    source: { kind: "project", id: "project-portal", name: "Portal" },
    ...overrides,
  };
}

/** A blocked Ready item with no size that routes to acme/web via the SOC team. */
export const blockedRow = () =>
  workItemRow({
    id: "linear-issue-413",
    identifier: "SOC-413",
    title: "Send invoice reminders",
    url: "https://linear.app/acme/issue/SOC-413",
    repository: { id: REPO_WEB, provider: "github", fullPath: "acme/web" },
    size: null,
    blocked: true,
    blockers: ["SOC-398", "SOC-401"],
    source: { kind: "team", id: "team-soc", name: "SOC" },
  });

/** A Needs refining item with no repo yet (routing asks). */
export const refineRow = () =>
  workItemRow({
    id: "linear-issue-420",
    identifier: "SOC-420",
    title: "Rough idea: dunning emails",
    url: "https://linear.app/acme/issue/SOC-420",
    repository: null,
    size: "S",
    group: "refine",
    source: { kind: "team", id: "team-soc", name: "SOC" },
  });

/** The Backlog answer for `rows`, grouped, with their filter options. */
export function backlogOf(rows: WorkItemRow[], overrides: Partial<Backlog> = {}): Backlog {
  const sources = new Map<string, Backlog["filters"]["sources"][number]>();
  const repos = new Map<string, Backlog["filters"]["repos"][number]>();
  for (const row of rows) {
    const value = `${row.tracker}:${row.source.kind}:${row.source.id}`;
    sources.set(value, { ...row.source, value, tracker: row.tracker });
    if (row.repository) {
      repos.set(row.repository.id, {
        value: row.repository.id,
        provider: row.repository.provider,
        fullPath: row.repository.fullPath,
      });
    }
  }
  return {
    groups: {
      readyToStart: rows.filter((row) => row.group === "ready"),
      needsRefining: rows.filter((row) => row.group === "refine"),
    },
    filters: { sources: [...sources.values()], repos: [...repos.values()] },
    unavailable: [],
    truncated: false,
    truncatedOrganizations: [],
    setup: "ready",
    ...overrides,
  };
}
