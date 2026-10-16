import {
  RALPH_CODING_PATHS,
  RALPH_HISTORY_REWRITE_POLICIES,
  type RalphSettingsInput,
} from "@omniralph/shared";
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

const taskChoiceSchema = z.object({ id: z.string(), name: z.string(), builtin: z.boolean() });
const taskSwitch = z.boolean().nullable();

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
  /** Task types it may claim jobs of, the organization's defaults filled in. */
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
    profileId: z.string(),
    triggers: z.object({ onOpen: z.boolean(), onPush: z.boolean(), drafts: z.boolean() }),
    pathExcludes: z.array(z.string()),
    customInstructions: z.string(),
    pinnedHarnessIds: z.array(z.string()),
    reviewTaskIds: z.array(z.string()),
    correlationTaskId: z.string(),
  }),
  /** The review tasks the repository can run on its PRs/MRs (built-in and the organization's). */
  reviewTasks: z.array(taskChoiceSchema.extend({ description: z.string() })),
  /** The tasks that can correlate its review runs' findings. */
  correlationTasks: z.array(taskChoiceSchema),
  profiles: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      model: z.string(),
      maxTokensPerReview: z.number(),
      maxFiles: z.number(),
      allowRepoExploration: z.boolean(),
    }),
  ),
  /** The organization's harnesses; revoked ones can't be pinned but show in the pinned list. */
  harnesses: z.array(repositoryHarnessSchema),
  /** Query, Reviews and Coding: the repository's own values and the organization's defaults. */
  taskTypes: z.object({
    overrides: z.object({ query: taskSwitch, review: taskSwitch, coding: taskSwitch }),
    inherited: z.object({ query: z.boolean(), review: z.boolean(), coding: z.boolean() }),
  }),
});
export type RepositoryDetail = z.infer<typeof repositoryDetailSchema>;

/** The Coding tab's saved values, as its form edits them (`RalphSettingsInput`). */
const codingSettingsSchema = z.object({
  linearTeamKeys: z.array(z.string()),
  linearProjectNames: z.array(z.string()),
  linearLabels: z.array(z.string()),
  codingPath: z.enum(RALPH_CODING_PATHS),
  storyTaskId: z.string(),
  requestTaskId: z.string(),
  verifyCommands: z.array(z.string()),
  runPrdQualityGates: z.boolean(),
  setupCommand: z.string(),
  appendInstruction: z.string(),
  model: z.string(),
  fallbackModel: z.string(),
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()),
  openPullRequestEarly: z.boolean(),
  historyRewrite: z.enum(RALPH_HISTORY_REWRITE_POLICIES),
  respondToReviews: z.boolean(),
  maxReviewRounds: z.number(),
  respondToCiFailures: z.boolean(),
  maxFixRounds: z.number(),
  cleanupMergedWorktrees: z.boolean(),
  unmergedBranchTimeoutMinutes: z.number(),
  manualLabels: z.array(z.string()),
  blockedLabels: z.array(z.string()),
  allowPreparation: z.boolean(),
  epicCompletedState: z.string(),
}) satisfies z.ZodType<RalphSettingsInput>;

/**
 * `GET /api/ui/repositories/{id}/coding` (admins): the Coding tab's settings and its pickers'
 * choices from the database, polled. The Linear workspace's values are a separate query.
 */
export const repositoryCodingSchema = z.object({
  settings: codingSettingsSchema,
  /** The coding tasks its story and request runs can use (built-in and the organization's). */
  tasks: z.object({ story: z.array(taskChoiceSchema), request: z.array(taskChoiceSchema) }),
  /** The models reported by the harnesses that may run its coding jobs. */
  models: z.array(
    z.object({ value: z.string(), displayName: z.string(), harnessIds: z.array(z.string()) }),
  ),
  /** How many harnesses may run its coding jobs (its pinned ones, else every one accepting coding). */
  harnessCount: z.number(),
  /** Whether those are its pinned harnesses. */
  pinned: z.boolean(),
});
export type RepositoryCoding = z.infer<typeof repositoryCodingSchema>;

/**
 * `GET /api/ui/repositories/{id}/coding/linear` (admins): the organization's Linear workspace
 * the Coding tab's Linear fields pick from. An external call: not polled.
 */
export const codingLinearSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("connected"),
    options: z.object({
      teams: z.array(z.object({ key: z.string(), name: z.string() })),
      labels: z.array(z.string()),
      projects: z.array(z.string()),
      states: z.array(z.string()),
    }),
  }),
  z.object({ status: z.literal("disconnected") }),
  z.object({ status: z.literal("unavailable") }),
]);
export type CodingLinear = z.infer<typeof codingLinearSchema>;
