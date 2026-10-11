/**
 * Drizzle schema for the Omniralph control panel. Postgres is the single source
 * of truth for repos, reviews, harnesses and jobs.
 *
 * After changing this file run `pnpm --filter db generate` to emit a migration
 * into `packages/db/drizzle`, then `pnpm --filter db migrate` to apply it.
 */
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
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

export const uiTheme = pgEnum("ui_theme", ["light", "dark"]);
export const organizationRole = pgEnum("organization_role", ["admin", "member"]);
export const scmProvider = pgEnum("scm_provider", ["github", "gitlab"]);
/** Sources of webhook deliveries: the code hosts plus Linear. */
export const webhookProvider = pgEnum("webhook_provider", ["github", "gitlab", "linear"]);
export const integrationProvider = pgEnum("integration_provider", ["linear"]);
export const chatPlatform = pgEnum("chat_platform", ["slack", "discord"]);
/** How a chat identity was linked: by the member (`manual`) or by a matching email (`email`). */
export const chatIdentitySource = pgEnum("chat_identity_source", ["manual", "email"]);
export const chatMessageRole = pgEnum("chat_message_role", ["user", "assistant", "tool"]);
export const reviewTrigger = pgEnum("review_trigger", ["webhook", "mention", "manual"]);
export const reviewStatus = pgEnum("review_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "budget_exhausted",
  "skipped",
]);
export const reviewRunStatus = pgEnum("review_run_status", [
  "queued",
  "running",
  "correlating",
  "completed",
  "failed",
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
  "merged",
]);
export const feedbackSource = pgEnum("feedback_source", ["ui", "scm"]);
export const feedbackReason = pgEnum("feedback_reason", [
  "false_positive",
  "wont_fix",
  "not_relevant",
  "other",
]);
export const ruleKind = pgEnum("rule_kind", ["custom", "learned"]);
export const harnessAuditEvent = pgEnum("harness_audit_event", [
  "enroll",
  "token_refresh",
  "refresh_reuse",
  "revoke",
  "delete",
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
/** Where a run came from: a Linear delegation or mention, or a chat thread (`chat_thread_id`). */
export const ralphRunOrigin = pgEnum("ralph_run_origin", ["linear", "chat"]);
/** What started a triage run: an `@omniralph /triage` mention, or the `ralph:triage` label. */
export const triageRunTrigger = pgEnum("triage_run_trigger", ["mention", "label"]);
/** A Linear issue draft posted from chat: `creating` while its **Create** click runs. */
export const chatLinearIssueDraftStatus = pgEnum("chat_linear_issue_draft_status", [
  "pending",
  "creating",
  "created",
  "cancelled",
  "expired",
]);
export const triageRunStatus = pgEnum("triage_run_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "stopped",
]);
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
  /**
   * The organization the user is working in; `null` until they create or join one
   * (they're sent to onboarding). Roles live on `organization_members`.
   */
  activeOrganizationId: uuid("active_organization_id").references(
    (): AnyPgColumn => organizations.id,
    { onDelete: "set null" },
  ),
  /** The user's chosen control panel theme; `null` follows the OS preference. */
  theme: uiTheme("theme"),
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

// ── Organizations ────────────────────────────────────────────────────────────

/** The tenancy boundary: every resource belongs to exactly one organization. */
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /**
   * Lists the organization as joinable (as `member`, without an invitation) for
   * signed-in users whose email matches one of its domains. Only meaningful with
   * at least one domain set.
   */
  allowDomainJoin: boolean("allow_domain_join").notNull().default(false),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** A user's membership of an organization, with their role in it. */
export const organizationMembers = pgTable(
  "organization_members",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** `admin` manages the organization and its resources; `member` has read access. */
    role: organizationRole("role").notNull().default("member"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.userId] }),
    index("organization_members_user_id_idx").on(t.userId),
  ],
);

/**
 * An invitation to join an organization, for an email address. Pending while
 * not accepted, not revoked and not past `expires_at`.
 */
export const organizationInvitations = pgTable(
  "organization_invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Lower-cased email address. */
    email: text("email").notNull(),
    role: organizationRole("role").notNull().default("member"),
    invitedBy: text("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedBy: text("accepted_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("organization_invitations_email_idx").on(t.email),
    index("organization_invitations_organization_id_idx").on(t.organizationId),
    check("organization_invitations_email_lower", sql`${t.email} = lower(${t.email})`),
  ],
);

/**
 * Email domains of an organization. With none, anyone may be invited; with some,
 * invitations and joins are limited to emails in those domains.
 */
export const organizationEmailDomains = pgTable(
  "organization_email_domains",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Lower-cased domain, e.g. `example.com`. */
    domain: text("domain").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.domain] }),
    index("organization_email_domains_domain_idx").on(t.domain),
    check("organization_email_domains_domain_lower", sql`${t.domain} = lower(${t.domain})`),
  ],
);

// ── Code hosts and repositories ──────────────────────────────────────────────

/** A problem found by the daily GitLab connection check. */
export interface ScmConnectionProblem {
  /**
   * `token_invalid`, `missing_api_scope`, `access_token_bot`, `token_expiring`,
   * `webhook_missing`, `webhook_events_outdated`, `rotation_unsupported` or
   * `rotation_failed`.
   */
  code: string;
  message: string;
  /** The project the problem is about (webhook problems). */
  repositoryId?: string;
}

/** Result of the last daily check of a connection (`scm_connections.health`). */
export interface ScmConnectionHealth {
  /** ISO timestamp of the check. */
  checkedAt: string;
  /** ISO date the bot token expires, when GitLab reports it. */
  tokenExpiresAt: string | null;
  problems: ScmConnectionProblem[];
}

export const scmConnections = pgTable(
  "scm_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: scmProvider("provider").notNull(),
    name: text("name").notNull(),
    /** API base URL, e.g. https://api.github.com or https://gitlab.example.com. */
    baseUrl: text("base_url").notNull(),
    /** Provider-side identifier, e.g. the GitHub App installation ID or GitLab group path. */
    externalId: text("external_id"),
    /** JSON credentials encrypted with `encrypt()` (AES-256-GCM). */
    encryptedCredentials: text("encrypted_credentials").notNull(),
    /** GitLab: the token user's username, the bot's `@` handle. Null for GitHub. */
    botUsername: text("bot_username"),
    /** GitLab: the last daily connection check (`/api/cron/gitlab-maintenance`); null until the first. */
    health: jsonb("health").$type<ScmConnectionHealth>(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** A code-host installation/connection belongs to one organization; webhooks resolve it from here. */
    uniqueIndex("scm_connections_provider_base_url_external_id_uq").on(
      t.provider,
      t.baseUrl,
      t.externalId,
    ),
    index("scm_connections_organization_id_idx").on(t.organizationId),
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
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
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
  (t) => [
    /** At most one connected workspace per provider and organization. */
    uniqueIndex("integrations_provider_uq").on(t.organizationId, t.provider),
    /** A workspace belongs to one organization; webhooks resolve the organization from it. */
    uniqueIndex("integrations_provider_external_id_uq").on(t.provider, t.externalId),
  ],
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

// ── Chat (Slack and Discord) ─────────────────────────────────────────────────

/**
 * A Slack workspace or Discord server connected to an organization
 * (`external_id` = the Slack team or enterprise ID, or the Discord guild ID).
 */
export const chatConnections = pgTable(
  "chat_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    platform: chatPlatform("platform").notNull(),
    externalId: text("external_id").notNull(),
    /** Workspace or server name, for display. */
    name: text("name").notNull(),
    /**
     * JSON credentials (Slack: the workspace's bot token) encrypted with
     * `encrypt()` (AES-256-GCM). Null for Discord, which uses the deployment's bot token.
     */
    encryptedCredentials: text("encrypted_credentials"),
    installedByUserId: text("installed_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** A workspace or server belongs to one organization; events resolve the organization from it. */
    uniqueIndex("chat_connections_platform_external_id_uq").on(t.platform, t.externalId),
    index("chat_connections_organization_id_idx").on(t.organizationId),
  ],
);

/** A chat user linked to an Omniralph member of the organization. */
export const chatIdentities = pgTable(
  "chat_identities",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    platform: chatPlatform("platform").notNull(),
    /** The Slack or Discord user ID. */
    externalUserId: text("external_user_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: chatIdentitySource("source").notNull(),
    /** The chat user's display name when linked, for display. */
    displayName: text("display_name"),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.platform, t.externalUserId] }),
    index("chat_identities_user_id_idx").on(t.userId),
  ],
);

/**
 * A chat user who unlinked their identity: never linked automatically by
 * email again (linking it manually removes the opt-out).
 */
export const chatIdentityOptOuts = pgTable(
  "chat_identity_opt_outs",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    platform: chatPlatform("platform").notNull(),
    externalUserId: text("external_user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.platform, t.externalUserId] })],
);

/**
 * Account-link states (`/chat/link`) that were used, so each links once.
 * Kept until the state expires; expired rows are purged on later uses.
 */
export const chatLinkStateUses = pgTable(
  "chat_link_state_uses",
  {
    /** The state's `jti`. */
    id: uuid("id").primaryKey(),
    usedAt: timestamp("used_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("chat_link_state_uses_expires_at_idx").on(t.expiresAt)],
);

/** A chat user's profile as last fetched from the platform (Slack `users.info`), cached. */
export const chatUserProfiles = pgTable(
  "chat_user_profiles",
  {
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => chatConnections.id, { onDelete: "cascade" }),
    externalUserId: text("external_user_id").notNull(),
    /** The verified email, when the platform exposes it (never for Discord). */
    email: text("email"),
    displayName: text("display_name").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.externalUserId] })],
);

/** A conversation with the control-panel agent: a thread started by mentioning the bot. */
export const chatThreads = pgTable(
  "chat_threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => chatConnections.id, { onDelete: "cascade" }),
    platform: chatPlatform("platform").notNull(),
    /** The Chat SDK thread ID. */
    externalThreadId: text("external_thread_id").notNull(),
    channelId: text("channel_id").notNull(),
    startedByExternalUserId: text("started_by_external_user_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("chat_threads_connection_id_external_thread_id_uq").on(
      t.connectionId,
      t.externalThreadId,
    ),
    index("chat_threads_organization_id_idx").on(t.organizationId),
  ],
);

/** A message of a chat thread's conversation history. */
/**
 * A file attached to a chat message: its metadata only, never the bytes (they
 * are fetched again from the platform when a turn needs them).
 */
export interface ChatMessageAttachment {
  type: "image" | "file" | "video" | "audio";
  name: string | null;
  mimeType: string | null;
  /** Bytes, as the platform reported it. */
  size: number | null;
  /** The platform's URL of the file (e.g. Slack's private URL). */
  url: string | null;
  /** What the platform's adapter needs to fetch it again (`Attachment.fetchMetadata`). */
  fetchMetadata: Record<string, string> | null;
}

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    role: chatMessageRole("role").notNull(),
    /** The chat user who wrote it (`user` messages). */
    externalUserId: text("external_user_id"),
    authorName: text("author_name"),
    /** The ralph run that posted it (an `assistant` message of the run's session). */
    ralphRunId: uuid("ralph_run_id").references((): AnyPgColumn => ralphRuns.id, {
      onDelete: "set null",
    }),
    /** The message content (e.g. AI SDK model message content). */
    content: jsonb("content").$type<unknown>().notNull(),
    /** Files attached to a `user` message (metadata only). */
    attachments: jsonb("attachments").$type<ChatMessageAttachment[]>().notNull().default([]),
    /** `clock_timestamp()`, so messages appended in one transaction keep their order. */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [index("chat_messages_thread_id_created_at_idx").on(t.threadId, t.createdAt)],
);

/**
 * A Linear issue the control-panel agent drafted in a chat thread: posted as a
 * card with **Create** / **Cancel** buttons, created only when the member who
 * asked clicks **Create** before `expiresAt`.
 */
export const chatLinearIssueDrafts = pgTable(
  "chat_linear_issue_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    /** The linked member who asked: the only one whose click creates it. */
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Their chat user ID. */
    requestedByExternalUserId: text("requested_by_external_user_id").notNull(),
    teamId: text("team_id").notNull(),
    teamKey: text("team_key").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    projectName: text("project_name"),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    /** Linear priority: 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low. */
    priority: integer("priority"),
    /** Screenshots from the thread to upload to Linear and embed in the description. */
    attachments: jsonb("attachments")
      .$type<Array<ChatMessageAttachment & { ref: string }>>()
      .notNull()
      .default([]),
    status: chatLinearIssueDraftStatus("status").notNull().default("pending"),
    /** The chat message of the card (set once posted). */
    externalMessageId: text("external_message_id"),
    linearIssueId: text("linear_issue_id"),
    linearIssueIdentifier: text("linear_issue_identifier"),
    linearIssueUrl: text("linear_issue_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("chat_linear_issue_drafts_thread_id_idx").on(t.threadId)],
);

/**
 * A Linear issue delegated to the Omniralph app from a chat thread, written
 * just before the delegation: when Linear's agent session for it starts the
 * run, `startRun` takes the row and ties the run to the thread (its
 * `chat_thread_id`) for start/PR/finish notifications. A row no session takes
 * within an hour is ignored and pruned.
 */
export const chatLinearDelegations = pgTable(
  "chat_linear_delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    linearIssueId: text("linear_issue_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("chat_linear_delegations_issue_idx").on(t.organizationId, t.linearIssueId, t.createdAt),
    index("chat_linear_delegations_created_at_idx").on(t.createdAt),
  ],
);

/**
 * Review profiles of an organization. The built-in ones (`quick`, `standard`,
 * `deep`) are seeded into every new organization (`createOrganization`).
 */
export const reviewProfiles = pgTable(
  "review_profiles",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Slug, unique per organization, e.g. `quick`, `standard`, `deep`. */
    id: text("id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    model: text("model").notNull(),
    maxTokensPerReview: integer("max_tokens_per_review").notNull(),
    maxFiles: integer("max_files").notNull(),
    allowRepoExploration: boolean("allow_repo_exploration").notNull(),
    builtIn: boolean("built_in").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.id] })],
);

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
 * Per-repository settings of ralph (`repositories.ralph_settings`),
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
    /** The organization of its connection. */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: scmProvider("provider").notNull(),
    /** Provider repository/project ID. */
    externalId: text("external_id").notNull(),
    /** `owner/repo` or the GitLab `group/subgroup/project` path. */
    fullPath: text("full_path").notNull(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => scmConnections.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    /** A review profile of the repository's organization (composite foreign key below). */
    profileId: text("profile_id").notNull().default(DEFAULT_PROFILE_ID),
    triggers: jsonb("triggers")
      .$type<RepositoryTriggers>()
      .notNull()
      .default(DEFAULT_REPOSITORY_TRIGGERS),
    pathExcludes: text("path_excludes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    customInstructions: text("custom_instructions"),
    /** The review tasks (`builtin:<name>` or UUIDs) each PR event fans out to, in order. */
    reviewTaskIds: text("review_task_ids")
      .array()
      .notNull()
      .default(sql`'{builtin:review-pr}'::text[]`),
    /** The query task that merges the results of a review run's tasks. */
    correlationTaskId: text("correlation_task_id").notNull().default("builtin:correlate-findings"),
    /** Linear delegations may build in this repository (ralph). */
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
  (t) => [
    uniqueIndex("repositories_connection_external_id_uq").on(t.connectionId, t.externalId),
    index("repositories_organization_id_idx").on(t.organizationId),
    foreignKey({
      name: "repositories_organization_profile_fk",
      columns: [t.organizationId, t.profileId],
      foreignColumns: [reviewProfiles.organizationId, reviewProfiles.id],
    }),
  ],
);

// ── Harnesses ───────────────────────────────────────────────────────────────

/** A harness's self-update progress (mirrors `HarnessUpdateReport` in @omniralph/shared). */
export interface HarnessUpdateState {
  state: "idle" | "draining" | "installing" | "confirming";
  version: string | null;
  previous: string | null;
  startsSincePending: number;
  error: string | null;
}

/**
 * Per-organization settings edited by its admins, one JSON value per key (e.g.
 * `harness.desiredVersion`).
 */
export const appSettings = pgTable(
  "app_settings",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").$type<unknown>().notNull(),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.key] })],
);

export const harnesses = pgTable(
  "harnesses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    maxConcurrency: integer("max_concurrency").notNull().default(1),
    /** Task types the harness runs (`system` is always accepted); trust, not concurrency. */
    acceptedTaskTypes: text("accepted_task_types")
      .array()
      .notNull()
      .default(sql`'{query,review}'::text[]`),
    /**
     * Per-pool caps on concurrent jobs (e.g. `{ "long": 1 }`), within
     * `maxConcurrency`. Unset pools use the protocol's default limit.
     */
    poolLimits: jsonb("pool_limits").$type<Partial<Record<string, number>>>().notNull().default({}),
    /** Overrides the organization's desired harness version (`app_settings` `harness.desiredVersion`). */
    desiredVersion: text("desired_version"),
    reportedVersion: text("reported_version"),
    /** `supported` (under pm2) or `unsupported`, from the heartbeat; null for older harnesses. */
    selfUpdate: text("self_update").$type<"supported" | "unsupported">(),
    /** The harness's self-update progress, as last reported. */
    updateState: jsonb("update_state").$type<HarnessUpdateState>(),
    /** Versions the harness failed to install or keep running; it never retries them. */
    failedVersions: text("failed_versions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * An admin's "Update now", sent with every heartbeat until the harness reports
     * it handled (`handledUpdateRequestId`); null when none is pending.
     */
    updateRequestId: uuid("update_request_id"),
    /** The version requested: the desired version then, else the latest on npm. */
    updateRequestVersion: text("update_request_version"),
    updateRequestedAt: timestamp("update_requested_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Soft delete (always after revoking): deleted harnesses are hidden everywhere. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    enrolledBy: text("enrolled_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("harnesses_organization_id_idx").on(t.organizationId)],
);

/**
 * Named concurrency pools of an organization (`short` and `long` are seeded):
 * each job takes a slot of its pool, and harnesses limit their jobs per pool.
 */
export const pools = pgTable(
  "pools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("pools_organization_name_uq").on(t.organizationId, t.name)],
);

export const harnessEnrollments = pgTable("harness_enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The organization the redeemed harness joins. */
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** `hashToken()` of the one-time enrollment token; the token itself is never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  /** Display name for the harness this enrollment creates. */
  name: text("name"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  /** The harness created when the token was redeemed. */
  harnessId: uuid("harness_id").references(() => harnesses.id, { onDelete: "set null" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

/**
 * Opaque refresh tokens a harness exchanges for 15-minute access JWTs. Every refresh marks the
 * presented token used and issues a new one in the same family; presenting a used token again
 * revokes the family and the harness (theft detection).
 */
export const harnessRefreshTokens = pgTable(
  "harness_refresh_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    harnessId: uuid("harness_id")
      .notNull()
      .references(() => harnesses.id, { onDelete: "cascade" }),
    /** Rotation chain: one per enrollment. */
    familyId: uuid("family_id").notNull(),
    /** `hashToken()` of the 256-bit random token; the token itself is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: createdAt(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("harness_refresh_tokens_harness_id_idx").on(t.harnessId),
    index("harness_refresh_tokens_family_id_idx").on(t.familyId),
  ],
);

/** Security events for harnesses (enrollment, token refresh/reuse, revocation, auth failures, ...). */
export const harnessAudit = pgTable(
  "harness_audit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    harnessId: uuid("harness_id").references(() => harnesses.id, { onDelete: "set null" }),
    event: harnessAuditEvent("event").notNull(),
    ip: text("ip"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("harness_audit_harness_id_created_at_idx").on(t.harnessId, t.createdAt),
    index("harness_audit_created_at_idx").on(t.createdAt),
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

export const harnessRepoPins = pgTable(
  "harness_repo_pins",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    harnessId: uuid("harness_id")
      .notNull()
      .references(() => harnesses.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("harness_repo_pins_harness_repo_uq").on(t.harnessId, t.repositoryId),
    index("harness_repo_pins_repository_id_idx").on(t.repositoryId),
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

/** What a review covered: the full diff, or the commits since an earlier review. */
export type ReviewScope =
  | { mode: "full"; baseSha: string; headSha: string; fallbackFrom?: string }
  | { mode: "incremental"; fromSha: string; headSha: string };

/**
 * One PR event's review: fans out to one review (and job) per enabled review
 * task of the repository, all of the same head.
 */
export const reviewRuns = pgTable(
  "review_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** PR number (GitHub) or MR IID (GitLab). */
    prNumber: integer("pr_number").notNull(),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    trigger: reviewTrigger("trigger").notNull(),
    mode: text("mode").$type<"incremental" | "full" | "fresh">().notNull(),
    /** Profile ID (in the repository's organization) the run's reviews use. */
    profileId: text("profile_id"),
    status: reviewRunStatus("status").notNull().default("queued"),
    /** The job of the correlation query task that merges the reviews' results. */
    correlationJobId: uuid("correlation_job_id").references((): AnyPgColumn => jobs.id, {
      onDelete: "set null",
    }),
    /** The combined summary the correlation wrote; null without a correlation. */
    summary: text("summary"),
    /** SCM ID of the run's summary comment, so the run is posted at most once. */
    summaryCommentId: text("summary_comment_id"),
    /** The PR/MR author when the run was enqueued (a mention the posted text keeps). */
    prAuthor: text("pr_author"),
    /** The profile's name when the run was enqueued (the posted summary names it). */
    profileName: text("profile_name"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("review_runs_repository_pr_idx").on(t.repositoryId, t.prNumber)],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The review run the review is one task of; null for reviews from before review runs. */
    reviewRunId: uuid("review_run_id").references(() => reviewRuns.id, { onDelete: "cascade" }),
    /** The review task (`builtin:review-pr` or a UUID) the review ran. */
    taskId: text("task_id"),
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
    /** Profile ID (in the repository's organization) the review ran with. */
    profileId: text("profile_id"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    /** Token budget (the profile's `maxTokensPerReview` at review time). */
    budget: integer("budget").notNull(),
    durationMs: integer("duration_ms"),
    model: text("model"),
    harnessId: uuid("harness_id").references(() => harnesses.id, { onDelete: "set null" }),
    skippedFiles: jsonb("skipped_files").$type<SkippedFile[]>().notNull().default([]),
    /** SCM ID of the summary comment, so it is posted at most once per review. */
    summaryCommentId: text("summary_comment_id"),
    /** The task run's own summary (input to the review run's correlation); null without one. */
    summary: text("summary"),
    /** What the task run covered (its result's `scope`); null until it finished. */
    scope: jsonb("scope").$type<ReviewScope>(),
    /** The earlier open findings the task run re-checked and found fixed. */
    fixedFindingIds: text("fixed_finding_ids").array().notNull().default([]),
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
    /** The review tasks that reported the finding (its review's task, plus those merged into it). */
    sourceTaskIds: text("source_task_ids").array().notNull().default([]),
    /** The finding of the same review run this one was merged into (`merged`). */
    mergedIntoFindingId: uuid("merged_into_finding_id").references((): AnyPgColumn => findings.id, {
      onDelete: "set null",
    }),
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

/** How a harness runs a job (`JOB_TASK_TYPES` in `@omniralph/shared`). */
export type JobTaskType = "query" | "review" | "coding" | "system";

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Only harnesses of this organization receive the job and its credentials. */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Job type, e.g. `review.run` or `repo.sync`. */
    type: text("type").notNull(),
    /**
     * How the harness runs the job: `query`, `review`, `coding` or `system` (a
     * fixed command, no session). Only harnesses accepting it claim the job.
     */
    taskType: text("task_type").$type<JobTaskType>().notNull(),
    /** The pool whose slots the job takes (e.g. `short`); null for `system` jobs. */
    pool: text("pool"),
    /** The task definition the job runs (`builtin:<name>` or a UUID); null for legacy jobs. */
    taskId: text("task_id"),
    /** Only harnesses reporting at least this version (semver) claim the job. */
    minHarnessVersion: text("min_harness_version"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatus("status").notNull().default("queued"),
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    harnessId: uuid("harness_id").references(() => harnesses.id, { onDelete: "set null" }),
    /** Only this harness may claim the job (a pinned repo's job, or `repo.sync`); null: any harness of the organization. */
    targetHarnessId: uuid("target_harness_id").references((): AnyPgColumn => harnesses.id, {
      onDelete: "set null",
    }),
    /** When a `queued` job may be claimed (later than creation for a delayed retry). */
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    /** When a `running` job's lease lapses: another harness may then claim it (crash takeover). */
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
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
    index("jobs_harness_id_idx").on(t.harnessId),
    index("jobs_ralph_run_id_idx").on(t.ralphRunId),
    index("jobs_organization_created_at_idx").on(t.organizationId, t.createdAt),
    // The claim query: queued jobs that are available, and running jobs whose lease lapsed.
    index("jobs_claim_queued_idx")
      .on(t.organizationId, t.taskType, t.status, t.availableAt)
      .where(sql`status = 'queued'`),
    index("jobs_claim_lease_idx")
      .on(t.organizationId, t.taskType, t.leaseExpiresAt)
      .where(sql`status = 'running'`),
    check("jobs_task_type_valid", sql`${t.taskType} in ('query', 'review', 'coding', 'system')`),
    check("jobs_pool_system_only_null", sql`(${t.taskType} = 'system') = (${t.pool} is null)`),
  ],
);

/** What a run's session reported: Claude's text (`thought`) or a tool call (`action`). */
export type RunActivityType = "thought" | "action";

/** Activities a run's session reported (`POST /api/harness/jobs/{id}/activities`), oldest first. */
export const runActivities = pgTable(
  "run_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").$type<RunActivityType>().notNull(),
    /** A thought's text, or an action's name (e.g. the tool). */
    body: text("body").notNull(),
    /** An action's parameter (e.g. the command); null for thoughts. */
    parameter: text("parameter"),
    createdAt: createdAt(),
  },
  (t) => [
    index("run_activities_job_id_created_at_idx").on(t.jobId, t.createdAt),
    check("run_activities_type_valid", sql`${t.type} in ('thought', 'action')`),
  ],
);

/** How a permission request was answered; null while pending. */
export type RunPermissionAnswer = "allowed" | "denied" | "expired";

/**
 * Tool calls a run's session asked a person to approve
 * (`POST /api/harness/jobs/{id}/permissions`), one row per request.
 */
export const runPermissionRequests = pgTable(
  "run_permission_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    /** Chosen by the harness; it reads the answer back with it. */
    requestId: text("request_id").notNull(),
    tool: text("tool").notNull(),
    detail: text("detail").notNull().default(""),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the harness stops waiting and denies the call. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    answer: text("answer").$type<RunPermissionAnswer>(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    answeredBy: text("answered_by"),
  },
  (t) => [
    uniqueIndex("run_permission_requests_job_request_uq").on(t.jobId, t.requestId),
    check(
      "run_permission_requests_answer_valid",
      sql`${t.answer} is null or ${t.answer} in ('allowed', 'denied', 'expired')`,
    ),
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
 * A tool call a run's live session asked a person to approve in Linear (the
 * repository's Claude Code settings `ask` about it). One at a time: the harness
 * waits for the answer before it asks about another call.
 */
export interface RalphPermissionQuestion {
  /** The harness's ID for the call; it reads the answer back with it. */
  requestId: string;
  /** The job whose session asks. */
  jobId: string;
  tool: string;
  detail: string;
  askedAt: string;
  /** When the harness stops waiting and denies the call (ISO 8601). */
  expiresAt: string;
  /** Unset while pending; `expired` when nobody answered in time (or the job ended). */
  answer?: "allowed" | "denied" | "expired";
  answeredAt?: string;
  answeredBy?: string | null;
}

/**
 * A file uploaded to Linear (`uploads.linear.app`) that the run's jobs may
 * download through the control panel, by its attachment ID.
 */
export interface RalphAttachmentLink {
  /** The upload URL without its signed query. */
  url: string;
  title: string | null;
}

/**
 * A delegated Linear issue being built story by story (the ralph loop), or a
 * request-mode run started from a chat thread (`origin` `chat`: no Linear
 * issue, session or stories). The control panel owns this state; every change goes through a row lock
 * (`lockRun`) because webhooks and job outcomes race.
 */
export const ralphRuns = pgTable(
  "ralph_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The organization whose Linear workspace delegated the issue (and whose repositories it uses). */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    origin: ralphRunOrigin("origin").notNull().default("linear"),
    /** The chat thread a `chat` run belongs to (its session posts there). */
    chatThreadId: uuid("chat_thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    /** The delegated issue (the epic, or the single issue); set for `linear` runs only. */
    linearIssueId: text("linear_issue_id"),
    linearIdentifier: text("linear_identifier"),
    /** The delegated issue's title and Linear URL when the run started (for the Ralph runs pages). */
    linearTitle: text("linear_title"),
    linearUrl: text("linear_url"),
    linearAgentSessionId: text("linear_agent_session_id"),
    kind: ralphRunKind("kind").notNull(),
    mode: ralphRunMode("mode").notNull().default("epic"),
    /** Linear issue ID of the story to work on first (a delegated sub-issue). */
    focusStoryId: text("focus_story_id"),
    /** Null while the run waits for a person to pick one (`pending_elicitation`). */
    repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "cascade" }),
    /** How the repository was chosen, e.g. "team `ENG`" or "your selection" (kept on re-routing). */
    routedBy: text("routed_by"),
    /** The sticky harness: set by the run's first job, all later jobs (of every lane) are targeted at it. */
    harnessId: uuid("harness_id").references(() => harnesses.id, { onDelete: "set null" }),
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
    /** The latest tool call a live session asked a person to approve, and the answer. */
    permission: jsonb("permission").$type<RalphPermissionQuestion>(),
    /** Attachment ID -> Linear upload, for every attachment listed in the run's job payloads. */
    attachments: jsonb("attachments")
      .$type<Record<string, RalphAttachmentLink>>()
      .notNull()
      .default({}),
    /** Jobs enqueued for the run so far. */
    iterations: integer("iterations").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ralph_runs_agent_session_uq").on(t.linearAgentSessionId),
    /** At most one unfinished Linear run per delegated issue (and organization). */
    uniqueIndex("ralph_runs_issue_active_uq")
      .on(t.organizationId, t.linearIssueId)
      .where(sql`origin = 'linear' and status in ('pending', 'running', 'waiting')`),
    /** At most one unfinished chat run per thread. */
    uniqueIndex("ralph_runs_chat_thread_active_uq")
      .on(t.chatThreadId)
      .where(sql`origin = 'chat' and status in ('pending', 'running', 'waiting')`),
    index("ralph_runs_chat_thread_id_idx").on(t.chatThreadId, t.createdAt),
    /**
     * A Linear run has its issue and agent session; a chat run only does what
     * it was asked. A chat run starts with its thread (`createRun` requires
     * it), but loses it when the thread goes (e.g. the chat connection is
     * removed), so the thread can't be required here.
     */
    check(
      "ralph_runs_origin_check",
      sql`(origin = 'linear' and linear_issue_id is not null and linear_identifier is not null and linear_agent_session_id is not null)
        or (origin = 'chat' and mode = 'request')`,
    ),
    index("ralph_runs_linear_issue_id_idx").on(t.linearIssueId, t.createdAt),
    index("ralph_runs_status_created_at_idx").on(t.status, t.createdAt),
    index("ralph_runs_repository_created_at_idx").on(t.repositoryId, t.createdAt),
    index("ralph_runs_organization_created_at_idx").on(t.organizationId, t.createdAt),
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

/**
 * A question about a merged lane's leftovers, posted in the run's session and
 * waiting for a reply (cyralph's `CleanupRequest`).
 */
export type RalphCleanupQuestion =
  | {
      kind: "stashes";
      /** Stash entries (by commit SHA) nobody applied. */
      shas: string[];
      /** ISO timestamp. */
      askedAt: string;
    }
  | {
      kind: "branch";
      /** Commits of the kept local branch the merge doesn't contain. */
      commits: number;
      askedAt: string;
      /** Without an answer by then the branch is deleted (`unmergedBranchTimeoutMinutes`). */
      deadline: string;
    };

/** Cleanup of a lane after its PR/MR merged (cyralph's merged-worktree cleanup). */
export interface RalphLaneCleanup {
  /**
   * `pending`: waits until none of the run's jobs is active; `running`: its
   * `ralph.cleanup` job runs; `done`: the worktree is gone (questions may be
   * open); `failed`: the job failed (the reconcile cron tries again).
   */
  status: "pending" | "running" | "done" | "failed";
  /** ISO timestamp of the last change. */
  at: string;
  /** The merged PR/MR head. */
  mergedSha: string;
  /** The `ralph.cleanup` job doing the cleanup or carrying out an answer, until its outcome is applied. */
  jobId?: string;
  /** The answer that job carries out (`expired`: the branch question timed out). */
  answer?: { kind: "stashes" | "branch"; option: string; expired?: boolean };
  /** Open questions, oldest first. */
  questions: RalphCleanupQuestion[];
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
 * the run's sticky harness.
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
    /** Reviews (`reviews.id`) already seen: acted on, skipped as stale, or over the round limit. */
    handledReviewIds: jsonb("handled_review_ids").$type<string[]>().notNull().default([]),
    /** Failed CI runs acted on for this PR/MR (capped by `maxFixRounds`). */
    ciFixRounds: integer("ci_fix_rounds").notNull().default(0),
    /** PR/MR head commits whose failed CI was seen. */
    handledCiShas: jsonb("handled_ci_shas").$type<string[]>().notNull().default([]),
    /** Claude session of the last request, resumed for follow-ups on `request_harness_id`. */
    requestClaudeSessionId: text("request_claude_session_id"),
    /** The harness holding that session's files. */
    requestHarnessId: uuid("request_harness_id").references(() => harnesses.id, {
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
    /** Finished attempts (redeliveries don't count). */
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
 * Claude session (cyralph's live injection), or a pending request. The harness
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
    /** `/ship`: the request job that takes it commits, pushes and opens the PR/MR. */
    ship: boolean("ship").notNull().default(false),
    /** Who wrote it in Linear, when known. */
    author: text("author"),
    createdAt: createdAt(),
    /** The harness injected it into the job's live session. */
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    /** Applied: stored as guidance, or handled as a request. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (t) => [
    index("ralph_messages_run_id_idx").on(t.runId, t.createdAt),
    index("ralph_messages_job_id_idx").on(t.jobId),
  ],
);

// ── Triage ───────────────────────────────────────────────────────────────────

/**
 * The last `triage.run` result a triage run applied (a `TriageRunResult` from
 * `@omniralph/shared`, which this package doesn't depend on).
 */
export type TriageLastResult = Record<string, unknown>;

/**
 * A triage of a Linear issue in one Linear agent session, so the session's
 * replies and its jobs' outcomes route to triage rather than ralph. A reply
 * triages again in the same run.
 */
export const triageRuns = pgTable(
  "triage_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The issue being triaged. */
    linearIssueId: text("linear_issue_id").notNull(),
    linearAgentSessionId: text("linear_agent_session_id").notNull(),
    trigger: triageRunTrigger("trigger").notNull(),
    /** The `triage.run` job whose outcome the run hasn't applied yet. */
    currentJobId: uuid("current_job_id").references(() => jobs.id, { onDelete: "set null" }),
    status: triageRunStatus("status").notNull().default("queued"),
    lastResult: jsonb("last_result").$type<TriageLastResult>(),
    /** Replies in the session while a job ran: the next job takes them. */
    pendingReply: text("pending_reply"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("triage_runs_agent_session_uq").on(t.linearAgentSessionId),
    /** At most one unfinished triage per issue (and organization). */
    uniqueIndex("triage_runs_issue_active_uq")
      .on(t.organizationId, t.linearIssueId)
      .where(sql`status in ('queued', 'running')`),
    index("triage_runs_organization_created_at_idx").on(t.organizationId, t.createdAt),
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
