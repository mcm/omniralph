import { Gitlab } from "@gitbeaker/rest";
import {
  ACCESS_TOKEN_BOT_MESSAGE,
  isAccessTokenBotUsername,
  normalizeGitLabUrl,
  statusOf,
} from "./setup.js";

export type GitLabProblemCode =
  | "token_invalid"
  | "missing_api_scope"
  | "access_token_bot"
  | "token_expiring"
  | "webhook_missing"
  | "webhook_events_outdated"
  /** Set by the rotation that runs before the check (`rotateGitLabToken`). */
  | "rotation_unsupported"
  | "rotation_failed";

export interface GitLabProblem {
  code: GitLabProblemCode;
  message: string;
  /** The repository (project) the problem is about. */
  repositoryId?: string;
}

/** An enabled project of the connection, with the webhook ID stored for it. */
export interface GitLabHealthProject {
  repositoryId: string;
  /** GitLab project ID. */
  projectId: string;
  fullPath: string;
  webhookId: string | null;
}

export interface GitLabHealth {
  /** ISO timestamp of the check. */
  checkedAt: string;
  /** The bot token's `expires_at` (ISO date), when GitLab reports it. */
  tokenExpiresAt: string | null;
  problems: GitLabProblem[];
}

/** A token expiring within this many days is reported as `token_expiring`. */
export const TOKEN_EXPIRING_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Checks a GitLab connection's bot token (works, has the `api` scope, isn't a
 * group or project access token, doesn't expire within
 * {@link TOKEN_EXPIRING_DAYS} days) and the webhooks of its enabled projects
 * (exist, send merge request, comment and pipeline events with SSL
 * verification). Read-only: it never changes a webhook. Errors other than
 * the ones reported as problems (e.g. GitLab unreachable) are thrown.
 */
export async function checkGitLabConnection(options: {
  baseUrl?: string;
  token: string;
  projects: GitLabHealthProject[];
  now?: Date;
}): Promise<GitLabHealth> {
  const now = options.now ?? new Date();
  const api = new Gitlab<false>({
    host: normalizeGitLabUrl(options.baseUrl),
    token: options.token,
  });
  const health: GitLabHealth = { checkedAt: now.toISOString(), tokenExpiresAt: null, problems: [] };
  const problems = health.problems;

  let user;
  try {
    user = await api.Users.showCurrentUser();
  } catch (error) {
    if (statusOf(error) !== 401) throw error;
    problems.push({
      code: "token_invalid",
      message:
        "GitLab rejects the bot token (invalid, expired or revoked). Reconnect GitLab with a new token.",
    });
    return health;
  }
  if (isAccessTokenBotUsername(user.username)) {
    problems.push({ code: "access_token_bot", message: ACCESS_TOKEN_BOT_MESSAGE });
  }

  let scopes: string[] | null = null;
  try {
    const token = await api.PersonalAccessTokens.show();
    scopes = token.scopes ?? null;
    health.tokenExpiresAt = token.expires_at ?? null;
  } catch (error) {
    // Older instances don't have /personal_access_tokens/self.
    if (statusOf(error) !== 404) throw error;
  }
  if (scopes && !scopes.includes("api")) {
    problems.push({
      code: "missing_api_scope",
      message: `The bot token needs the api scope (it has: ${scopes.join(", ") || "none"}).`,
    });
  }
  if (
    health.tokenExpiresAt &&
    Date.parse(health.tokenExpiresAt) - now.getTime() <= TOKEN_EXPIRING_DAYS * DAY_MS
  ) {
    problems.push({
      code: "token_expiring",
      message: `The bot token expires on ${health.tokenExpiresAt}.`,
    });
  }
  // Without the api scope the webhooks can't be read (nor used); that's already reported.
  if (scopes && !scopes.includes("api")) return health;

  for (const project of options.projects) {
    const missing = {
      code: "webhook_missing" as const,
      message: `${project.fullPath} has no Omniralph webhook, so reviews and replies won't trigger.`,
      repositoryId: project.repositoryId,
    };
    if (project.webhookId === null) {
      problems.push(missing);
      continue;
    }
    let hook;
    try {
      hook = await api.ProjectHooks.show(project.projectId, Number(project.webhookId));
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
      problems.push(missing);
      continue;
    }
    const lacking = [
      hook.merge_requests_events ? null : "merge request events",
      hook.note_events ? null : "comment events",
      hook.pipeline_events ? null : "pipeline events",
      hook.enable_ssl_verification ? null : "SSL verification",
    ].filter((item): item is string => item !== null);
    if (lacking.length > 0) {
      problems.push({
        code: "webhook_events_outdated",
        message: `The webhook of ${project.fullPath} lacks ${lacking.join(", ")}.`,
        repositoryId: project.repositoryId,
      });
    }
  }
  return health;
}
