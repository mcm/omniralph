import type { RepositoryLink } from "@omniralph/db";
import { RunSpecJobPayload } from "@omniralph/shared";
import { z } from "zod";
import { changeRequestWebUrl, repositoryWebUrl } from "@/lib/repositories/web-url";

/** A harness counts as online while its last heartbeat is younger than this. */
export const HARNESS_ONLINE_WINDOW_MS = 60_000;

export function isHarnessOnline(lastHeartbeatAt: Date | null, now: Date = new Date()): boolean {
  return (
    lastHeartbeatAt !== null && now.getTime() - lastHeartbeatAt.getTime() < HARNESS_ONLINE_WINDOW_MS
  );
}

/** POSIX shell single-quoting, only where needed. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Installs the harness on a host (the package is public: no npm auth needed). */
export const HARNESS_INSTALL_COMMAND = "npm install -g @omniralph/agent";

/** The command an admin runs on the harness host to redeem an enrollment token. */
export function enrollCommand(serverUrl: string, token: string): string {
  return `omniralph-agent enroll --server ${shellQuote(serverUrl)} --token ${shellQuote(token)}`;
}

const PR_NUMBER = z.int().min(1);

/** A job's link for the UI: the PR/MR it's for, else its repository. */
export interface JobTarget {
  label: string;
  url: string | null;
}

export function jobTarget(job: {
  payload: Record<string, unknown>;
  repository: RepositoryLink | null;
}): JobTarget | null {
  const repo = job.repository;
  if (!repo) return null;
  // A run's PR trigger context (`pr.number`), or the `prNumber` of an old `review.run` job.
  const run = RunSpecJobPayload.safeParse(job.payload);
  const pr = run.success ? (run.data.trigger.context.pr as { number?: unknown } | undefined) : null;
  const prNumber = PR_NUMBER.safeParse(run.success ? pr?.number : job.payload.prNumber);
  if (prNumber.success) {
    const sigil = repo.provider === "gitlab" ? "!" : "#";
    return {
      label: `${repo.fullPath}${sigil}${prNumber.data}`,
      url: changeRequestWebUrl(repo.provider, repo.baseUrl, repo.fullPath, prNumber.data),
    };
  }
  return {
    label: repo.fullPath,
    url: repositoryWebUrl(repo.provider, repo.baseUrl, repo.fullPath),
  };
}

export type AuditEventName =
  | "enroll"
  | "token_refresh"
  | "refresh_reuse"
  | "revoke"
  | "delete"
  | "credential_issued"
  | "result_submitted"
  | "auth_failed";

export const AUDIT_EVENT_LABELS: Record<AuditEventName, string> = {
  enroll: "Enrolled",
  token_refresh: "Token refresh",
  refresh_reuse: "Refresh token reuse",
  revoke: "Revoked",
  delete: "Deleted",
  credential_issued: "Credential issued",
  result_submitted: "Result submitted",
  auth_failed: "Auth failure",
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** One line describing an audit event's details. */
export function auditDetailSummary(event: AuditEventName, detail: Record<string, unknown>): string {
  switch (event) {
    case "credential_issued": {
      const repo = str(detail.repository);
      const job = str(detail.jobId);
      const kind = detail.access === "write" ? "Write token" : "Read-only token";
      const tokenKind = str(detail.tokenKind);
      const line = [repo && `${kind} for ${repo}`, job && `job ${job.slice(0, 8)}`]
        .filter(Boolean)
        .join(", ");
      return tokenKind && line ? `${line} (${tokenKind} token)` : line;
    }
    case "result_submitted": {
      const job = str(detail.jobId);
      const status = str(detail.status);
      return [job && `Job ${job.slice(0, 8)}`, status].filter(Boolean).join(": ");
    }
    case "auth_failed":
      return [str(detail.reason), str(detail.path)].filter(Boolean).join(" on ");
    case "refresh_reuse":
      return "An already used refresh token was presented again. The harness was revoked.";
    case "revoke": {
      const requeued = Array.isArray(detail.requeuedJobIds) ? detail.requeuedJobIds.length : 0;
      return [
        str(detail.revokedBy) ? "By an admin" : null,
        requeued > 0 ? `${requeued} running job${requeued === 1 ? "" : "s"} requeued` : null,
      ]
        .filter(Boolean)
        .join(", ");
    }
    case "delete":
      return str(detail.deletedBy) ? "By an admin" : "";
    case "enroll": {
      const name = str(detail.name);
      const version = str(detail.version);
      return [name && `Host ${name}`, version && `version ${version}`].filter(Boolean).join(", ");
    }
    case "token_refresh":
      return "";
  }
}

/** Whether the audit log shows signs of a stolen refresh token. */
export function hasRefreshReuse(events: readonly { event: string }[]): boolean {
  return events.some((e) => e.event === "refresh_reuse");
}
