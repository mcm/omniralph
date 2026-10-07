import { AccessLevel, Gitlab } from "@gitbeaker/rest";
import { GITLAB_URL } from "./adapter.js";

/** A user-facing problem connecting GitLab (bad token, unknown project, missing permission). */
export class GitLabSetupError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitLabSetupError";
  }
}

export interface GitLabTokenOwner {
  /** User ID of the token's (bot) user. */
  userId: number;
  username: string;
  name: string;
  /** Token scopes, when GitLab reports them. */
  scopes: string[] | null;
}

export interface GitLabProject {
  id: number;
  fullPath: string;
  webUrl: string;
  /** `public`, `internal` or `private`. */
  visibility: string;
}

/** Most projects {@link GitLabSetupClient.listProjects} returns. */
export const MAX_LISTED_GITLAB_PROJECTS = 1000;
const LIST_PAGE_SIZE = 100;

export interface GitLabHookOptions {
  url: string;
  /** Sent back as `X-Gitlab-Token` with every delivery. */
  secret: string;
}

/** Usernames of the bot users behind group and project access tokens. */
const ACCESS_TOKEN_BOT_USERNAME = /^(project|group)_\d+_bot(_[0-9a-f]+)?$/;

/**
 * Whether `username` is a group or project access token's bot user. GitLab
 * doesn't let those bots create access tokens, so their tokens can't mint the
 * project access tokens agents clone and push with.
 */
export function isAccessTokenBotUsername(username: string): boolean {
  return ACCESS_TOKEN_BOT_USERNAME.test(username);
}

/** Why a group or project access token can't be the bot token. */
export const ACCESS_TOKEN_BOT_MESSAGE =
  "This is a group or project access token. GitLab doesn't let those create the project access tokens " +
  "agents clone and push with. Use a service account's personal access token (api scope, Maintainer on " +
  "the projects) instead.";

/** HTTP status of a gitbeaker request error. */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const cause = (error as { cause?: { response?: { status?: unknown } } }).cause;
  const status = cause?.response?.status;
  return typeof status === "number" ? status : undefined;
}

function toProject(project: {
  id: number;
  path_with_namespace: string;
  web_url: string;
  visibility?: unknown;
}): GitLabProject {
  return {
    id: project.id,
    fullPath: project.path_with_namespace,
    webUrl: project.web_url,
    visibility: typeof project.visibility === "string" ? project.visibility : "private",
  };
}

/** Normalizes a GitLab instance URL (no trailing slash or `/api/v4`). */
export function normalizeGitLabUrl(baseUrl: string | undefined): string {
  return (baseUrl?.trim() || GITLAB_URL).replace(/\/+$/, "").replace(/\/api\/v4$/, "");
}

/**
 * Control-panel-side GitLab setup calls made with the bot access token: token
 * validation, project lookup and project webhooks. Errors a person can fix are
 * thrown as {@link GitLabSetupError}.
 */
export class GitLabSetupClient {
  readonly baseUrl: string;
  private readonly api: Gitlab<false>;

  constructor(options: { baseUrl?: string; token: string }) {
    this.baseUrl = normalizeGitLabUrl(options.baseUrl);
    this.api = new Gitlab<false>({ host: this.baseUrl, token: options.token });
  }

  /**
   * Checks the token works, has the `api` scope (needed to post reviews,
   * create webhooks and mint clone tokens) and isn't a group or project access
   * token (those can't mint clone tokens). Returns the token's user.
   */
  async validateToken(): Promise<GitLabTokenOwner> {
    let user;
    try {
      user = await this.api.Users.showCurrentUser();
    } catch (error) {
      const status = statusOf(error);
      if (status === 401 || status === 403) {
        throw new GitLabSetupError(
          "GitLab rejected the access token (invalid, expired or revoked).",
          status,
        );
      }
      if (status === 404) {
        throw new GitLabSetupError(
          `${this.baseUrl} doesn't look like a GitLab instance (no /api/v4/user).`,
          status,
        );
      }
      throw new GitLabSetupError(
        `Couldn't reach GitLab at ${this.baseUrl}: ${(error as Error).message}`,
        status,
      );
    }

    if (isAccessTokenBotUsername(user.username)) {
      throw new GitLabSetupError(ACCESS_TOKEN_BOT_MESSAGE);
    }

    let scopes: string[] | null = null;
    try {
      const token = await this.api.PersonalAccessTokens.show();
      scopes = token.scopes ?? null;
    } catch (error) {
      // Older instances don't have /personal_access_tokens/self; the webhook step still fails clearly.
      if (statusOf(error) !== 404) throw error;
    }
    if (scopes && !scopes.includes("api")) {
      throw new GitLabSetupError(
        `The access token needs the api scope (it has: ${scopes.join(", ") || "none"}).`,
      );
    }
    return { userId: user.id, username: user.username, name: user.name, scopes };
  }

  /**
   * Projects the token's user can connect: those it's a member of with at least the
   * Maintainer role (needed for webhooks and project access tokens), archived ones
   * excluded, sorted by path. At most {@link MAX_LISTED_GITLAB_PROJECTS}.
   */
  async listProjects(): Promise<GitLabProject[]> {
    let projects;
    try {
      projects = await this.api.Projects.all({
        membership: true,
        minAccessLevel: AccessLevel.MAINTAINER,
        archived: false,
        orderBy: "id",
        sort: "asc",
        perPage: LIST_PAGE_SIZE,
        maxPages: MAX_LISTED_GITLAB_PROJECTS / LIST_PAGE_SIZE,
      });
    } catch (error) {
      const status = statusOf(error);
      if (status === 401 || status === 403) {
        throw new GitLabSetupError(
          "GitLab rejected the access token (invalid, expired or revoked).",
          status,
        );
      }
      throw error;
    }
    return projects.map(toProject).sort((a, b) => a.fullPath.localeCompare(b.fullPath));
  }

  /**
   * Creates a project webhook for merge request, comment and pipeline events
   * (pipelines: ralph's CI-fix loop). Returns its ID.
   */
  async createProjectHook(projectId: number, options: GitLabHookOptions): Promise<number> {
    try {
      const hook = await this.api.ProjectHooks.add(projectId, options.url, {
        mergeRequestsEvents: true,
        noteEvents: true,
        pushEvents: false,
        tagPushEvents: false,
        issuesEvents: false,
        confidentialIssuesEvents: false,
        confidentialNoteEvents: false,
        pipelineEvents: true,
        jobEvents: false,
        wikiPageEvents: false,
        deploymentEvents: false,
        releasesEvents: false,
        enableSslVerification: true,
        token: options.secret,
      });
      return hook.id;
    } catch (error) {
      const status = statusOf(error);
      if (status === 403 || status === 401) {
        throw new GitLabSetupError(
          "The token can't manage webhooks on this project; it needs the Maintainer role.",
          status,
        );
      }
      if (status === 422 || status === 400) {
        throw new GitLabSetupError(
          `GitLab rejected the webhook URL ${options.url} (is APP_URL publicly reachable?).`,
          status,
        );
      }
      throw error;
    }
  }

  /** Deletes a project webhook. An already-deleted hook (404) is fine. */
  async deleteProjectHook(projectId: number | string, hookId: number): Promise<void> {
    try {
      await this.api.ProjectHooks.remove(projectId, hookId);
    } catch (error) {
      if (statusOf(error) !== 404) throw error;
    }
  }
}
