import type { AgentAuditEvent, RepositoryLink } from "@omniralph/db";
import { RunSpecJobPayload } from "@omniralph/shared";
import { z } from "zod";
import { changeRequestWebUrl, repositoryWebUrl } from "@/lib/repositories/web-url";

/** The liveness sweep announces an agent offline once its last heartbeat is this old. */
export const AGENT_ONLINE_WINDOW_MS = 60_000;

/** POSIX shell single-quoting, only where needed. */
function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Installs the agent on a host (the package is public: no npm auth needed). */
export const AGENT_INSTALL_COMMAND = "npm install -g @omniralph/agent";

/** The command an admin runs on the agent host to redeem an enrollment token. */
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

/** The `agent_audit_event` values. */
export const AUDIT_EVENTS = [
  "enroll",
  "token_refresh",
  "refresh_reuse",
  "revoke",
  "delete",
  "credential_issued",
  "result_submitted",
  "auth_failed",
] as const satisfies readonly AgentAuditEvent[];
export type AuditEventName = (typeof AUDIT_EVENTS)[number];
