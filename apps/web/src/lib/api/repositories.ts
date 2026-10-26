import {
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  RepositoryCodingInput,
  MAX_PATH_EXCLUDES,
  MAX_REVIEW_TASKS,
  PathExcludeGlob,
  RALPH_HISTORY_REWRITE_POLICIES,
  ReviewDepthSchema,
} from "@omniralph/shared";
import { z } from "zod";
import { organizationRefSchema } from "./runs";
import { isoDate, mutationResultSchema } from "./schemas";
import { settingsHistoryEntrySchema } from "./settings-history";
import type { ConnectionHealthSummary } from "@/lib/connections/health";
import type { RepositoryListRow, RepositoryListView } from "@/lib/repositories/list";
import type {
  RepositoryProblem,
  RepositoryProblemAction,
  RepositoryStatus,
} from "@/lib/repositories/status";
import {
  WORK_ITEM_TRACKERS,
  workItemMatchInputSchema,
  workItemMatchSchema,
} from "./work-item-matches";

/** Wire formats of the repository and code-host connection endpoints under `/api/ui`. */

const provider = z.enum(["github", "gitlab"]);

/** A repository's switches on the old Repositories pages: Reviews, Coding and Ask. */
export const repositoryTaskTypesSchema = z.object({
  reviews: z.boolean(),
  coding: z.boolean(),
  ask: z.boolean(),
});
export type RepositoryTaskTypes = z.infer<typeof repositoryTaskTypesSchema>;

/** A connected repository on the old Repositories page (`GET /api/ui/repositories/overview`). */
export const legacyRepositoryRowSchema = z.object({
  id: z.string(),
  provider,
  fullPath: z.string(),
  webUrl: z.string(),
  /** Its Reviews, Coding and Ask switches. */
  taskTypes: repositoryTaskTypesSchema,
  /** The depth its reviews run at. */
  depth: ReviewDepthSchema,
  pinnedAgents: z.array(z.object({ id: z.string(), name: z.string() })),
  lastReviewAt: isoDate.nullable(),
});
export type LegacyRepositoryRow = z.infer<typeof legacyRepositoryRowSchema>;

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

/**
 * `GET /api/ui/repositories/overview?page=`: a page of the active organization's connected
 * repositories, and (admins) its connections: the old Repositories page, until it's removed.
 */
export const legacyRepositoryListSchema = z.object({
  repositories: z.array(legacyRepositoryRowSchema),
  /** 1-based. */
  page: z.number(),
  pageSize: z.number(),
  /** Connected repositories across all pages. */
  total: z.number(),
  /** Admins only (empty for members): the organization's code-host connections. */
  connections: z.array(connectionRowSchema),
});
export type LegacyRepositoryList = z.infer<typeof legacyRepositoryListSchema>;

/** What a repo problem's button does: a `POST` to `path`, or a link to `href`. */
export const repositoryProblemActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("post"), label: z.string(), path: z.string() }),
  z.object({ type: z.literal("link"), label: z.string(), href: z.string() }),
]) satisfies z.ZodType<RepositoryProblemAction>;

/** Something wrong with a repo; problems come in the order webhook, sync_failed, no_agent_online, connection. */
export const repositoryProblemSchema = z.object({
  code: z.enum(["webhook", "sync_failed", "no_agent_online", "connection"]),
  message: z.string(),
  action: repositoryProblemActionSchema.optional(),
}) satisfies z.ZodType<RepositoryProblem>;
export type RepositoryProblemItem = z.infer<typeof repositoryProblemSchema>;

/** Whether something runs on a repo and what is wrong with it (its rail dot and notice). */
export const repositoryStatusSchema = z.object({
  /** Its runs that are queued or running. */
  running: z.number(),
  problems: z.array(repositoryProblemSchema),
}) satisfies z.ZodType<RepositoryStatus>;

/** A row of the Repos rail (`RepositoryListRow`). */
export const repositoryListRowSchema = z.object({
  id: z.string(),
  /** Its organization, and the user's role there. */
  organization: organizationRefSchema,
  provider,
  fullPath: z.string(),
  /** The last path segment. */
  name: z.string(),
  /** The path before `name`, or null. */
  group: z.string().nullable(),
  webUrl: z.string(),
  reviewsEnabled: z.boolean(),
  codingEnabled: z.boolean(),
  askEnabled: z.boolean(),
  status: repositoryStatusSchema,
}) satisfies z.ZodType<RepositoryListRow>;
export type RepositoryListItem = z.infer<typeof repositoryListRowSchema>;

/**
 * `GET /api/ui/repositories?organization=<id|all>` (members): the Repos rail, every
 * connected repo of the scope by organization name, then path, at most 500 (`truncated`
 * when there are more). An organization the user isn't a member of answers 404.
 */
export const repositoryListSchema = z.object({
  repositories: z.array(repositoryListRowSchema),
  truncated: z.boolean(),
}) satisfies z.ZodType<RepositoryListView>;
export type RepositoryList = z.infer<typeof repositoryListSchema>;

/**
 * `GET /api/ui/repositories/setup?organization=` (admins of that organization): what the
 * Connect buttons need. Not polled.
 */
export const repositorySetupSchema = z.object({
  /**
   * Our install route for the organization (it adds the signed `state`), or null when the
   * GitHub App isn't configured.
   */
  githubInstallPath: z.string().nullable(),
  /** The Connect GitLab form's default URL. */
  defaultGitLabUrl: z.string(),
});
export type RepositorySetup = z.infer<typeof repositorySetupSchema>;

/** `GET /api/ui/repositories/setup` query: the organization the connection is for. */
export const repositorySetupQuerySchema = z.object({ organization: z.string().optional() });

/** `POST /api/ui/gitlab-connections` body: the Connect GitLab form and its organization. */
export const connectGitLabSchema = z.object({
  baseUrl: z.string(),
  token: z.string(),
  /** The organization to connect GitLab to (the active one when left out). */
  organizationId: z.string().optional(),
});

/** `POST /api/ui/gitlab-connections` response: the connection, whose projects are picked next. */
export const connectedGitLabSchema = mutationResultSchema.extend({ connectionId: z.string() });

/** `GET /api/ui/scm-connections/{id}?provider=`: a connection, for its picker's header. */
export const scmConnectionSchema = z.object({ id: z.string(), provider, name: z.string() });
export type ScmConnectionSummary = z.infer<typeof scmConnectionSchema>;

/** A connection's health problem in plain words (`connectionHealth`). */
export const connectionHealthProblemSchema = z.object({
  code: z.string(),
  sentence: z.string(),
  /** The repo the problem is about (webhook problems). */
  repositoryId: z.string().optional(),
});

/** A connection's health (`connectionHealth` in `@/lib/connections/health`). */
export const connectionHealthSummarySchema = z.object({
  state: z.enum(["healthy", "expiring", "needs_attention", "not_checked", "connected"]),
  /** ISO date the bot token expires, when GitLab reports it. */
  expiresAt: z.string().optional(),
  problems: z.array(connectionHealthProblemSchema),
}) satisfies z.ZodType<ConnectionHealthSummary>;

/** A GitHub App installation or GitLab connection, as the add-repo sheet lists it. */
export const scmConnectionListRowSchema = z.object({
  id: z.string(),
  provider,
  name: z.string(),
  /** The code host's web host, e.g. `github.com` or `gitlab.example.com`. */
  host: z.string(),
  health: connectionHealthSummarySchema,
});
export type ScmConnectionListRow = z.infer<typeof scmConnectionListRowSchema>;

/**
 * `GET /api/ui/scm-connections?organization=` (admins of that organization): the
 * organization's code-host connections with their health, by name.
 */
export const scmConnectionListSchema = z.object({
  connections: z.array(scmConnectionListRowSchema),
});
export type ScmConnectionList = z.infer<typeof scmConnectionListSchema>;

/** `GET /api/ui/scm-connections` query. */
export const scmConnectionListQuerySchema = z.object({ organization: z.string().optional() });

/** A repository (GitHub) or project (GitLab) the connection can access. */
export const selectableRepoSchema = z.object({
  id: z.number(),
  fullPath: z.string(),
  private: z.boolean(),
  htmlUrl: z.string(),
  /** Already connected here (whatever its switches). */
  connected: z.boolean(),
});
export type SelectableRepoRow = z.infer<typeof selectableRepoSchema>;

/**
 * `GET /api/ui/scm-connections/{id}/repositories?provider=&organization=` (admins of that
 * organization): what the picker lists, from the code host (an external call: loaded once,
 * refreshed on request). A failure answers 502 `LISTING_FAILED` with the code host's error
 * as the message.
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

/** `GET /api/ui/scm-connections/{id}/repositories` query. */
export const selectableRepositoriesQuerySchema = z.object({
  /** The picker asking: a connection of the other code host is not found. */
  provider,
  organization: z.string().optional(),
});

/** `code` of a picker list the code host couldn't give. */
export const LISTING_FAILED = "listing_failed";

/**
 * `POST /api/ui/scm-connections/{id}/repositories` body: the repositories (GitHub) or projects
 * (GitLab) to connect, by code-host ID. Add-only: repos left out are never changed.
 */
export const addRepositoriesSchema = z
  .object({
    provider,
    ids: z.array(z.number().int().positive()).min(1).max(1000),
    organizationId: z.string(),
  })
  .strict();
export type AddRepositoriesInput = z.infer<typeof addRepositoriesSchema>;

/** `POST /api/ui/scm-connections/{id}/repositories` response: the repos connected. */
export const addedRepositoriesSchema = mutationResultSchema.extend({
  added: z.array(z.object({ id: z.string(), fullPath: z.string() })),
});
export type AddedRepositories = z.infer<typeof addedRepositoriesSchema>;

/** An agent of the organization, as Repository › Agents shows (and pins) it. */
export const repositoryAgentSchema = z.object({
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
 * `GET /api/ui/repositories/{id}/overview?next=`: a connected repository with what the old
 * Review settings and Agents tabs show (and the Coding tab's task types), until those pages
 * are removed. A repository of another of the user's organizations answers 409
 * `enter_organization`.
 */
export const legacyRepositoryDetailSchema = z.object({
  repository: z.object({ id: z.string(), provider, fullPath: z.string(), webUrl: z.string() }),
  settings: z.object({
    /** The depth its reviews run at (`REVIEW_DEPTHS` in `@omniralph/shared` has the presets). */
    depth: ReviewDepthSchema,
    triggers: z.object({ onOpen: z.boolean(), onPush: z.boolean(), drafts: z.boolean() }),
    pathExcludes: z.array(z.string()),
    customInstructions: z.string(),
    pinnedAgentIds: z.array(z.string()),
    /** The review and review-summary playbooks its review runs fan out to, in order. */
    reviewPlaybookIds: z.array(z.string()),
    /** The playbook that correlates its review runs' findings. */
    correlationPlaybookId: z.string(),
    /** The story playbook its story runs use. */
    storyPlaybookId: z.string(),
    /** The request playbook its request runs use. */
    requestPlaybookId: z.string(),
  }),
  /** The organization's agents; revoked ones can't be pinned but show in the pinned list. */
  agents: z.array(repositoryAgentSchema),
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
export type LegacyRepositoryDetail = z.infer<typeof legacyRepositoryDetailSchema>;

// ── The Repos page's repo detail (`GET /api/ui/repositories/{id}`) ──────────────────────────
// Each card's shape is its own schema: the card save endpoints answer with the same one.

/** The Reviews card: when and how Om reviews the repo's pull requests. */
export const reviewsCardSchema = z.object({
  enabled: z.boolean(),
  triggers: z.object({ onOpen: z.boolean(), onPush: z.boolean(), drafts: z.boolean() }),
  depth: ReviewDepthSchema,
  pathExcludes: z.array(z.string()),
  /** Empty for none. */
  reviewerInstructions: z.string(),
});
export type ReviewsCard = z.infer<typeof reviewsCardSchema>;

/** A routing rule that sends work to the repo: its 1-based position and condition in words. */
export const repositoryRoutingRuleSchema = z.object({
  position: z.number(),
  description: z.string(),
});

/** The Coding card: which work items Om builds here, and how. */
export const codingCardSchema = z.object({
  enabled: z.boolean(),
  /** The work items it builds; null when it has no match. */
  workItemMatch: workItemMatchSchema.nullable(),
  /** Appended to every story and request prompt; empty for none. */
  codingInstructions: z.string(),
  /** Open a draft PR after the first pushed story. */
  openPullRequestEarly: z.boolean(),
  historyRewrite: z.enum(RALPH_HISTORY_REWRITE_POLICIES),
  /** Fix review comments and CI failures on its runs' PRs. */
  respondToReviewsAndCi: z.boolean(),
  /** Read-only: the story playbook's review and CI fix rounds ("up to 3 rounds each"). */
  roundLimits: z.object({ review: z.number(), fix: z.number() }),
  /**
   * Every routing rule of the organization that targets the repo (they apply before any
   * match), in routing order, whatever the viewer's preferences.
   */
  routingRules: z.array(repositoryRoutingRuleSchema),
});
export type CodingCard = z.infer<typeof codingCardSchema>;

/** The Ask card: whether Om answers questions about the repo's code. */
export const askCardSchema = z.object({ enabled: z.boolean() });
export type AskCard = z.infer<typeof askCardSchema>;

/**
 * A pinned agent's state on the Agents card: `revoked`, else `offline` (no recent
 * heartbeat), else `running` (attempts of this repo in progress), else `updating` (updating
 * itself), else `idle`.
 */
export const REPOSITORY_AGENT_STATES = [
  "running",
  "idle",
  "offline",
  "updating",
  "revoked",
] as const;
export type RepositoryAgentState = (typeof REPOSITORY_AGENT_STATES)[number];

/** The Agents card: the agents the repo's work runs on (any agent when none is pinned). */
export const agentsCardSchema = z.object({
  /** The pinned agents, by name (revoked ones last). */
  pinned: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      state: z.enum(REPOSITORY_AGENT_STATES),
      /** Its attempts of this repo's runs in progress. */
      runningForRepo: z.number().int().min(0),
    }),
  ),
  /** What "Pin agent" offers: the organization's agents that aren't pinned, revoked or deleted. */
  pinnable: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type AgentsCard = z.infer<typeof agentsCardSchema>;
export type PinnedAgent = AgentsCard["pinned"][number];

/** A playbook a binding may use. */
export const playbookChoiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  builtin: z.boolean(),
});

/** One entry per binding: `review` (the review playbooks), `correlation`, `story`, `request`. */
const perBinding = <T extends z.ZodType>(value: T) =>
  z.object({ review: value, correlation: value, story: value, request: value });

/**
 * The Playbooks card: the playbook each of the repo's runs uses. Always filled: the viewer's
 * "Show advanced settings" preference only shows or hides the card.
 */
export const playbooksCardSchema = z.object({
  bindings: z.object({
    /** The review and review-summary playbooks its reviews fan out to, in order. */
    review: z.array(z.string()),
    /** The playbook that combines its review runs' findings. */
    correlation: z.string(),
    story: z.string(),
    request: z.string(),
  }),
  /** Each binding's choices: the built-ins of its roles first, then the organization's own. */
  choices: perBinding(z.array(playbookChoiceSchema)),
});
export type PlaybooksCard = z.infer<typeof playbooksCardSchema>;

/** A review depth preset as the Depth control and its "<Depth> review profile" popover show it. */
export const reviewDepthOptionSchema = z.object({
  id: ReviewDepthSchema,
  label: z.string(),
  /** One sentence: what a review at this depth does. */
  summary: z.string(),
  details: z.object({
    model: z.string(),
    tokenCap: z.string(),
    reads: z.string(),
    comments: z.string(),
    typicalTime: z.string(),
  }),
});
export type ReviewDepthOption = z.infer<typeof reviewDepthOptionSchema>;

/** A connected tracker the work item match can read from. */
export const repositoryTrackerSchema = z.object({
  tracker: z.enum(WORK_ITEM_TRACKERS),
  id: z.string(),
  /** The tracker's workspace (Linear workspace name). */
  workspaceName: z.string(),
});
export type RepositoryTracker = z.infer<typeof repositoryTrackerSchema>;

/** The latest change of a card's settings section, with the runs since; null before any. */
const latestChange = settingsHistoryEntrySchema.nullable();

/**
 * `GET /api/ui/repositories/{id}` (members): everything the Repos page shows for a connected
 * repo of any of the user's organizations. Another organization's (or a disconnected) repo
 * answers 404. Nothing in it depends on the viewer's preferences.
 */
export const repositoryDetailSchema = z.object({
  repository: z.object({
    id: z.string(),
    /** Its organization, and the user's role there. */
    organization: organizationRefSchema,
    provider,
    fullPath: z.string(),
    /** The last path segment. */
    name: z.string(),
    /** The path before `name`, or null. */
    group: z.string().nullable(),
    webUrl: z.string(),
    /** Null until it is known. */
    defaultBranch: z.string().nullable(),
  }),
  /** The user is an admin of the repo's organization. */
  canEdit: z.boolean(),
  status: repositoryStatusSchema,
  reviews: reviewsCardSchema,
  /** Every review depth, fastest first. */
  depths: z.array(reviewDepthOptionSchema),
  coding: codingCardSchema,
  /** The organization's connected trackers. */
  trackers: z.array(repositoryTrackerSchema),
  ask: askCardSchema,
  agents: agentsCardSchema,
  playbooks: playbooksCardSchema,
  /** Each card's latest change (its ⓘ). */
  history: z.object({
    reviews: latestChange,
    coding: latestChange,
    ask: latestChange,
    agents: latestChange,
    playbooks: latestChange,
  }),
});
export type RepositoryDetail = z.infer<typeof repositoryDetailSchema>;

// ── Card saves (`PUT /api/ui/repositories/{id}/<card>`) ─────────────────────────────────────
// Each takes exactly its card's fields (any other key answers 400) and answers
// `{ ok: true, card }` with the saved card in the detail's shape.

const onOff = z.boolean({ error: "Choose on or off." });

/** `PUT /api/ui/repositories/{id}/reviews` body: the whole Reviews card. */
export const reviewsCardInputSchema = z.strictObject({
  reviewsEnabled: onOff,
  triggers: z.strictObject({ onOpen: onOff, onPush: onOff, drafts: onOff }),
  depth: ReviewDepthSchema,
  pathExcludes: z
    .array(PathExcludeGlob)
    .max(MAX_PATH_EXCLUDES, `At most ${MAX_PATH_EXCLUDES} patterns.`),
  /** Empty for none; surrounding spaces are dropped. */
  reviewerInstructions: z
    .string()
    .max(
      MAX_CUSTOM_INSTRUCTIONS_LENGTH,
      `Reviewer instructions can be at most ${MAX_CUSTOM_INSTRUCTIONS_LENGTH.toLocaleString("en-US")} characters.`,
    ),
});
export type ReviewsCardInput = z.infer<typeof reviewsCardInputSchema>;

/** `PUT /api/ui/repositories/{id}/ask` body. */
export const askCardInputSchema = z.strictObject({ askEnabled: onOff });
export type AskCardInput = z.infer<typeof askCardInputSchema>;

/** `PUT /api/ui/repositories/{id}/agents` body: every pinned agent (none: any agent). */
export const agentsCardInputSchema = z.strictObject({
  pinnedAgentIds: z.array(z.uuid({ error: "Choose an agent." })).max(100, "At most 100 agents."),
});
export type AgentsCardInput = z.infer<typeof agentsCardInputSchema>;

const playbookId = (message: string) => z.string({ error: message }).min(1, message).max(200);

/** `PUT /api/ui/repositories/{id}/playbooks` body: every binding (the server checks roles). */
export const playbooksCardInputSchema = z.strictObject({
  bindings: z.strictObject({
    review: z
      .array(z.string().min(1).max(200))
      .min(1, "Choose a review playbook.")
      .max(MAX_REVIEW_TASKS, `At most ${MAX_REVIEW_TASKS} review playbooks.`)
      .refine((ids) => new Set(ids).size === ids.length, "Choose each review playbook once."),
    correlation: playbookId("Choose a playbook that combines review findings."),
    story: playbookId("Choose a stories playbook."),
    request: playbookId("Choose a requests playbook."),
  }),
});
export type PlaybooksCardInput = z.infer<typeof playbooksCardInputSchema>;

/**
 * `PUT /api/ui/repositories/{id}/coding` body: the whole Coding card, its switch, work item
 * match (null for none) and policy, saved together.
 */
export const codingCardInputSchema = RepositoryCodingInput.extend({
  workItemMatch: workItemMatchInputSchema.nullable(),
});
export type CodingCardInput = z.infer<typeof codingCardInputSchema>;

/** `POST /api/ui/repositories/{id}/coding/match-check` body: an unsaved match. */
export const codingMatchCheckInputSchema = z.strictObject({
  workItemMatch: workItemMatchInputSchema,
});
export type CodingMatchCheckInput = z.infer<typeof codingMatchCheckInputSchema>;

/**
 * Another repo whose work item match conflicts with this one's (the same tracker, team and
 * project condition, with labels in common or both without): a work item both match asks
 * which repo to use.
 */
export const codingMatchWarningSchema = z.object({
  id: z.string(),
  fullPath: z.string(),
  provider,
  message: z.string(),
});
export type CodingMatchWarning = z.infer<typeof codingMatchWarningSchema>;

/** `POST /api/ui/repositories/{id}/coding/match-check`'s answer. */
export const codingMatchCheckSchema = z.object({ warnings: z.array(codingMatchWarningSchema) });
export type CodingMatchCheck = z.infer<typeof codingMatchCheckSchema>;

/** What a card save answers: the saved card, as the detail shows it. */
export const cardSaveResultSchema = <T extends z.ZodType>(card: T) =>
  z.object({ ok: z.literal(true), card });

/** `PUT /api/ui/repositories/{id}/coding`'s answer: the saved card and its match's conflicts. */
export const codingCardSaveResultSchema = z.object({
  ok: z.literal(true),
  card: codingCardSchema,
  warnings: z.array(codingMatchWarningSchema),
});
export type CodingCardSaveResult = z.infer<typeof codingCardSaveResultSchema>;

/**
 * `GET /api/ui/repositories/{id}/coding` (admins, the old Coding tab): the repo's coding policy
 * (`RepositoryCodingInput`), and the review and CI fix rounds its story playbook gives a PR
 * (read-only: they're the playbook's).
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
