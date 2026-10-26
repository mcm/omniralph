// Run rows for the Runs screen's tests, as `GET /api/ui/runs` answers them.
import { TEST_ORGANIZATION_ID } from "@/components/query-test-utils";
import type { RunFilterOptions, RunRow } from "@/lib/api/runs";

export const NOW = Date.parse("2026-10-26T12:00:00.000Z");
export const BETA_ID = "22222222-2222-4222-8222-222222222222";
export const REPO_PORTAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
export const REPO_WEB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
export const REPO_BETA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3";

export const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

/** A finished epic of Acme with a merge request, 42 minutes old, with overrides. */
export function runRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "epic",
    status: "completed",
    origin: "linear",
    organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
    title: "Customer portal billing export",
    workItem: {
      tracker: "linear",
      identifier: "TOOL-42",
      url: "https://linear.app/acme/issue/TOOL-42",
    },
    repository: { id: REPO_PORTAL, provider: "gitlab", fullPath: "acme/portal" },
    branch: "omniralph/tool-42",
    pullRequest: {
      provider: "gitlab",
      number: 12,
      url: "https://gitlab.com/acme/portal/-/merge_requests/12",
    },
    agent: { id: "agent-1", name: "build-01" },
    progress: { done: 4, total: 4 },
    tokens: { in: 1000, out: 200 },
    createdAt: minutesAgo(42),
    startedAt: minutesAgo(41),
    finishedAt: minutesAgo(5),
    updatedAt: minutesAgo(5),
    ...overrides,
  };
}

/** A failed review of a GitHub pull request in Beta, 2 hours old. */
export function reviewRow(overrides: Partial<RunRow> = {}): RunRow {
  return runRow({
    id: "33333333-3333-4333-8333-333333333333",
    kind: "review",
    status: "failed",
    origin: "pr_webhook",
    organization: { id: BETA_ID, name: "Beta", role: "member" },
    title: "Review of pull request #7",
    workItem: null,
    repository: { id: REPO_BETA, provider: "github", fullPath: "beta/web" },
    branch: null,
    pullRequest: { provider: "github", number: 7, url: "https://github.com/beta/web/pull/7" },
    progress: { done: 1, total: 3 },
    createdAt: minutesAgo(120),
    ...overrides,
  });
}

/** An ask in Acme, without references, 3 days old. */
export function askRow(overrides: Partial<RunRow> = {}): RunRow {
  return runRow({
    id: "55555555-5555-4555-8555-555555555555",
    kind: "ask",
    status: "waiting",
    origin: "chat",
    title: "Which repo has the billing service?",
    workItem: null,
    repository: null,
    branch: null,
    pullRequest: null,
    agent: null,
    progress: null,
    createdAt: minutesAgo(3 * 24 * 60),
    ...overrides,
  });
}

export const FILTER_OPTIONS: RunFilterOptions = {
  repositories: [
    {
      id: REPO_PORTAL,
      provider: "gitlab",
      fullPath: "acme/portal",
      organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
    },
    {
      id: REPO_WEB,
      provider: "github",
      fullPath: "acme/web",
      organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
    },
    {
      id: REPO_BETA,
      provider: "github",
      fullPath: "beta/web",
      organization: { id: BETA_ID, name: "Beta", role: "member" },
    },
  ],
};
