/**
 * A code-host connection's health in words, built once: the repo status, the add-repo
 * sheet and the connection pages all read it from `connectionHealth`. Safe to import in
 * the browser.
 */
import type { ConnectionHealthRow, ConnectionProblemRow } from "@/lib/api/repositories";
import { formatDate } from "@/lib/format-date";

/**
 * `healthy`: checked, nothing wrong. `expiring`: the bot token expires soon (and nothing
 * else is wrong). `needs_attention`: a problem needs an admin. `not_checked`: a GitLab
 * connection before its first daily check. `connected`: GitHub, which isn't checked.
 */
export type ConnectionHealthState =
  "healthy" | "expiring" | "needs_attention" | "not_checked" | "connected";

/** A problem in plain words; `repositoryId` when it is about one repo (webhook problems). */
export interface ConnectionHealthProblem {
  code: string;
  sentence: string;
  repositoryId?: string;
}

export interface ConnectionHealthSummary {
  state: ConnectionHealthState;
  /** ISO date the bot token expires, when GitLab reports it. */
  expiresAt?: string;
  problems: ConnectionHealthProblem[];
}

/** A bot token expiring within this many days makes the connection `expiring`. */
export const EXPIRING_SOON_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Problems about one repo's webhook, which "Recreate webhook" fixes. */
export const WEBHOOK_PROBLEM_CODES: readonly string[] = [
  "webhook_missing",
  "webhook_events_outdated",
];

/** Problems that only warn: the token expiring is the `expiring` state, not a problem. */
const WARNING_CODES = new Set(["token_expiring"]);

function expiry(tokenExpiresAt: string | null): string {
  return tokenExpiresAt
    ? `The bot token expires on ${formatDate(tokenExpiresAt)}.`
    : "GitLab doesn't report when the bot token expires.";
}

/** What the connection's admins are told about a problem. */
export function problemText(problem: ConnectionProblemRow, health: ConnectionHealthRow): string {
  switch (problem.code) {
    case "access_token_bot":
      return (
        "The bot token is a group or project access token, so agents' clones and pushes will fail: " +
        "GitLab doesn't let those create the project access tokens agents use. Reconnect GitLab " +
        "with a service account's personal access token (api scope, Maintainer on the projects)."
      );
    case "token_expiring":
      return `${expiry(health.tokenExpiresAt)} Omniralph rotates it daily; if it isn't rotated in time, reconnect GitLab with a new token.`;
    case "rotation_unsupported":
      return `${problem.message} ${expiry(health.tokenExpiresAt)}`;
    default:
      return problem.message;
  }
}

/** The connection's health state and problems, from its last check (`health`). */
export function connectionHealth(
  connection: { provider: "github" | "gitlab"; health: ConnectionHealthRow | null },
  now: Date = new Date(),
): ConnectionHealthSummary {
  if (connection.provider === "github") return { state: "connected", problems: [] };
  const { health } = connection;
  if (!health) return { state: "not_checked", problems: [] };
  const problems = health.problems.map((problem) => ({
    code: problem.code,
    sentence: problemText(problem, health),
    ...(problem.repositoryId !== undefined && { repositoryId: problem.repositoryId }),
  }));
  const expiresAt = health.tokenExpiresAt ?? undefined;
  const summary = (state: ConnectionHealthState): ConnectionHealthSummary => ({
    state,
    ...(expiresAt !== undefined && { expiresAt }),
    problems,
  });
  if (problems.some((problem) => !WARNING_CODES.has(problem.code))) {
    return summary("needs_attention");
  }
  const expiringSoon =
    expiresAt !== undefined && Date.parse(expiresAt) - now.getTime() <= EXPIRING_SOON_DAYS * DAY_MS;
  return summary(expiringSoon || problems.length > 0 ? "expiring" : "healthy");
}

/**
 * The health once `repositoryId`'s webhook was recreated: its webhook problems are gone,
 * and a connection with nothing else wrong is no longer `needs_attention`.
 */
export function withoutWebhookProblems(
  summary: ConnectionHealthSummary,
  repositoryId: string,
  now: Date = new Date(),
): ConnectionHealthSummary {
  const problems = summary.problems.filter(
    (problem) =>
      problem.repositoryId !== repositoryId || !WEBHOOK_PROBLEM_CODES.includes(problem.code),
  );
  if (summary.state !== "needs_attention") return { ...summary, problems };
  if (problems.some((problem) => !WARNING_CODES.has(problem.code))) {
    return { ...summary, problems };
  }
  const expiringSoon =
    summary.expiresAt !== undefined &&
    Date.parse(summary.expiresAt) - now.getTime() <= EXPIRING_SOON_DAYS * DAY_MS;
  return {
    ...summary,
    state: expiringSoon || problems.length > 0 ? "expiring" : "healthy",
    problems,
  };
}
