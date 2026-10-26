import { RALPH_HISTORY_REWRITE_POLICIES, ReviewDepthSchema } from "@omniralph/shared";
import { z } from "zod";
import { isoDate, mutationResultSchema } from "./schemas";
import { workItemMatchSchema } from "./work-item-matches";

/** Wire formats of the repository and code-host connection endpoints under `/api/ui`. */

const provider = z.enum(["github", "gitlab"]);

/**
 * A repository's switches: Reviews, Coding and Ask (externally triggered queries), each on or
 * off. `GET`/`PUT /api/ui/repositories/{id}/task-types` (admins) answer it; `PUT` takes it
 * (`RepositoryTaskTypesInput`).
 */
export const repositoryTaskTypesSchema = z.object({
  reviews: z.boolean(),
  coding: z.boolean(),
  ask: z.boolean(),
});
export type RepositoryTaskTypes = z.infer<typeof repositoryTaskTypesSchema>;

/** A connected repository on the Repositories page. */
export const repositoryRowSchema = z.object({
  id: z.string(),
  provider,
  fullPath: z.string(),
  webUrl: z.string(),
  /** Its Reviews, Coding and Ask switches. */
  taskTypes: repositoryTaskTypesSchema,
  /** The depth its reviews run at. */
  depth: ReviewDepthSchema,
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

/** A harness of the organization, as Repository › Harnesses shows (and pins) it. */
export const repositoryHarnessSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** The page computes `online` from it against the browser's clock. */
  lastHeartbeatAt: isoDate.nullable(),
  online: z.boolean(),
  revoked: z.boolean(),
  /** It is updating itself to its desired version. */
  updating: z.boolean(),
  /** Task types it claims jobs of, as it reports them (all until it reports any). */
  acceptedTaskTypes: z.array(z.string()),
});

/**
 * `GET /api/ui/repositories/{id}?next=`: a connected repository with what its Review settings
 * and Harnesses tabs show (and the Coding tab's task types), polled. A repository of another
 * of the user's organizations answers 409 `enter_organization`.
 */
export const repositoryDetailSchema = z.object({
  repository: z.object({ id: z.string(), provider, fullPath: z.string(), webUrl: z.string() }),
  settings: z.object({
    /** The depth its reviews run at (`REVIEW_DEPTHS` in `@omniralph/shared` has the presets). */
    depth: ReviewDepthSchema,
    triggers: z.object({ onOpen: z.boolean(), onPush: z.boolean(), drafts: z.boolean() }),
    pathExcludes: z.array(z.string()),
    customInstructions: z.string(),
    pinnedHarnessIds: z.array(z.string()),
    /** The review and review-summary playbooks its review runs fan out to, in order. */
    reviewPlaybookIds: z.array(z.string()),
    /** The playbook that correlates its review runs' findings. */
    correlationPlaybookId: z.string(),
    /** The story playbook its story runs use. */
    storyPlaybookId: z.string(),
    /** The request playbook its request runs use. */
    requestPlaybookId: z.string(),
  }),
  /** The organization's harnesses; revoked ones can't be pinned but show in the pinned list. */
  harnesses: z.array(repositoryHarnessSchema),
  /** Its Reviews, Coding and Ask switches. */
  taskTypes: repositoryTaskTypesSchema,
  /** The work items it builds; null when it has no match. */
  workItemMatch: workItemMatchSchema.nullable(),
  /**
   * The organization's routing rules that target it, which apply before any work item match:
   * position (1-based, in order, as `rule N` in `routed_by`) and condition in words.
   */
  routingRules: z.array(z.object({ position: z.number(), description: z.string() })),
});
export type RepositoryDetail = z.infer<typeof repositoryDetailSchema>;

/**
 * `GET`/`PUT /api/ui/repositories/{id}/coding` (admins): the repo's coding policy, exactly what
 * `PUT` takes (`RepositoryCodingInput`), and the review and CI fix rounds its story playbook
 * gives a PR (read-only: they're the playbook's).
 */
export const repositoryCodingSchema = z.object({
  /** Whether work items routed to it are built. */
  codingEnabled: z.boolean(),
  /** Appended to every story and request prompt; null for none. */
  codingInstructions: z.string().nullable(),
  /** Open a draft PR after the first pushed story. */
  openPullRequestEarly: z.boolean(),
  historyRewrite: z.enum(RALPH_HISTORY_REWRITE_POLICIES),
  /** Fix review comments and CI failures on its runs' PRs. */
  respondToReviewsAndCi: z.boolean(),
  /** Read-only: the story playbook's rounds ("up to 3 rounds each"). */
  roundLimits: z.object({ maxReviewRounds: z.number(), maxFixRounds: z.number() }),
});
export type RepositoryCoding = z.infer<typeof repositoryCodingSchema>;
