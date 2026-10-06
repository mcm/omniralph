/**
 * Client-safe parts of the Ralph runs pages: filter values, list URLs,
 * view-prop types and formatting. Server-side mapping lives in `./history`.
 */
import type { RalphRunStatus, RalphStoryStatus } from "@omniralph/db";
import { parsePage } from "@/lib/pagination";

/** Client-safe copies of the DB enums (the views can't import `@omniralph/db`). */
export const RALPH_RUN_STATUSES = [
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "stopped",
] as const satisfies readonly RalphRunStatus[];
export const RALPH_STORY_STATUSES = [
  "pending",
  "running",
  "completed",
  "blocked",
  "exhausted",
  "manual",
  "canceled",
] as const satisfies readonly RalphStoryStatus[];

/** Runs that can still be stopped. */
export const STOPPABLE_RALPH_RUN_STATUSES: readonly RalphRunStatus[] = [
  "pending",
  "running",
  "waiting",
];

export interface RalphRunListParams {
  status: RalphRunStatus | null;
  repositoryId: string | null;
  /** 1-based. */
  page: number;
}

type SearchParams = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The list's filters and page from URL search params; unknown values are ignored. */
export function parseRalphRunListParams(params: SearchParams): RalphRunListParams {
  const status = single(params.status);
  const repository = single(params.repository);
  return {
    status: (RALPH_RUN_STATUSES as readonly string[]).includes(status ?? "")
      ? (status as RalphRunStatus)
      : null,
    repositoryId: repository && UUID.test(repository) ? repository.toLowerCase() : null,
    page: parsePage(params.page),
  };
}

/** `pathname` with the filters and page as search params (defaults omitted). */
export function ralphRunListHref(pathname: string, params: RalphRunListParams): string {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.repositoryId) search.set("repository", params.repositoryId);
  if (params.page > 1) search.set("page", String(params.page));
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export interface RalphRepositoryRef {
  id: string;
  provider: "github" | "gitlab";
  fullPath: string;
}

/** A PR (GitHub, `#n`) or MR (GitLab, `!n`). */
export interface RalphPullRequest {
  number: number;
  url: string;
  label: string;
}

export interface RalphRunRow {
  id: string;
  linearIdentifier: string;
  linearTitle: string | null;
  linearUrl: string | null;
  /** Null while a person is asked which repository to use. */
  repository: RalphRepositoryRef | null;
  status: RalphRunStatus;
  stories: { total: number; completed: number };
  /** The main lane's branch and PR/MR (null while the run has no repository). */
  branch: string | null;
  pullRequest: RalphPullRequest | null;
  agent: { id: string; name: string } | null;
  error: string | null;
  /** ISO timestamp. */
  updatedAt: string;
}

export interface RalphStoryView {
  id: string;
  identifier: string;
  title: string;
  status: RalphStoryStatus;
  attempts: number;
  lastFeedback: string | null;
  commitSha: string | null;
  lastJobId: string | null;
  /** The lane the story runs in (null: none, e.g. it belongs in a repository Omniralph doesn't have). */
  laneId: string | null;
  /** Why it's treated as manual: it belongs in a repository Omniralph doesn't have. */
  elsewhere: string | null;
}

/** One repository the run works in, with its branch and PR/MR. */
export interface RalphLaneView {
  id: string;
  repository: RalphRepositoryRef;
  /** The lane of the run's own repository. */
  main: boolean;
  branch: string;
  baseBranch: string;
  pullRequest: RalphPullRequest | null;
}

export interface RalphJobView {
  id: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled" | "expired" | "skipped";
  cancelRequested: boolean;
  deliveryCount: number;
  error: string | null;
  agent: { id: string; name: string } | null;
  /** ISO timestamps. */
  createdAt: string;
  finishedAt: string | null;
}

export interface RalphRunDetailView extends Omit<RalphRunRow, "stories"> {
  kind: "children" | "prd" | "single";
  baseBranch: string | null;
  /** The main lane first. */
  lanes: RalphLaneView[];
  /** What a waiting run waits on (outside blockers and manual stories). */
  waitingOn: {
    blockers: { identifier: string; title: string }[];
    manual: { identifier: string; title: string }[];
  } | null;
  /** Oldest first. */
  guidance: { text: string; at: string }[];
  progress: string;
  iterations: number;
  storyCounts: { total: number; completed: number };
  stories: RalphStoryView[];
  /** Newest first. */
  jobs: RalphJobView[];
  /** ISO timestamp. */
  createdAt: string;
}

/** The first 12 characters of a commit SHA. */
export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/** Text cut to `max` characters, marked as cut. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Where a job is shown on the Jobs page. */
export function jobHref(jobId: string): string {
  return `/jobs#job-${jobId}`;
}

/**
 * The Linear URL of another issue of the run's workspace, derived from the
 * run's own issue URL (`https://linear.app/<workspace>/issue/<ID>/…`); null
 * when that URL is unknown.
 */
export function linearIssueUrl(runUrl: string | null, identifier: string): string | null {
  const match = runUrl?.match(/^(https:\/\/linear\.app\/[^/]+)\/issue\//);
  return match ? `${match[1]}/issue/${identifier}` : null;
}
