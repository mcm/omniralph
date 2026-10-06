/**
 * Drizzle schema for the Omniralph control panel. Postgres is the single source
 * of truth for repos, reviews, agents and jobs.
 *
 * After changing this file run `pnpm --filter db generate` to emit a migration
 * into `packages/db/drizzle`, then `pnpm --filter db migrate` to apply it.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ── Enums ────────────────────────────────────────────────────────────────────

export const userRole = pgEnum("user_role", ["admin", "member"]);
export const uiTheme = pgEnum("ui_theme", ["light", "dark"]);
export const scmProvider = pgEnum("scm_provider", ["github", "gitlab"]);
/** Sources of webhook deliveries: the code hosts plus Linear. */
export const webhookProvider = pgEnum("webhook_provider", ["github", "gitlab", "linear"]);
export const integrationProvider = pgEnum("integration_provider", ["linear"]);
export const reviewTrigger = pgEnum("review_trigger", ["webhook", "mention", "manual"]);
export const reviewStatus = pgEnum("review_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "budget_exhausted",
  "skipped",
]);
export const findingSeverity = pgEnum("finding_severity", [
  "critical",
  "high",
  "medium",
  "low",
  "info",
]);
export const findingStatus = pgEnum("finding_status", [
  "open",
  "dismissed",
  "resolved",
  "superseded",
]);
export const feedbackSource = pgEnum("feedback_source", ["ui", "scm"]);
export const feedbackReason = pgEnum("feedback_reason", [
  "false_positive",
  "wont_fix",
  "not_relevant",
  "other",
]);
export const ruleKind = pgEnum("rule_kind", ["custom", "learned"]);
export const agentAuditEvent = pgEnum("agent_audit_event", [
  "enroll",
  "token_refresh",
  "refresh_reuse",
  "revoke",
  "credential_issued",
  "result_submitted",
  "auth_failed",
]);
export const ralphRunKind = pgEnum("ralph_run_kind", ["children", "prd", "single"]);
export const ralphRunStatus = pgEnum("ralph_run_status", [
  "pending",
  "running",
  "waiting",
  "completed",
  "failed",
  "stopped",
]);
export const ralphStoryStatus = pgEnum("ralph_story_status", [
  "pending",
  "running",
  "completed",
  "blocked",
  "exhausted",
  "manual",
  /** Canceled in Linear: done without work. */
  "canceled",
]);
/** A live message's kind: story guidance, or a request (handled as one, not as guidance). */
export const ralphMessageKind = pgEnum("ralph_message_kind", ["guidance", "request"]);
/**
 * How a run treats its session: `epic` builds the epic story by story (a
 * delegation, or `/ralph`); `request` only does what a mention asks.
 */
export const ralphRunMode = pgEnum("ralph_run_mode", ["epic", "request"]);
export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
  "expired",
  /** Nothing to do (e.g. a review of a head SHA that already has a completed review). */
  "skipped",
]);

// ── Auth.js (@auth/drizzle-adapter compatible) ───────────────────────────────

export const users = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name"),
  email: text("email").unique(),
  emailVerified: timestamp("email_verified", { mode: "date", withTimezone: true }),
  image: text("image"),
  /** `admin` manages repos, agents and users; `member` has read access. The first user is `admin`. */
  role: userRole("role").notNull().default("member"),
  /** The user's chosen control panel theme; `null` follows the OS preference. */
  theme: uiTheme("theme"),
  createdAt: createdAt(),
});

/**
 * Emails an admin has allowed to sign in (in addition to `ALLOWED_EMAIL_DOMAINS`).
 * `role` is applied when that person first signs in.
 */
export const allowedEmails = pgTable("allowed_emails", {
  /** Lower-cased email address. */
  email: text("email").primaryKey(),
  role: userRole("role").notNull().default("member"),
  addedBy: text("added_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.providerAccountId] }),
    index("accounts_user_id_idx").on(t.userId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    sessionToken: text("session_token").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expires: timestamp("expires", { mode: "date", withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

// ── Code hosts and repositories ──────────────────────────────────────────────

export const scmConnections = pgTable(
  "scm_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: scmProvider("provider").notNull(),
    name: text("name").notNull(),
    /** API base URL, e.g. https://api.github.com or https://gitlab.example.com. */
    baseUrl: text("base_url").notNull(),
    /** Provider-side identifier, e.g. the GitHub App installation ID or GitLab group path. */
    externalId: text("external_id"),
    /** JSON credentials encrypted with `encrypt()` (AES-256-GCM). */
    encryptedCredentials: text("encrypted_credentials").notNull(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("scm_connections_provider_base_url_external_id_uq").on(
      t.provider,
      t.baseUrl,
      t.externalId,
    ),
  ],
);

// ── Integrations (issue trackers) ────────────────────────────────────────────

/**
 * An installed issue-tracker app, e.g. the Omniralph Linear app in one Linear
 * workspace (`external_id` = the workspace/organization ID).
 */
export const integrations = pgTable(
  "integrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: integrationProvider("provider").notNull(),
    externalId: text("external_id").notNull(),
    /** Workspace name, for display. */
    name: text("name").notNull(),
    /** JSON credentials (OAuth tokens and expiry) encrypted with `encrypt()` (AES-256-GCM). */
    encryptedCredentials: text("encrypted_credentials").notNull(),
    installedByUserId: text("installed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  /** At most one connected workspace per provider (e.g. one Linear workspace). */
  (t) => [uniqueIndex("integrations_provider_uq").on(t.provider)],
);

/**
 * OAuth `state` nonces already used by an integration callback, so a replayed
 * callback is rejected. Rows are kept until the state would have expired.
 */
export const oauthStateUses = pgTable(
  "oauth_state_uses",
  {
    /** SHA-256 (hex) of the state's nonce. */
    nonceHash: text("nonce_hash").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_state_uses_expires_at_idx").on(t.expiresAt)],
);

export const reviewProfiles = pgTable("review_profiles", {
  /** Stable slug, e.g. `quick`, `standard`, `deep`. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  model: text("model").notNull(),
  maxTokensPerReview: integer("max_tokens_per_review").notNull(),
  maxFiles: integer("max_files").notNull(),
  allowRepoExploration: boolean("allow_repo_exploration").notNull(),
  builtIn: boolean("built_in").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export interface RepositoryTriggers {
  onOpen: boolean;
  onPush: boolean;
  drafts: boolean;
}

export const DEFAULT_REPOSITORY_TRIGGERS: RepositoryTriggers = {
  onOpen: true,
  onPush: true,
  drafts: false,
};

export const DEFAULT_PROFILE_ID = "standard";

/**
 * Per-repository settings of the `ralph` capability (`repositories.ralph_settings`),
 * validated by `RalphSettings` in `@omniralph/shared` (which documents each one).
 */
export interface RalphSettings {
  verifyCommands: string[];
  runPrdQualityGates: boolean;
  appendInstruction: string | null;
  allowedTools: string[] | null;
  disallowedTools: string[] | null;
  /** Claude model (alias or ID) the sessions use. */
  model: string;
  fallbackModel: string | null;
  allowPreparation: boolean;
  /**
   * Linear labels marking a story as a manual step (matched ignoring case); the
   * first one labels the manual stories and follow-ups ralph files.
   */
  manualLabels: string[];
  historyRewrite: "when-asked" | "never";
  respondToReviews: boolean;
  maxReviewRounds: number;
  respondToCiFailures: boolean;
  maxFixRounds: number;
  cleanupMergedWorktrees: boolean;
  unmergedBranchTimeoutMinutes: number;
  /** A state type (`started`, `completed`) or name the epic moves to when every story is complete. */
  epicCompletedState: string | null;
  /** Open a draft PR/MR after the first pushed story (updated and marked ready at the end). */
  openPullRequestEarly: boolean;
  /** Run once in a fresh branch worktree (e.g. `pnpm install`); null for none. */
  setupCommand: string | null;
}

export const DEFAULT_RALPH_SETTINGS: RalphSettings = {
  verifyCommands: [],
  runPrdQualityGates: true,
  appendInstruction: null,
  allowedTools: null,
  disallowedTools: null,
  model: "opus",
  fallbackModel: null,
  allowPreparation: true,
  manualLabels: ["manual"],
  historyRewrite: "when-asked",
  respondToReviews: true,
  maxReviewRounds: 3,
  respondToCiFailures: true,
  maxFixRounds: 3,
  cleanupMergedWorktrees: true,
  unmergedBranchTimeoutMinutes: 60,
  epicCompletedState: null,
  openPullRequestEarly: false,
  setupCommand: null,
};

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    provider: scmProvider("provider").notNull(),
    /** Provider repository/project ID. */
    externalId: text("external_id").notNull(),
    /** `owner/repo` or the GitLab `group/subgroup/project` path. */
    fullPath: text("full_path").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => scmConnections.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    profileId: text("profile_id")
      .notNull()
      .default(DEFAULT_PROFILE_ID)
      .references(() => reviewProfiles.id),
    triggers: jsonb("triggers")
      .$type<RepositoryTriggers>()
      .notNull()
      .default(DEFAULT_REPOSITORY_TRIGGERS),
    pathExcludes: text("path_excludes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    customInstructions: text("custom_instructions"),
    /** Linear delegations may build in this repository (`ralph` capability). */
    ralphEnabled: boolean("ralph_enabled").notNull().default(false),
    /** Linear routing: team keys (e.g. `ENG`), project names and labels routed here. */
    linearTeamKeys: text("linear_team_keys")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    linearProjectNames: text("linear_project_names")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    linearLabels: text("linear_labels")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ralphSettings: jsonb("ralph_settings")
      .$type<RalphSettings>()
      .notNull()
      .default(DEFAULT_RALPH_SETTINGS),
    /** GitLab project webhook ID created on connect (deleted on disconnect). */
    webhookId: text("webhook_id"),
    /**
     * Set when an admin disconnects the repo: it's disabled, unpinned and hidden from the
     * Repositories list, but its review history is kept. Reconnecting clears it.
     */
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("repositories_connection_external_id_uq").on(t.connectionId, t.externalId)],
);

// ── Agents ───────────────────────────────────────────────────────────────────

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  maxConcurrency: integer("max_concurrency").notNull().default(1),
  pollIntervalSeconds: integer("poll_interval_seconds").notNull().default(5),
  enabledCapabilities: text("enabled_capabilities")
    .array()
    .notNull()
    .default(sql`'{review}'::text[]`),
  /**
   * Per-capability caps on concurrent jobs (e.g. `{ "ralph": 1 }`), within
   * `maxConcurrency`. Unset capabilities use the protocol's default limit.
   */
  capabilityLimits: jsonb("capability_limits")
    .$type<Partial<Record<string, number>>>()
    .notNull()
    .default({}),
  reportedVersion: text("reported_version"),
  reportedCapabilities: text("reported_capabilities").array(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  enrolledBy: text("enrolled_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const agentEnrollments = pgTable("agent_enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** `hashToken()` of the one-time enrollment token; the token itself is never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  /** Display name for the agent this enrollment creates. */
  name: text("name"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  /** The agent created when the token was redeemed. */
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

/**
 * Opaque refresh tokens an agent exchanges for 15-minute access JWTs. Every refresh marks the
 * presented token used and issues a new one in the same family; presenting a used token again
 * revokes the family and the agent (theft detection).
 */
export const agentRefreshTokens = pgTable(
  "agent_refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    /** Rotation chain: one per enrollment. */
    familyId: uuid("family_id").notNull(),
    /** `hashToken()` of the 256-bit random token; the token itself is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("agent_refresh_tokens_agent_id_idx").on(t.agentId),
    index("agent_refresh_tokens_family_id_idx").on(t.familyId),
  ],
);

/** Security events for agents (enrollment, token refresh/reuse, revocation, auth failures, ...). */
export const agentAudit = pgTable(
  "agent_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    event: agentAuditEvent("event").notNull(),
    ip: text("ip"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_audit_agent_id_created_at_idx").on(t.agentId, t.createdAt),
    index("agent_audit_created_at_idx").on(t.createdAt),
  ],
);

/** Fixed-window counters for rate limiting (`apps/web/src/lib/rate-limit.ts`). */
export const rateLimits = pgTable(
  "rate_limits",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.key, t.windowStart] }),
    index("rate_limits_window_start_idx").on(t.windowStart),
  ],
);

export const agentRepoPins = pgTable(
  "agent_repo_pins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("agent_repo_pins_agent_repo_uq").on(t.agentId, t.repositoryId),
    index("agent_repo_pins_repository_id_idx").on(t.repositoryId),
  ],
);

export const scmCredentialCache = pgTable(
  "scm_credential_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** Credential scope, e.g. `read_repository`. */
    scope: text("scope").notNull(),
    /** Provider-side token ID (e.g. GitLab project access token ID) for rotation/revocation. */
    externalId: text("external_id"),
    encryptedToken: text("encrypted_token").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("scm_credential_cache_repo_scope_uq").on(t.repositoryId, t.scope)],
);

// ── Reviews ──────────────────────────────────────────────────────────────────

export interface SkippedFile {
  path: string;
  reason: string;
}

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** PR number (GitHub) or MR IID (GitLab). */
    prNumber: integer("pr_number").notNull(),
    /** PR/MR title when the review was enqueued (null for reviews from before it was stored). */
    prTitle: text("pr_title"),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    trigger: reviewTrigger("trigger").notNull(),
    status: reviewStatus("status").notNull().default("queued"),
    profileId: text("profile_id").references(() => reviewProfiles.id),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    /** Token budget (the profile's `maxTokensPerReview` at review time). */
    budget: integer("budget").notNull(),
    durationMs: integer("duration_ms"),
    model: text("model"),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    skippedFiles: jsonb("skipped_files").$type<SkippedFile[]>().notNull().default([]),
    /** SCM ID of the summary comment, so it is posted at most once per review. */
    summaryCommentId: text("summary_comment_id"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("reviews_repository_pr_idx").on(t.repositoryId, t.prNumber),
    index("reviews_repository_created_at_idx").on(t.repositoryId, t.createdAt),
  ],
);

export const findings = pgTable(
  "findings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    severity: findingSeverity("severity").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    suggestion: text("suggestion"),
    /** Model confidence, 0–1. */
    confidence: real("confidence").notNull(),
    scmCommentId: text("scm_comment_id"),
    status: findingStatus("status").notNull().default("open"),
    /** The finding of a later fresh review that replaced this one (`superseded`). */
    supersededByFindingId: uuid("superseded_by_finding_id").references(
      (): AnyPgColumn => findings.id,
      { onDelete: "set null" },
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("findings_review_id_idx").on(t.reviewId)],
);

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    findingId: uuid("finding_id")
      .notNull()
      .references(() => findings.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Code-host login of the author of an `scm` (`@bot dismiss`) dismissal. */
    scmUsername: text("scm_username"),
    source: feedbackSource("source").notNull(),
    reason: feedbackReason("reason").notNull(),
    note: text("note"),
    /** Set when the finding was restored to `open`; the feedback row is kept. */
    restoredAt: timestamp("restored_at", { withTimezone: true }),
    restoredBy: text("restored_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("feedback_finding_id_idx").on(t.findingId)],
);

export const rules = pgTable(
  "rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    kind: ruleKind("kind").notNull(),
    text: text("text").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    sourceFindingId: uuid("source_finding_id").references(() => findings.id, {
      onDelete: "set null",
    }),
    /** Null for rules learned automatically from feedback. */
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("rules_repository_id_idx").on(t.repositoryId)],
);

// ── Jobs ─────────────────────────────────────────────────────────────────────

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Capability that runs the job, e.g. `review`. */
    capability: text("capability").notNull(),
    /** Job type within the capability, e.g. `review.run` or `repo.sync`. */
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatus("status").notNull().default("queued"),
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** Vercel Queues topic the job was published to. */
    topic: text("topic"),
    queueMessageId: text("queue_message_id"),
    deliveryCount: integer("delivery_count").notNull().default(0),
    /** At most one queued/running job per dedupe key (see the partial unique index). */
    dedupeKey: text("dedupe_key"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    /**
     * SCM comment the control panel posted for the job's outcome (a
     * `review.reply` answer), so it is posted at most once.
     */
    scmCommentId: text("scm_comment_id"),
    /** The ralph run a `ralph.*` job belongs to. */
    ralphRunId: uuid("ralph_run_id").references((): AnyPgColumn => ralphRuns.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("jobs_dedupe_key_active_uq")
      .on(t.dedupeKey)
      .where(sql`status in ('queued', 'running')`),
    index("jobs_status_created_at_idx").on(t.status, t.createdAt),
    index("jobs_agent_id_idx").on(t.agentId),
    index("jobs_ralph_run_id_idx").on(t.ralphRunId),
  ],
);

// ── Ralph runs ───────────────────────────────────────────────────────────────

/** A Linear issue a run refers to (a story, or an external blocker). */
export interface RalphIssueRef {
  /** Linear issue ID. */
  id: string;
  /** e.g. `TOOL-83`. */
  identifier: string;
  title: string;
}

/** What a `waiting` run waits for; an `Issue` webhook completing one of them wakes it. */
export interface RalphWaitingOn {
  /** Open issues outside the epic that block its remaining stories. */
  blockers: RalphIssueRef[];
  /** Manual stories a person has to finish. */
  manual: RalphIssueRef[];
}

/**
 * The open Linear elicitation of a run: `repository` asks which repository to
 * work in (routing found none); `repositoryIds` are the offered options, in order.
 */
export type RalphPendingElicitation = { kind: "repository"; repositoryIds: string[] };

/** A reply from the agent session, applied to the next story attempts. */
export interface RalphGuidance {
  text: string;
  /** ISO timestamp. */
  at: string;
}

/** The `cyralph-prepare` question about one manual story (one at a time). */
export interface RalphPreparationRequest {
  /** Linear issue ID of the manual story. */
  storyIssueId: string;
  identifier: string;
  title: string;
  /** SHA-256 of the commands shown; the job runs nothing if they changed. */
  commandsHash: string;
  /** The branch's last story commit shown (null: none yet); the job runs nothing if HEAD moved. */
  headSha: string | null;
  /** ISO timestamp. */
  askedAt: string;
  /** "Run it" (approved) or "Not yet" (the question stays open); unset until answered. */
  answer?: "run" | "later";
  answeredAt?: string;
  /** The `ralph.prepare` job running the approved commands, until its outcome is applied. */
  jobId?: string;
}

/** Preparation of a run's manual stories (cyralph's `preparation*` session fields). */
export interface RalphPreparation {
  request: RalphPreparationRequest | null;
  /** Story issue ID -> how its preparation was settled; such stories aren't asked about again. */
  handled: Record<string, { how: "prepared" | "myself"; at: string; headSha?: string }>;
  /** `rerun preparation`: the next question is about the earliest open one, even if handled. */
  rerun?: boolean;
  /** The branch HEAD a `ralph.prepare` job last reported (ISO `at` orders it against story commits). */
  head?: { sha: string; at: string };
  /** Leads the next question (why it's asked again: a failure, or a stale approval). */
  lead?: string;
}

/**
 * A delegated Linear issue being built story by story (the ralph loop). The
 * control panel owns this state; every change goes through a row lock
 * (`lockRun`) because webhooks and job outcomes race.
 */
export const ralphRuns = pgTable(
  "ralph_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The delegated issue (the epic, or the single issue). */
    linearIssueId: text("linear_issue_id").notNull(),
    linearIdentifier: text("linear_identifier").notNull(),
    /** The delegated issue's title and Linear URL when the run started (for the Ralph runs pages). */
    linearTitle: text("linear_title"),
    linearUrl: text("linear_url"),
    linearAgentSessionId: text("linear_agent_session_id").notNull(),
    kind: ralphRunKind("kind").notNull(),
    mode: ralphRunMode("mode").notNull().default("epic"),
    /** Linear issue ID of the story to work on first (a delegated sub-issue). */
    focusStoryId: text("focus_story_id"),
    /** Null while the run waits for a person to pick one (`pending_elicitation`). */
    repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "cascade" }),
    /** How the repository was chosen, e.g. "team `ENG`" or "your selection" (kept on re-routing). */
    routedBy: text("routed_by"),
    /** The sticky agent: set by the run's first job, all later jobs (of every lane) go to its topic. */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** The `ralph.describe-pr` job whose outcome the run hasn't applied yet (the PR/MR step). */
    prJobId: uuid("pr_job_id").references((): AnyPgColumn => jobs.id, { onDelete: "set null" }),
    /** The `ralph.request` job whose outcome the run hasn't applied yet. */
    requestJobId: uuid("request_job_id").references((): AnyPgColumn => jobs.id, {
      onDelete: "set null",
    }),
    /** What the request jobs since the run's last response said, posted when the run gets to one. */
    requestOutput: text("request_output"),
    status: ralphRunStatus("status").notNull().default("pending"),
    waitingOn: jsonb("waiting_on").$type<RalphWaitingOn>(),
    guidance: jsonb("guidance").$type<RalphGuidance[]>().notNull().default([]),
    /** "Start anyway": stories run even when they have open blockers. */
    ignoreBlockers: boolean("ignore_blockers").notNull().default(false),
    /** The progress log (cyralph's `progress.md`), appended to per finished story. */
    progress: text("progress").notNull().default(""),
    /** The open Linear elicitation the run waits on an answer to. */
    pendingElicitation: jsonb("pending_elicitation").$type<RalphPendingElicitation>(),
    /** The `cyralph-prepare` question, approvals and answers of the run's manual stories. */
    preparation: jsonb("preparation").$type<RalphPreparation>(),
    /** Jobs enqueued for the run so far. */
    iterations: integer("iterations").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ralph_runs_agent_session_uq").on(t.linearAgentSessionId),
    /** At most one unfinished run per delegated issue. */
    uniqueIndex("ralph_runs_issue_active_uq")
      .on(t.linearIssueId)
      .where(sql`status in ('pending', 'running', 'waiting')`),
    index("ralph_runs_linear_issue_id_idx").on(t.linearIssueId, t.createdAt),
    index("ralph_runs_status_created_at_idx").on(t.status, t.createdAt),
    index("ralph_runs_repository_created_at_idx").on(t.repositoryId, t.createdAt),
  ],
);

/** Uncommitted work ralph stashed in a lane's repository and hasn't dropped or pushed yet. */
export interface RalphStash {
  sha: string;
  /** The story (identifier) whose attempt left it, if any. */
  storyId?: string;
  reason?: string;
  /** ISO timestamp. */
  at: string;
}

/** Cleanup of a lane after its PR/MR merged (cyralph's merged-worktree cleanup). */
export interface RalphLaneCleanup {
  status: "pending" | "running" | "asked" | "done" | "failed";
  /** ISO timestamp of the last change. */
  at: string;
  /** The `ralph.cleanup` job doing it. */
  jobId?: string;
  /** When unmerged commits were offered: the branch is deleted after the timeout without an answer. */
  askedAt?: string;
  error?: string;
}

/**
 * Where a lane is in the run's finish (cyralph's `publishLane`): its
 * `ralph.describe-pr` job is writing the PR/MR, the PR/MR was opened or
 * updated, or that failed (collected into the run's error once every lane is
 * through). Null: not published since its last story.
 */
export type RalphLanePublish =
  | { status: "describing"; jobId: string }
  | { status: "published"; /** Opened now, rather than an open one updated. */ created: boolean }
  | { status: "failed"; problem: string };

/**
 * One repository a run works in (cyralph's `RepoLane`): its branch, PR/MR and
 * follow-up state. The lane of the run's `repository_id` is its main lane;
 * stories routed to other repositories get a lane each. All lanes of a run use
 * the run's sticky agent.
 */
export const ralphLanes = pgTable(
  "ralph_lanes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references((): AnyPgColumn => ralphRuns.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    /** PR number (GitHub) or MR IID (GitLab). */
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    /** The PR/MR was seen closed or merged; it is no longer followed up. */
    prClosed: boolean("pr_closed").notNull().default(false),
    /** Whether the closed PR/MR was merged (false: closed without merging). */
    prMerged: boolean("pr_merged").notNull().default(false),
    mergeSha: text("merge_sha"),
    /** Omniralph reviews acted on for this PR/MR (capped by `maxReviewRounds`). */
    reviewRounds: integer("review_rounds").notNull().default(0),
    /** Reviews (job IDs) already seen: acted on, skipped as stale, or over the round limit. */
    handledReviewIds: jsonb("handled_review_ids").$type<string[]>().notNull().default([]),
    /** Failed CI runs acted on for this PR/MR (capped by `maxFixRounds`). */
    ciFixRounds: integer("ci_fix_rounds").notNull().default(0),
    /** PR/MR head commits whose failed CI was seen. */
    handledCiShas: jsonb("handled_ci_shas").$type<string[]>().notNull().default([]),
    /** Claude session of the last request, resumed for follow-ups on `request_agent_id`. */
    requestClaudeSessionId: text("request_claude_session_id"),
    /** The agent holding that session's files. */
    requestAgentId: uuid("request_agent_id").references(() => agents.id, {
      onDelete: "set null",
    }),
    stashes: jsonb("stashes").$type<RalphStash[]>().notNull().default([]),
    cleanup: jsonb("cleanup").$type<RalphLaneCleanup>(),
    publish: jsonb("publish").$type<RalphLanePublish>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ralph_lanes_run_repository_uq").on(t.runId, t.repositoryId),
    index("ralph_lanes_repository_pr_idx").on(t.repositoryId, t.prNumber),
  ],
);

/** One story (Linear sub-issue, or the single issue) of a run. */
export const ralphStories = pgTable(
  "ralph_stories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => ralphRuns.id, { onDelete: "cascade" }),
    linearIssueId: text("linear_issue_id").notNull(),
    identifier: text("identifier").notNull(),
    title: text("title").notNull(),
    /** Sub-issue order in the epic (for display; selection re-reads Linear). */
    position: integer("position").notNull().default(0),
    status: ralphStoryStatus("status").notNull().default("pending"),
    /** Finished attempts (queue redeliveries don't count). */
    attempts: integer("attempts").notNull().default(0),
    /** Why the last attempt didn't complete, passed to the next one. */
    lastFeedback: text("last_feedback"),
    commitSha: text("commit_sha"),
    lastJobId: uuid("last_job_id").references(() => jobs.id, { onDelete: "set null" }),
    /** The lane (repository) the story runs in; null until the run has a repository. */
    laneId: uuid("lane_id").references(() => ralphLanes.id, { onDelete: "set null" }),
    /**
     * Why the story is treated as manual although it isn't labelled so: it
     * belongs in a repository Omniralph doesn't have (cyralph's `elsewhere`).
     */
    elsewhere: text("elsewhere"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("ralph_stories_run_issue_uq").on(t.runId, t.linearIssueId)],
);

/**
 * A reply from the run's agent session for a running `ralph.*` job's live
 * Claude session (cyralph's live injection), or a pending request. The agent
 * gets undelivered ones in its heartbeat (`jobMessages`) and acknowledges them
 * in the next. A message that can't be delivered becomes guidance (`kind`
 * `guidance`) or stays a pending request (`kind` `request`, no `job_id`).
 */
export const ralphMessages = pgTable(
  "ralph_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => ralphRuns.id, { onDelete: "cascade" }),
    /** The lane (repository) the message is for; null: the run's main lane. */
    laneId: uuid("lane_id").references(() => ralphLanes.id, { onDelete: "set null" }),
    /** The running job to deliver it to; null once that's no longer possible (or never was). */
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    kind: ralphMessageKind("kind").notNull(),
    text: text("text").notNull(),
    /** Who wrote it in Linear, when known. */
    author: text("author"),
    createdAt: createdAt(),
    /** The agent injected it into the job's live session. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** Applied: stored as guidance, or handled as a request. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    index("ralph_messages_run_id_idx").on(t.runId, t.createdAt),
    index("ralph_messages_job_id_idx").on(t.jobId),
  ],
);

// ── Webhooks ─────────────────────────────────────────────────────────────────

/**
 * Webhook deliveries that were acted on, keyed by the provider's delivery ID
 * (`X-GitHub-Delivery` / `X-Gitlab-Event-UUID` / `Linear-Delivery`), so a
 * redelivery doesn't enqueue a second job.
 */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    provider: webhookProvider("provider").notNull(),
    deliveryId: text("delivery_id").notNull(),
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    /** Job the delivery enqueued (null while enqueueing). */
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.provider, t.deliveryId] }),
    index("webhook_deliveries_created_at_idx").on(t.createdAt),
  ],
);
