import { Gitlab } from "@gitbeaker/rest";
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
}

export interface GitLabHookOptions {
  url: string;
  /** Sent back as `X-Gitlab-Token` with every delivery. */
  secret: string;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const cause = (error as { cause?: { response?: { status?: unknown } } }).cause;
  const status = cause?.response?.status;
  return typeof status === "number" ? status : undefined;
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
   * Checks the token works and has the `api` scope (needed to post reviews,
   * create webhooks and mint clone tokens). Returns the token's user.
   */
  async validateToken(): Promise<GitLabTokenOwner> {
    let user;
    try {
      user = await this.api.Users.showCurrentUser();
    } catch (error) {
      const status = statusOf(error);
      if (status === 401 || status === 403) {
        throw new GitLabSetupError("GitLab rejected the access token (invalid, expired or revoked).", status);
      }
      if (status === 404) {
        throw new GitLabSetupError(`${this.baseUrl} doesn't look like a GitLab instance (no /api/v4/user).`, status);
      }
      throw new GitLabSetupError(`Couldn't reach GitLab at ${this.baseUrl}: ${(error as Error).message}`, status);
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

  /** Looks up a project by its `group/subgroup/project` path. */
  async getProject(path: string): Promise<GitLabProject> {
    const fullPath = path.trim().replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    try {
      const project = await this.api.Projects.show(fullPath);
      return { id: project.id, fullPath: project.path_with_namespace, webUrl: project.web_url };
    } catch (error) {
      const status = statusOf(error);
      if (status === 404 || status === 403) {
        throw new GitLabSetupError(
          `Project ${fullPath} wasn't found, or the token's user isn't a member of it.`,
          status,
        );
      }
      throw error;
    }
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
