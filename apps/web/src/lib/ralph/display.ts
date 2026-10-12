/**
 * Client-safe parts of the Ralph runs pages: filter values, list URLs,
 * view-prop types and formatting. Server-side mapping lives in `./history`.
 */
import type { RalphLaneCleanup, RalphRunStatus, RalphStoryStatus } from "@omniralph/db";
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

/** The chat thread a chat run was started from. */
export interface RalphChatThreadRef {
  platform: "slack" | "discord";
  /** The Chat SDK channel ID (e.g. `slack:C0123`). */
  channelId: string;
}

export const CHAT_PLATFORM_NAMES: Record<RalphChatThreadRef["platform"], string> = {
  slack: "Slack",
  discord: "Discord",
};

export interface RalphRunRow {
  id: string;
  /** Where the run came from: a Linear issue, or a chat thread. */
  origin: "linear" | "chat";
  /** The Linear issue's (null for a chat run). */
  linearIdentifier: string | null;
  linearTitle: string | null;
  linearUrl: string | null;
  /** A chat run's thread (null for a Linear run, or once the thread is gone). */
  chatThread: RalphChatThreadRef | null;
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
  /** After its PR/MR merged or closed, or the run stopped: where the cleanup of its worktree is (`cleanupLabel`). */
  cleanup: string | null;
  /** Review-response rounds so far, out of the repository's `maxReviewRounds` (null: turned off). */
  reviewRounds: RalphRounds;
  /** CI-fix rounds so far, out of the repository's `maxFixRounds` (null: turned off). */
  ciFixRounds: RalphRounds;
}

/** A lane's follow-up rounds: done, and the most allowed (null: the loop is turned off). */
export interface RalphRounds {
  done: number;
  max: number | null;
}

/** "1 / 3" rounds, or "2 (off)" when the repository turned the loop off. */
export function roundsLabel({ done, max }: RalphRounds): string {
  return max === null ? `${done} (off)` : `${done} / ${max}`;
}

/** A request the run hasn't handled yet. */
export interface RalphRequestView {
  id: string;
  /** The lane it's for (requests without one are the main lane's). */
  laneId: string | null;
  text: string;
  author: string | null;
  /** ISO timestamp. */
  createdAt: string;
}

/**
 * Where a message for a running job is: waiting for the agent's next
 * heartbeat, delivered into the live session, or rejected (or its job ended)
 * and kept as guidance for the next story attempts instead.
 */
export const RALPH_MESSAGE_STATES = ["waiting", "delivered", "guidance", "undelivered"] as const;
export type RalphMessageState = (typeof RALPH_MESSAGE_STATES)[number];

export const RALPH_MESSAGE_STATE_LABELS: Record<RalphMessageState, string> = {
  waiting: "Waiting for delivery",
  delivered: "Delivered",
  guidance: "Not delivered: kept as guidance",
  undelivered: "Not delivered: the job ended",
};

/** A message's state from its timestamps and its job's status. */
export function ralphMessageState(message: {
  deliveredAt: string | null;
  consumedAt: string | null;
  kind: "guidance" | "request";
  jobStatus: RalphJobView["status"];
}): RalphMessageState {
  if (message.deliveredAt) return "delivered";
  if (message.consumedAt) return message.kind === "guidance" ? "guidance" : "undelivered";
  return message.jobStatus === "queued" || message.jobStatus === "running"
    ? "waiting"
    : "undelivered";
}

/** A Linear reply or mention sent to a running job's live session. */
export interface RalphMessageView {
  id: string;
  kind: "guidance" | "request";
  text: string;
  author: string | null;
  job: { id: string; type: string; status: RalphJobView["status"] };
  state: RalphMessageState;
  /** ISO timestamps. */
  createdAt: string;
  deliveredAt: string | null;
  consumedAt: string | null;
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
  /** Requests not handled yet, oldest first. */
  pendingRequests: RalphRequestView[];
  /** Messages for running jobs, newest first (the latest `messageLimit`). */
  messages: RalphMessageView[];
  messageLimit: number;
  /** ISO timestamp. */
  createdAt: string;
}

/** A Chat SDK channel ID without its platform prefix (and a Discord channel's guild). */
export function chatChannelLabel(channelId: string): string {
  return channelId.split(":").at(-1) || channelId;
}

/**
 * What the pages call a run: its Linear identifier, or for a chat run its
 * platform and channel (`Slack C0123`).
 */
export function runSourceLabel(
  run: Pick<RalphRunRow, "origin" | "linearIdentifier" | "chatThread">,
): string {
  if (run.origin === "linear") return run.linearIdentifier ?? "Linear issue";
  if (!run.chatThread) return "Chat";
  const { platform, channelId } = run.chatThread;
  return `${CHAT_PLATFORM_NAMES[platform]} ${chatChannelLabel(channelId)}`;
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

/** A lane's cleanup for the run detail page. */
export function cleanupLabel(cleanup: RalphLaneCleanup | null): string | null {
  if (!cleanup) return null;
  const why =
    cleanup.keepBranch === "closed"
      ? "Closed"
      : cleanup.keepBranch === "stopped"
        ? "Stopped"
        : "Merged";
  const open = cleanup.questions.length;
  const asking = open > 0 ? `, waiting for ${open === 1 ? "an answer" : `${open} answers`}` : "";
  const kept = cleanup.keepBranch ? " (branch kept)" : "";
  switch (cleanup.status) {
    case "pending":
      return `${why}: cleanup waits for the run's current job`;
    case "running":
      return `${why}: cleaning up`;
    case "failed":
      return `${why}: cleanup failed (${cleanup.error ?? "unknown error"}), retried by the reconcile cron`;
    default:
      return cleanup.error
        ? `${why}: not cleaned up (${cleanup.error})`
        : `${why}: cleaned up${kept}${asking}`;
  }
}
