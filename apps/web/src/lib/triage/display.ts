/** Client-safe types and helpers of the Triage pages: their rows, URL params and labels. */
import type { TriageOutcome, TriageOutcomeKind, TriageSize } from "@omniralph/shared";
import type { JobRow } from "@/lib/agents/rows";
import { parsePage } from "@/lib/pagination";

export const TRIAGE_RUN_STATUSES = ["queued", "running", "completed", "failed", "stopped"] as const;
export type TriageRunStatus = (typeof TRIAGE_RUN_STATUSES)[number];

export type TriageTrigger = "mention" | "label";

export const TRIAGE_TRIGGER_LABELS: Record<TriageTrigger, string> = {
  mention: "Mention",
  label: "Triage label",
};

export const TRIAGE_TRIGGER_DESCRIPTIONS: Record<TriageTrigger, string> = {
  mention: "Started by an @Omniralph /triage mention in Linear.",
  label: "Started by adding the triage label to the issue in Linear.",
};

export const TRIAGE_OUTCOME_LABELS: Record<TriageOutcomeKind, string> = {
  prd: "New PRD",
  reformat: "Reformatted",
  unchanged: "Unchanged",
};

export const TRIAGE_OUTCOME_DESCRIPTIONS: Record<TriageOutcomeKind, string> = {
  prd: "Triage wrote a new PRD for the issue.",
  reformat: "The issue was already planned: triage reformatted it to the PRD format.",
  unchanged: "Triage left the issue as it was.",
};

/** Linear priorities of stories (1 Urgent … 4 Low). */
export const STORY_PRIORITY_LABELS: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Medium",
  4: "Low",
};

/** The Linear issue a triage run works on, as its latest job read it. */
export interface TriageIssueRef {
  identifier: string;
  title: string | null;
  url: string | null;
}

export interface TriageRepositoryRef {
  provider: "github" | "gitlab";
  fullPath: string;
  url: string;
}

/** Serializable triage run row for the Triage list. */
export interface TriageRunRow {
  id: string;
  status: TriageRunStatus;
  trigger: TriageTrigger;
  /** Null until a job is enqueued (the issue is read then). */
  issue: TriageIssueRef | null;
  /** The repository its latest job read, null when no repository routes the issue. */
  repository: TriageRepositoryRef | null;
  /** From the last result, null without one. */
  outcome: TriageOutcomeKind | null;
  size: TriageSize | null;
  openQuestions: number | null;
  /** Why the run failed, when it did. */
  error: string | null;
  /** The agent of its latest job. */
  agent: { id: string; name: string } | null;
  jobCount: number;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
}

/** A `triage.run` job of a run, for the run's page. */
export interface TriageJobRow {
  id: string;
  status: JobRow["status"];
  cancelRequested: boolean;
  deliveryCount: number;
  error: string | null;
  agent: { id: string; name: string } | null;
  /** The reply in the Linear session the job triaged with, if any. */
  reply: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** What a run's session reported: Claude's text (`thought`) or a tool call (`action`). */
export interface TriageActivityRow {
  id: string;
  jobId: string;
  type: "thought" | "action";
  body: string;
  parameter: string | null;
  createdAt: string;
}

/** What the run's last job produced (`TriageRunResult`). */
export interface TriageResultView {
  summary: string;
  error: string | null;
  outcome: TriageOutcome | null;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
}

/** Serializable triage run for its page. */
export interface TriageRunDetailView extends TriageRunRow {
  linearAgentSessionId: string;
  /** The default branch its latest job read the repository at. */
  branch: string | null;
  /** Replies in the session that wait for the run's next job. */
  pendingReply: string | null;
  result: TriageResultView | null;
  jobs: TriageJobRow[];
  /** The latest activities of the run's jobs, oldest first. */
  activities: TriageActivityRow[];
}

export interface TriageRunListParams {
  status: TriageRunStatus | null;
  /** 1-based. */
  page: number;
}

type SearchParams = Record<string, string | string[] | undefined>;

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The list's filter and page from URL search params. */
export function parseTriageRunListParams(params: SearchParams): TriageRunListParams {
  const status = single(params.status);
  return {
    status: (TRIAGE_RUN_STATUSES as readonly string[]).includes(status ?? "")
      ? (status as TriageRunStatus)
      : null,
    page: parsePage(params.page),
  };
}

/** `pathname` with the filter and page as search params (defaults omitted). */
export function triageRunListHref(pathname: string, params: TriageRunListParams): string {
  const search = new URLSearchParams();
  if (params.status) search.set("status", params.status);
  if (params.page > 1) search.set("page", String(params.page));
  const query = search.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/** A triage run's page. */
export function triageRunHref(runId: string): string {
  return `/triage/${runId}`;
}

/** How the run is named: its issue's identifier, or "Triage" before a job read the issue. */
export function triageRunLabel(run: Pick<TriageRunRow, "issue">): string {
  return run.issue?.identifier ?? "Triage";
}

/** Milliseconds as `1m 05s` (or `42s`). */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
