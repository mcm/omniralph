import { z } from "zod";
import { isoDate, mutationResultSchema } from "./schemas";

/** Wire formats of the repository and code-host connection endpoints under `/api/ui`. */

const provider = z.enum(["github", "gitlab"]);
const taskTypeState = z.object({ on: z.boolean(), inherited: z.boolean() });

/** A connected repository on the Repositories page. */
export const repositoryRowSchema = z.object({
  id: z.string(),
  provider,
  fullPath: z.string(),
  webUrl: z.string(),
  /** Query, Reviews and Coding: effective (on/off) and whether that's the organization's default. */
  taskTypes: z.object({ query: taskTypeState, review: taskTypeState, coding: taskTypeState }),
  profileName: z.string(),
  pinnedHarnesses: z.array(z.object({ id: z.string(), name: z.string() })),
  lastReviewAt: isoDate.nullable(),
});
export type RepositoryRow = z.infer<typeof repositoryRowSchema>;

/** A problem found by the daily GitLab check (`scm_connections.health`). */
export const connectionProblemSchema = z.object({
  code: z.string(),
  message: z.string(),
  /** The project the problem is about (webhook problems). */
  repositoryId: z.string().optional(),
});
export type ConnectionProblemRow = z.infer<typeof connectionProblemSchema>;

/** A GitLab connection's last daily check. */
export const connectionHealthSchema = z.object({
  /** ISO timestamp. */
  checkedAt: z.string(),
  /** ISO date the bot token expires, when GitLab reports it. */
  tokenExpiresAt: z.string().nullable(),
  problems: z.array(connectionProblemSchema),
});
export type ConnectionHealthRow = z.infer<typeof connectionHealthSchema>;

/** A GitHub App installation or GitLab connection of the organization. */
export const connectionRowSchema = z.object({
  id: z.string(),
  provider,
  name: z.string(),
  /** GitLab: the last daily check, or null before the first one. */
  health: connectionHealthSchema.nullable(),
});
export type ConnectionRow = z.infer<typeof connectionRowSchema>;

/** `GET /api/ui/repositories?page=`: a page of connected repositories, and (admins) the connections. */
export const repositoryListSchema = z.object({
  repositories: z.array(repositoryRowSchema),
  /** 1-based. */
  page: z.number(),
  pageSize: z.number(),
  /** Connected repositories across all pages. */
  total: z.number(),
  /** Admins only (empty for members): the organization's code-host connections. */
  connections: z.array(connectionRowSchema),
});
export type RepositoryList = z.infer<typeof repositoryListSchema>;

/** `GET /api/ui/repositories/setup` (admins): what the Connect buttons need. Not polled. */
export const repositorySetupSchema = z.object({
  /** Our install route (it adds the signed `state`), or null when the GitHub App isn't configured. */
  githubInstallPath: z.string().nullable(),
  /** The Connect GitLab dialog's default URL. */
  defaultGitLabUrl: z.string(),
});
export type RepositorySetup = z.infer<typeof repositorySetupSchema>;

/** `POST /api/ui/gitlab-connections` body: the Connect GitLab form. */
export const connectGitLabSchema = z.object({ baseUrl: z.string(), token: z.string() });

/** `POST /api/ui/gitlab-connections` response: the connection, whose projects are picked next. */
export const connectedGitLabSchema = mutationResultSchema.extend({ connectionId: z.string() });

/** `GET /api/ui/scm-connections/{id}?provider=`: a connection, for its picker's header. */
export const scmConnectionSchema = z.object({ id: z.string(), provider, name: z.string() });
export type ScmConnectionSummary = z.infer<typeof scmConnectionSchema>;

/** A repository (GitHub) or project (GitLab) the connection can access. */
export const selectableRepoSchema = z.object({
  id: z.number(),
  fullPath: z.string(),
  private: z.boolean(),
  htmlUrl: z.string(),
  /** Connected and enabled for reviews. */
  enabled: z.boolean(),
});
export type SelectableRepoRow = z.infer<typeof selectableRepoSchema>;

/**
 * `GET /api/ui/scm-connections/{id}/repositories`: what the picker lists, from the code host
 * (an external call: loaded once, refreshed on request). A failure answers 502
 * `LISTING_FAILED` with the code host's error as the message.
 */
export const selectableRepositoriesSchema = z.object({
  /** The GitHub account, or the GitLab connection's name. */
  account: z.string(),
  /** GitHub: the installation's settings (add or remove repositories there). */
  manageUrl: z.string().nullable(),
  /** Whether the list was cut off at the most projects listed (GitLab). */
  truncated: z.boolean(),
  repos: z.array(selectableRepoSchema),
});
export type SelectableRepositories = z.infer<typeof selectableRepositoriesSchema>;

/** `code` of a picker list the code host couldn't give. */
export const LISTING_FAILED = "listing_failed";

/** `PUT /api/ui/scm-connections/{id}/repositories` body: the reviewed repositories. */
export const saveSelectionSchema = z.object({
  provider,
  selectedIds: z.array(z.number().int()).max(10_000),
});
export type SaveSelection = z.infer<typeof saveSelectionSchema>;
