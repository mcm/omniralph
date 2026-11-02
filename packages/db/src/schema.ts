/**
 * Drizzle schema for the Omniralph control panel. Postgres is the single source
 * of truth for repos, reviews, agents and jobs.
 *
 * After changing this file run `pnpm --filter db generate` to emit a migration
 * into `packages/db/drizzle`, then `pnpm --filter db migrate` to apply it.
 */
import type {
  AgentHostReport,
  ClaudeLoginReport,
  HostToolReport,
  RoutingQuery,
  TokenRefreshReport,
} from "@omniralph/shared";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  pgView,
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
/** Sources of webhook deliveries: the code hosts plus the trackers. */
export const webhookProvider = pgEnum("webhook_provider", ["github", "gitlab", "linear"]);
export const integrationProvider = pgEnum("integration_provider", ["linear"]);
/** The tracker a repository's work item match reads work items from. */
export const workItemTracker = pgEnum("work_item_tracker", ["linear"]);
/** Where a chat happens: Slack, Discord, or the Omniralph web app (`web`, one hidden connection per organization). */
export const chatPlatform = pgEnum("chat_platform", ["slack", "discord", "web"]);
/** How a chat identity was linked: by the member (`manual`) or by a matching email (`email`). */
export const chatIdentitySource = pgEnum("chat_identity_source", ["manual", "email"]);
export const chatMessageRole = pgEnum("chat_message_role", ["user", "assistant", "tool"]);
/** Who wrote a web chat message: the member (`user`) or Om. */
export const chatWebMessageAuthor = pgEnum("chat_web_message_author", ["user", "om"]);
/** A web chat message being streamed (`streaming`) or finished (`complete`). */
export const chatWebMessageStatus = pgEnum("chat_web_message_status", ["streaming", "complete"]);
/** A repository's review depth (`REVIEW_DEPTHS` in `@omniralph/shared`). */
export const reviewDepth = pgEnum("review_depth", ["quick", "standard", "deep"]);
/**
 * Whether a repo's coding runs may rebase and `--force-with-lease`: only when a request asks
 * for it, `always` (rebasing instead of ever merging the base branch) or `never`.
 */
export const historyRewrite = pgEnum("history_rewrite", ["when-asked", "always", "never"]);
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
export const agentAuditEvent = pgEnum("agent_audit_event", [
  "enroll",
  "reenroll",
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
/** Where a ralph PR/MR's human review stands (`ralph_lanes.pr_review_state`). */
export const prReviewState = pgEnum("pr_review_state", [
  "none",
  "review_requested",
  "commented",
  "changes_requested",
  "approved",
]);
export const ralphStoryStatus = pgEnum("ralph_story_status", [
  "pending",
  "running",
  "completed",
  "blocked",
  "exhausted",
  "manual",
  /** Canceled in the tracker: done without work. */
  "canceled",
]);
/** A live message's kind: story guidance, or a request (handled as one, not as guidance). */
export const ralphMessageKind = pgEnum("ralph_message_kind", ["guidance", "request"]);
/**
 * How a run treats its session: `epic` builds the epic story by story (a
 * delegation, or `/coding`); `request` only does what a mention asks.
 */
export const ralphRunMode = pgEnum("ralph_run_mode", ["epic", "request"]);
/** Where a run came from: a tracker delegation or mention, or a chat thread (`chat_thread_id`). */
export const ralphRunOrigin = pgEnum("ralph_run_origin", ["tracker", "chat"]);
/** A chat thread's run: a query task's job, or a coding run. */
export const chatThreadRunKind = pgEnum("chat_thread_run_kind", ["query", "coding"]);
export const chatRunEventKind = pgEnum("chat_run_event_kind", [
  "response",
  "question",
  "permission_request",
  "completion",
  "failure",
  "cleanup_question",
]);
/**
 * Where a request came from (the request run's trigger kind, one of
 * `REQUEST_TRIGGERS` in `@omniralph/tasks`).
 */
export const ralphMessageTrigger = pgEnum("ralph_message_trigger", [
  "tracker.mention",
  "chat.request",
  "pr.review-findings",
  "pr.ci-failed",
  "pr.fix-command",
]);
/** How a repository's ralph runs work: legacy `ralph.*` jobs, or coding tasks. */
/** What started a triage run: an `@omniralph /triage` mention, or the triage label. */
export const triageRunTrigger = pgEnum("triage_run_trigger", ["mention", "label"]);
/** A work item draft posted from chat: `creating` while its **Create** click runs. */
export const chatTrackerIssueDraftStatus = pgEnum("chat_tracker_issue_draft_status", [
  "pending",
  "creating",
  "created",
  "cancelled",
  "expired",
]);
/**
 * A request Om drafted in chat (`draft_request`): `starting` / `adding` while a **Start
 * request** / **Add to backlog** click runs.
 */
export const chatRequestDraftStatus = pgEnum("chat_request_draft_status", [
  "pending",
  "starting",
  "started",
  "adding",
  "added",
  "dismissed",
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
  /**
   * Whether the control panel shows advanced settings (routing rules, playbooks, chat
   * overrides). A UI preference only: no API, routing or run code reads it.
   */
  showAdvanced: boolean("show_advanced").notNull().default(false),
  /** Whether the control panel plays sounds (notifications, Ask replies). On by default. */
  soundEnabled: boolean("sound_enabled").notNull().default(true),
  /** The control panel's sound volume, 0 to 1. */
  soundVolume: real("sound_volume").notNull().default(0.7),
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

/** The kind of GitHub account a GitHub App installation is on (`installation.account.type`). */
export type GitHubAccountType = "User" | "Organization";

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
    /**
     * GitHub: the kind of account the installation is on, which decides where its settings
     * page is. Null for GitLab, and for installations saved before it was recorded until
     * the next installation webhook or repository picker fills it in.
     */
    accountType: text("account_type").$type<GitHubAccountType>(),
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
 * An installed issue-tracker app, e.g. the Omniralph app in one tracker
 * workspace (`external_id` = the workspace/organization ID).
 */
/**
 * Which tracker workflow states mean "Ready to start" and which "Needs refining": by state
 * type (`triage`, `backlog`, `unstarted`, `started`), except in a team listed in `teams`,
 * whose workflow state IDs replace the type rule for that team only.
 */
export interface TrackerStateMapping {
  ready: { types: string[] };
  needsRefining: { types: string[] };
  teams: Record<string, { ready: string[]; needsRefining: string[] }>;
}

/** A tracker's Todo (`unstarted`) state type is Ready to start and its Backlog (`backlog`) Needs refining. */
export const DEFAULT_TRACKER_STATE_MAPPING: TrackerStateMapping = {
  ready: { types: ["unstarted"] },
  needsRefining: { types: ["backlog"] },
  teams: {},
};

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
    /** The tracker's readiness state mapping. */
    stateMapping: jsonb("state_mapping")
      .$type<TrackerStateMapping>()
      .notNull()
      .default(DEFAULT_TRACKER_STATE_MAPPING),
    /**
     * The labels that mark a work item as a Fix (matched ignoring case); any other work item
     * is a Story. Never empty.
     */
    fixLabels: text("fix_labels")
      .array()
      .notNull()
      .default(sql`ARRAY['Bug']::text[]`),
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
 * (`external_id` = the Slack team or enterprise ID, or the Discord guild ID), or an
 * organization's hidden `web` connection (`external_id` = the organization ID, no
 * credentials), created on first use by `ensureWebChatConnection`.
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

/**
 * A conversation with the control-panel agent: a thread started by mentioning the bot, or a
 * web chat (`platform` `web`: `external_thread_id` `web:{organizationId}:{id}`, with its
 * title, repo, branch and the member who started it; null on Slack and Discord threads).
 */
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
    /** A web chat's title: its first message, cut to 60 characters (`webChatTitle`). */
    title: text("title"),
    /** A web chat's repo; null for "all of the organization's repos". */
    repositoryId: uuid("repository_id").references((): AnyPgColumn => repositories.id, {
      onDelete: "set null",
    }),
    /** A web chat's branch (its repo's default branch when it started). */
    branch: text("branch"),
    /** The member who started a web chat: the only one who sees it. */
    startedByUserId: text("started_by_user_id").references(() => users.id, {
      onDelete: "cascade",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("chat_threads_connection_id_external_thread_id_uq").on(
      t.connectionId,
      t.externalThreadId,
    ),
    index("chat_threads_organization_id_idx").on(t.organizationId),
    /** A member's web chats, newest first (the chats list). */
    index("chat_threads_started_by_user_id_organization_id_updated_at_idx").on(
      t.startedByUserId,
      t.organizationId,
      t.updatedAt,
    ),
  ],
);

/**
 * A channel's choice of the playbooks "ask about code" and "start work" run
 * from chat, overriding the organization's (`chat.playbooks` in
 * `app_settings`); a null column keeps the organization's choice.
 */
export const chatChannelTaskSettings = pgTable(
  "chat_channel_task_settings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => chatConnections.id, { onDelete: "cascade" }),
    /** The channel the bot sees (`chat_threads.channel_id`). */
    channelId: text("channel_id").notNull(),
    /** A `chat-ask` playbook's ID. */
    askPlaybookId: text("ask_playbook_id"),
    /** A `request` playbook's ID. */
    startWorkPlaybookId: text("start_work_playbook_id"),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("chat_channel_task_settings_connection_id_channel_id_uq").on(
      t.connectionId,
      t.channelId,
    ),
    index("chat_channel_task_settings_organization_id_idx").on(t.organizationId),
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

/** What a web chat card is, from its button actions (`webCardRef`). */
export interface ChatWebCardRef {
  kind: "request_draft" | "tracker_issue_draft";
  draftId: string;
}

/**
 * A message of a web chat as the web shows it (as Slack's own message store is what Slack
 * shows); `chat_messages` stays the model's history.
 */
export const chatWebMessages = pgTable(
  "chat_web_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    author: chatWebMessageAuthor("author").notNull(),
    /** The member who wrote it (`user` messages). */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    markdown: text("markdown").notNull().default(""),
    status: chatWebMessageStatus("status").notNull().default("complete"),
    /** The serialized Chat SDK card, or null. */
    card: jsonb("card").$type<unknown>(),
    /** The draft the card shows, or null. */
    cardRef: jsonb("card_ref").$type<ChatWebCardRef>(),
    /** The ask run a relayed answer came from. */
    threadRunId: uuid("thread_run_id").references((): AnyPgColumn => chatThreadRuns.id, {
      onDelete: "set null",
    }),
    /** `clock_timestamp()`, so messages appended in one transaction keep their order. */
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    updatedAt: updatedAt(),
  },
  (t) => [index("chat_web_messages_thread_id_created_at_idx").on(t.threadId, t.createdAt)],
);

/**
 * A work item the control-panel agent drafted in a chat thread: posted as a
 * card with **Create** / **Cancel** buttons, created only when the member who
 * asked clicks **Create** before `expiresAt`.
 */
export const chatTrackerIssueDrafts = pgTable(
  "chat_tracker_issue_drafts",
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
    /** The tracker the work item is created in. */
    trackerProvider: integrationProvider("tracker_provider").notNull().default("linear"),
    teamId: text("team_id").notNull(),
    teamKey: text("team_key").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    projectName: text("project_name"),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    /** Tracker priority: 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low. */
    priority: integer("priority"),
    /** Screenshots from the thread to upload to the tracker and embed in the description. */
    attachments: jsonb("attachments")
      .$type<Array<ChatMessageAttachment & { ref: string }>>()
      .notNull()
      .default([]),
    status: chatTrackerIssueDraftStatus("status").notNull().default("pending"),
    /** The chat message of the card (set once posted). */
    externalMessageId: text("external_message_id"),
    /** The created work item. */
    trackerIssueId: text("tracker_issue_id"),
    trackerIssueIdentifier: text("tracker_issue_identifier"),
    trackerIssueUrl: text("tracker_issue_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("chat_tracker_issue_drafts_thread_id_idx").on(t.threadId)],
);

/**
 * A request Om drafted in a chat thread (`draft_request`) when an answer needs a code
 * change: posted as a card with **Start request** / **Add to backlog** / **Not now**, acted
 * on only by the member who asked, before `expiresAt`.
 */
export const chatRequestDrafts = pgTable(
  "chat_request_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    /** The linked member who asked: the only one whose click acts on it. */
    requestedByUserId: text("requested_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Their chat user ID. */
    requestedByExternalUserId: text("requested_by_external_user_id").notNull(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references((): AnyPgColumn => repositories.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** The self-contained description of the change (Markdown). */
    request: text("request").notNull(),
    status: chatRequestDraftStatus("status").notNull().default("pending"),
    /** Add to backlog: whether Om triages the work item at once. */
    triageNow: boolean("triage_now"),
    /** Why the last click didn't go through (shown on the card), or null. */
    error: text("error"),
    /** The request run Start request started. */
    ralphRunId: uuid("ralph_run_id").references((): AnyPgColumn => ralphRuns.id, {
      onDelete: "set null",
    }),
    /** The work item Add to backlog created. */
    workItemTracker: text("work_item_tracker"),
    workItemExternalId: text("work_item_external_id"),
    workItemIdentifier: text("work_item_identifier"),
    workItemUrl: text("work_item_url"),
    /** The chat message of the card (set once posted). */
    messageId: text("message_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("chat_request_drafts_thread_id_idx").on(t.threadId)],
);

/**
 * A work item delegated to the Omniralph app from a chat thread, written
 * just before the delegation: when the tracker's agent session for it starts the
 * run, `startRun` takes the row and ties the run to the thread (its
 * `chat_thread_id`) for start/PR/finish notifications. A row no session takes
 * within an hour is ignored and pruned.
 */
export const chatTrackerDelegations = pgTable(
  "chat_tracker_delegations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    trackerProvider: integrationProvider("tracker_provider").notNull().default("linear"),
    trackerIssueId: text("tracker_issue_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("chat_tracker_delegations_issue_idx").on(t.organizationId, t.trackerIssueId, t.createdAt),
    index("chat_tracker_delegations_created_at_idx").on(t.createdAt),
  ],
);

// ── Playbooks ────────────────────────────────────────────────────────────────

/**
 * An organization's own playbook (`@omniralph/tasks` `Playbook`, validated
 * when read) with the run requirements derived from it when it was saved
 * (`TaskRequirements`: installables, host tools, minimum agent version), so
 * enqueueing and claiming don't derive them again. `definition` holds every
 * field but the ID, name and role its columns hold. Built-in playbooks stay in
 * code under `builtin:<name>` IDs, so they never clash with these UUIDs.
 */
export const playbooks = pgTable(
  "playbooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Its `PlaybookRole` (never a built-in-only role). */
    role: text("role").notNull(),
    definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
    requirements: jsonb("requirements").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("playbooks_organization_id_idx").on(t.organizationId)],
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
    /** Reviews run on its pull and merge requests (the Reviews switch). */
    reviewsEnabled: boolean("reviews_enabled").notNull().default(true),
    /** The depth its reviews run at: their model, token cap, file limit and exploration. */
    reviewDepth: reviewDepth("review_depth").notNull().default("standard"),
    triggers: jsonb("triggers")
      .$type<RepositoryTriggers>()
      .notNull()
      .default(DEFAULT_REPOSITORY_TRIGGERS),
    pathExcludes: text("path_excludes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    customInstructions: text("custom_instructions"),
    /**
     * The review and review-summary playbooks (`builtin:<name>` or UUIDs) each PR event fans
     * out to, in order.
     */
    reviewPlaybookIds: text("review_playbook_ids")
      .array()
      .notNull()
      .default(sql`'{builtin:review-pr}'::text[]`),
    /** The correlation playbook that merges the results of a review run's playbooks. */
    correlationPlaybookId: text("correlation_playbook_id")
      .notNull()
      .default("builtin:correlate-findings"),
    /**
     * Work items routed here are built (the Coding switch). Turning it on needs a work item
     * match, and a match can't be removed while it's on.
     */
    codingEnabled: boolean("coding_enabled").notNull().default(false),
    /** Externally triggered queries (mentions, chat, triage) run here (the Ask switch). */
    askEnabled: boolean("ask_enabled").notNull().default(true),
    /** Extra instructions appended to every story and request prompt; null for none. */
    codingInstructions: text("coding_instructions"),
    /** Open a draft PR after the first pushed story (updated and marked ready at the end). */
    openPullRequestEarly: boolean("open_pull_request_early").notNull().default(false),
    /** Whether its coding runs may rebase and force-push the branch. */
    historyRewrite: historyRewrite("history_rewrite").notNull().default("when-asked"),
    /** Fix review findings, `@bot` requests and failed CI on its runs' PRs. */
    respondToReviewsAndCi: boolean("respond_to_reviews_and_ci").notNull().default(true),
    /**
     * The commands that must pass after every story and request on it, in order (the Coding
     * card's Checks); empty for none.
     */
    checks: text("checks")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** The story playbook a story attempt runs. */
    storyPlaybookId: text("story_playbook_id").notNull().default("builtin:implement-story"),
    /** The request playbook a lane's requests run. */
    requestPlaybookId: text("request_playbook_id").notNull().default("builtin:handle-request"),
    /**
     * The repository's default branch as last read from the code host (on add, whenever a
     * run reads it, and from webhook payloads); null until first read.
     */
    defaultBranch: text("default_branch"),
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
  ],
);

// ── Routing ──────────────────────────────────────────────────────────────────

/**
 * An organization's routing rules, evaluated in `position` order (the first match wins):
 * a condition over an issue's fields (`RoutingQuery`, validated against the tracker's field
 * catalog in `@omniralph/shared`) and the repository a matching issue builds in. Saving
 * replaces the whole list (`replaceRoutingRules`).
 */
export const routingRules = pgTable(
  "routing_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** 0-based evaluation order. */
    position: integer("position").notNull(),
    /** A repository of the same organization; deleting it deletes its rules. */
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    query: jsonb("query").$type<RoutingQuery>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("routing_rules_organization_position_uq").on(t.organizationId, t.position),
    index("routing_rules_repository_id_idx").on(t.repositoryId),
  ],
);

/**
 * A repository's work item match: the work items it builds (`apps/web/src/lib/routing/match.ts`).
 * Routing tries it after the organization's routing rules and before the default rules; the
 * most specific match wins. Team, project and labels match ignoring case.
 */
export const workItemMatches = pgTable(
  "work_item_matches",
  {
    /** One match per repository; deleting the repository deletes it. */
    repositoryId: uuid("repository_id")
      .primaryKey()
      .references(() => repositories.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tracker: workItemTracker("tracker").notNull(),
    /** The team's key (`ENG`). */
    team: text("team").notNull(),
    /** A project's name; null with `withoutProject` false is any project (or none). */
    project: text("project"),
    /** Only work items with no project. */
    withoutProject: boolean("without_project").notNull().default(false),
    /** Any of these labels; empty is any labels. */
    labels: text("labels").array().notNull().default([]),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: text("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("work_item_matches_organization_id_idx").on(t.organizationId),
    check(
      "work_item_matches_without_project_no_project",
      sql`not ${t.withoutProject} or ${t.project} is null`,
    ),
  ],
);

/**
 * The issue a follow-up was filed from (`fileFollowUps`), by tracker issue ID. A follow-up
 * routes the same as its source and rules can test its source's fields (`source.*`).
 */
export const followUpSources = pgTable(
  "follow_up_sources",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** The follow-up's tracker issue ID. */
    issueId: text("issue_id").notNull(),
    /** The tracker issue ID of the story it was filed from. */
    sourceIssueId: text("source_issue_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.issueId] })],
);

/**
 * A member's repository choice for one work item ("Change repo…" on the Backlog). Routing
 * tries it first (`createRouter`): while the repository stays connected, the item builds there.
 */
export const workItemOverrides = pgTable(
  "work_item_overrides",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tracker: workItemTracker("tracker").notNull(),
    /** The work item's ID in its tracker (a tracker issue ID). */
    externalId: text("external_id").notNull(),
    /** The chosen repository; null when it was deleted (routing then applies again). */
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    chosenBy: text("chosen_by").references(() => users.id, { onDelete: "set null" }),
    chosenAt: timestamp("chosen_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.tracker, t.externalId] }),
    index("work_item_overrides_repository_id_idx").on(t.repositoryId),
  ],
);

/** What a work item's Activity shows of the actions taken on it in Omniralph. */
export const workItemEventKind = pgEnum("work_item_event_kind", [
  "created",
  "repo_changed",
  "repo_reset",
  "moved_to_needs_refining",
  "prd_edited",
  "triage_requested",
  "started",
  "share_link_created",
  "share_link_revoked",
  "canceled",
]);

/** An action taken on a work item in Omniralph, for its Activity tab. */
export const workItemEvents = pgTable(
  "work_item_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tracker: workItemTracker("tracker").notNull(),
    externalId: text("external_id").notNull(),
    /** The member who acted; null for Om or a chat surface, or once the user is deleted. */
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** The actor's name when it happened, kept when the user is deleted. */
    actorName: text("actor_name").notNull(),
    kind: workItemEventKind("kind").notNull(),
    /** Kind-specific details, e.g. `{ repository: "customer-portal" }` for `repo_changed`. */
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("work_item_events_item_idx").on(t.organizationId, t.tracker, t.externalId, t.createdAt),
  ],
);

/**
 * A public review link of a work item's PRD ("Share review link", `/share/{token}`). Only the
 * token's SHA-256 is kept (the token is shown once); an optional password is kept as a
 * `scrypt$N$r$p$salt$hash` string.
 */
export const workItemShareLinks = pgTable(
  "work_item_share_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tracker: workItemTracker("tracker").notNull(),
    externalId: text("external_id").notNull(),
    /** SHA-256 of the token, base64url. */
    tokenHash: text("token_hash").notNull().unique(),
    passwordHash: text("password_hash"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("work_item_share_links_item_idx").on(t.organizationId, t.tracker, t.externalId)],
);

// ── Agents ───────────────────────────────────────────────────────────────

/** An agent's self-update progress (mirrors `AgentUpdateReport` in @omniralph/shared). */
export interface AgentUpdateState {
  state: "idle" | "draining" | "installing" | "confirming";
  version: string | null;
  previous: string | null;
  startsSincePending: number;
  error: string | null;
}

/**
 * Per-organization settings edited by its admins, one JSON value per key (e.g.
 * `agent.desiredVersion`).
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

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * The task types the agent runs (`system` is always accepted), as it reports them: its
     * local `acceptedTaskTypes`, sent in every heartbeat and claim. Read-only here. Null
     * until it reports one: every task type.
     */
    reportedAcceptedTaskTypes: text("reported_accepted_task_types").array(),
    reportedVersion: text("reported_version"),
    /** The installables installed on the agent, as its last heartbeat reported them. */
    reportedInstallables: jsonb("reported_installables")
      .$type<{ name: string; version: string }[]>()
      .notNull()
      .default([]),
    /** The Claude models the agent's login can run, as its last heartbeat reported them. */
    reportedModels: jsonb("reported_models")
      .$type<{ value: string; displayName: string }[]>()
      .notNull()
      .default([]),
    /**
     * The machine the agent runs on (host name, Coder workspace), as its last heartbeat that
     * carried one reported it; null until then (older agents send none).
     */
    reportedHost: jsonb("reported_host").$type<AgentHostReport>(),
    /**
     * The agent's slots (its local `maxConcurrency`), as its last heartbeat reported them.
     * Read-only here: the agent's `settings.json` is the only source. Null until it reports.
     */
    reportedMaxConcurrency: integer("reported_max_concurrency"),
    /** Both pools' effective limits (`short`, `long`), as last reported; null until then. */
    reportedPoolLimits: jsonb("reported_pool_limits").$type<{ short: number; long: number }>(),
    /** The agent's local version pin, as last reported; null when none or not reported. */
    reportedVersionPin: text("reported_version_pin"),
    /** The agent's installables allow-list, as last reported; null until it reports. */
    reportedInstallablesAllow: text("reported_installables_allow").array(),
    /**
     * The host tools the agent configured or was asked about (`requiredHostTools`), as its
     * last heartbeat reported them: a tool with a `path` is usable. Empty until it reports.
     */
    reportedHostTools: jsonb("reported_host_tools").$type<HostToolReport[]>().notNull().default([]),
    /**
     * Whether the agent's Claude login works (`status`, `source`, `checkedAt`), as its last
     * heartbeat that carried one reported it; null until then. No account details.
     */
    reportedClaude: jsonb("reported_claude").$type<ClaudeLoginReport>(),
    /**
     * The agent's failing token-refresh streak, as its last heartbeat reported it; null while
     * its refreshes succeed (a heartbeat without one clears it).
     */
    reportedTokenRefresh: jsonb("reported_token_refresh").$type<TokenRefreshReport>(),
    /** `supported` (under pm2) or `unsupported`, from the heartbeat; null for older agents. */
    selfUpdate: text("self_update").$type<"supported" | "unsupported">(),
    /** The agent's self-update progress, as last reported. */
    updateState: jsonb("update_state").$type<AgentUpdateState>(),
    /** Versions the agent failed to install or keep running; it never retries them. */
    failedVersions: text("failed_versions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    /**
     * Whether the live change events last announced the agent online: a heartbeat sets it
     * (and publishes) when it was false, the `agent-liveness` cron clears it (and publishes)
     * once the last heartbeat is older than the online window.
     */
    liveOnline: boolean("live_online").notNull().default(false),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /**
     * The agent's current signed refresh token (TOOL-856): its generation and the
     * `hashToken()` of its random ID. Redis holds the live values while hot state is on;
     * the daily `flush-agent-auth` cron writes them here. Null until the agent holds a
     * signed refresh token (enrolled before TOOL-856 and not refreshed since).
     */
    refreshGeneration: integer("refresh_generation"),
    refreshTokenIdHash: text("refresh_token_id_hash"),
    /**
     * The first generation of the agent's current refresh-token family: re-enrolling it in
     * place (TOOL-925) starts a family past every generation issued before, and a token of
     * an older generation is rejected (never a "newer generation" to catch up to). Null until
     * the agent is re-enrolled.
     */
    refreshFamilyStart: integer("refresh_family_start"),
    /** Soft delete (always after revoking): deleted agents are hidden everywhere. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    enrolledBy: text("enrolled_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("agents_organization_id_idx").on(t.organizationId)],
);

export const agentEnrollments = pgTable("agent_enrollments", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The organization the redeemed agent joins. */
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /** `hashToken()` of the one-time enrollment token; the token itself is never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  /** Display name for the agent this enrollment creates. */
  name: text("name"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  /** The agent created (or re-enrolled) when the token was redeemed. */
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  /**
   * A re-enrollment (TOOL-925): the existing agent redeeming the token re-activates, keeping
   * its ID, pins and history. Null for a token that enrolls a new agent.
   */
  reenrollAgentId: uuid("reenroll_agent_id").references(() => agents.id, { onDelete: "cascade" }),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

/**
 * Opaque refresh tokens from before TOOL-856. Presenting an unused one marks it used and issues
 * a signed refresh token (`agents.refresh_generation`); presenting a used one again revokes the
 * family and the agent (theft detection). New agents get signed refresh tokens only.
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
    /** The depth the run's reviews use; null for runs from before depths were recorded. */
    depth: reviewDepth("depth"),
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
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("review_runs_repository_pr_idx").on(t.repositoryId, t.prNumber),
    index("review_runs_organization_created_at_idx").on(t.organizationId, t.createdAt),
  ],
);

export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The review run the review is one task of; null for reviews from before review runs. */
    reviewRunId: uuid("review_run_id").references(() => reviewRuns.id, { onDelete: "cascade" }),
    /** The review task (`builtin:review-pr` or a UUID) the review ran. */
    taskId: text("task_id"),
    /**
     * The task posts its summary to a sticky comment (sink `sticky-comment`)
     * and no findings: it is left out of its run's correlation and posted review.
     */
    summaryOnly: boolean("summary_only").notNull().default(false),
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
    /** The depth the review ran at; null for reviews from before depths were recorded. */
    depth: reviewDepth("depth"),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    /** Token budget (the depth's `maxTokensPerReview` at review time). */
    budget: integer("budget").notNull(),
    durationMs: integer("duration_ms"),
    model: text("model"),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
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

/**
 * The sticky comment a summary-only review task keeps on a PR/MR, edited in
 * place by every later run of the task.
 */
export const stickyComments = pgTable(
  "sticky_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    /** PR number (GitHub) or MR IID (GitLab). */
    prNumber: integer("pr_number").notNull(),
    taskId: text("task_id").notNull(),
    /** SCM ID of the comment; null until it was first posted. */
    commentId: text("comment_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sticky_comments_repository_pr_task_uq").on(t.repositoryId, t.prNumber, t.taskId),
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

/** How an agent runs a job (`JOB_TASK_TYPES` in `@omniralph/shared`). */
export type JobTaskType = "query" | "review" | "coding" | "system";

/**
 * Why a `queued` job can't be claimed yet (`refreshHostToolWaits`): the host tools it requires
 * that no online agent that may claim it reports with a path, sorted.
 */
export interface JobWaitingReason {
  code: "host_tools_missing";
  hostTools: string[];
}

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Only agents of this organization receive the job and its credentials. */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Job type, e.g. `review.task` or `repo.sync`. */
    type: text("type").notNull(),
    /**
     * How the agent runs the job: `query`, `review`, `coding` or `system` (a
     * fixed command, no session). Only agents accepting it claim the job.
     */
    taskType: text("task_type").$type<JobTaskType>().notNull(),
    /** The task definition the job runs (`builtin:<name>` or a UUID); null for legacy jobs. */
    taskId: text("task_id"),
    /** Only agents reporting at least this version (semver) claim the job. */
    minAgentVersion: text("min_agent_version"),
    /** Only agents reporting every one of these installables (npm package names) claim the job. */
    requiredInstallables: text("required_installables")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Only agents with an effective path for every one of these host tools (by name) claim the job. */
    requiredHostTools: text("required_host_tools")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Why the queued job waits (`refreshHostToolWaits`); null when nothing holds it up. */
    waitingReason: jsonb("waiting_reason").$type<JobWaitingReason>(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatus("status").notNull().default("queued"),
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    /** Only this agent may claim the job (a pinned repo's job, or `repo.sync`); null: any agent of the organization. */
    targetAgentId: uuid("target_agent_id").references((): AnyPgColumn => agents.id, {
      onDelete: "set null",
    }),
    /** When a `queued` job may be claimed (later than creation for a delayed retry). */
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    /** When a `running` job's lease lapses: another agent may then claim it (crash takeover). */
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
    /** The ralph story a `ralph.story` job works on. */
    ralphStoryId: uuid("ralph_story_id").references((): AnyPgColumn => ralphStories.id, {
      onDelete: "set null",
    }),
    /** The review run a review task's (or a legacy `review.run`) job or its correlation job belongs to. */
    reviewRunId: uuid("review_run_id").references((): AnyPgColumn => reviewRuns.id, {
      onDelete: "set null",
    }),
    /** The triage run a `triage.run` job belongs to. */
    triageRunId: uuid("triage_run_id").references((): AnyPgColumn => triageRuns.id, {
      onDelete: "set null",
    }),
    /** The chat thread's query run a `chat.ask` job answers. */
    chatThreadRunId: uuid("chat_thread_run_id").references((): AnyPgColumn => chatThreadRuns.id, {
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
    index("jobs_ralph_story_id_idx").on(t.ralphStoryId),
    index("jobs_review_run_id_idx").on(t.reviewRunId),
    index("jobs_triage_run_id_idx").on(t.triageRunId),
    index("jobs_chat_thread_run_id_idx").on(t.chatThreadRunId),
    index("jobs_organization_created_at_idx").on(t.organizationId, t.createdAt),
    // The claim query: queued jobs that are available, and running jobs whose lease lapsed.
    index("jobs_claim_queued_idx")
      .on(t.organizationId, t.taskType, t.status, t.availableAt)
      .where(sql`status = 'queued'`),
    index("jobs_claim_lease_idx")
      .on(t.organizationId, t.taskType, t.leaseExpiresAt)
      .where(sql`status = 'running'`),
    check("jobs_task_type_valid", sql`${t.taskType} in ('query', 'review', 'coding', 'system')`),
  ],
);

/**
 * A finished session attempt's usage per model (the result's `usage.byModel`), stored with
 * the result (`completeJob`). Priced by `attempt_costs`; attempts from before agents
 * reported it have none.
 */
export const attemptModelUsage = pgTable(
  "attempt_model_usage",
  {
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    /** The model as Claude Code reported it (the `modelUsage` key). */
    model: text("model").notNull(),
    /** Its AI Gateway ID (`gatewayModelId`, from the canonical model); null when unmapped. */
    priceModelId: text("price_model_id"),
    /** Uncached input. */
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull(),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull(),
    /** 5-minute cache writes; every cache write when the 1-hour split is unknown. */
    cacheWrite5mTokens: bigint("cache_write_5m_tokens", { mode: "number" }).notNull(),
    /** 1-hour cache writes; null when unknown. */
    cacheWrite1hTokens: bigint("cache_write_1h_tokens", { mode: "number" }),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull(),
    /** The largest single request's prompt; null when unknown. */
    largestRequestInputTokens: integer("largest_request_input_tokens"),
    fastMode: boolean("fast_mode").notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.model] })],
);

/**
 * Anthropic models' list prices from the Vercel AI Gateway (`GET /v1/models`), refreshed
 * daily (`refreshModelPrices`), with history: a changed price closes its row (`valid_to`)
 * and opens a new one, so an attempt is priced at the price in effect when it finished.
 */
export const modelPrices = pgTable(
  "model_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The Gateway's model ID, e.g. `anthropic/claude-opus-5.5`. */
    modelId: text("model_id").notNull(),
    name: text("name").notNull(),
    /** USD per token (the base tier's, for tiered models). */
    inputUsd: numeric("input_usd").notNull(),
    outputUsd: numeric("output_usd").notNull(),
    cacheReadUsd: numeric("cache_read_usd"),
    /** 5-minute cache writes. */
    cacheWriteUsd: numeric("cache_write_usd"),
    /** The base tier's prompt limit (long-context pricing above it); null without tiers. */
    baseTierMaxTokens: integer("base_tier_max_tokens"),
    /** `-infinity` for a model's first price: it also prices attempts from before it was seen. */
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
    /** Null for the current price. */
    validTo: timestamp("valid_to", { withTimezone: true }),
    /** When the Gateway last listed this price. */
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("model_prices_open_model_id_idx")
      .on(t.modelId)
      .where(sql`valid_to is null`),
    index("model_prices_model_id_valid_from_idx").on(t.modelId, t.validFrom),
  ],
);

/**
 * Each priced attempt's list price in USD (created by migration 0112): its
 * `attempt_model_usage` rows × the `model_prices` in effect at the job's `finished_at`.
 * `cost_usd` is null when any of its models can't be priced exactly. Read only through
 * `queries/attempt-costs.ts`.
 */
export const attemptCosts = pgView("attempt_costs", {
  jobId: uuid("job_id").notNull(),
  costUsd: numeric("cost_usd"),
}).existing();

/** What a run's session reported: Claude's text (`thought`) or a tool call (`action`). */
export type RunActivityType = "thought" | "action";

/** Activities a run's session reported (`POST /api/agent/jobs/{id}/activities`), oldest first. */
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
 * (`POST /api/agent/jobs/{id}/permissions`), one row per request.
 */
export const runPermissionRequests = pgTable(
  "run_permission_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    /** Chosen by the agent; it reads the answer back with it. */
    requestId: text("request_id").notNull(),
    tool: text("tool").notNull(),
    detail: text("detail").notNull().default(""),
    askedAt: timestamp("asked_at", { withTimezone: true }).notNull().defaultNow(),
    /** When the agent stops waiting and denies the call. */
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

/** A tracker issue a run refers to (a story, or an external blocker). */
export interface RalphIssueRef {
  /** tracker issue ID. */
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
  /**
   * Blocks relations of the epic or its tasks that break the dependency rules (each one's
   * message): the run waits until they're fixed, checking again whenever it advances.
   */
  relations?: string[];
}

/**
 * The open tracker elicitation of a run: `repository` asks which repository to
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
  /** tracker issue ID of the manual story. */
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
  /** The lane whose worktree the story is prepared in (unset: the main lane). */
  laneId?: string | null;
}

/** Preparation of a run's manual stories (cyralph's `preparation*` session fields). */
/** What an epic audit found for one requirement. */
export interface RalphRequirementFindingRecord {
  /** The requirement's identifier (`FR-2`) and text. */
  id: string;
  text: string;
  status: "met" | "gap";
  /** The file or test that shows it's met, or where the audit looked. */
  evidence: string;
  /** For a gap: what is missing (else empty). */
  missing: string;
}

/**
 * One audit of a finished epic against its requirements (`ralph_runs.audits`, oldest
 * first), run by the story playbook's audit before the PR/MR opens: `running` until it
 * finishes, then `passed` (every requirement met), `gaps` (each gap filed as a task of
 * the epic, or, on the last round, listed in the PR/MR description) or `failed` (it
 * couldn't audit; the PR/MR opens and the thread says so). `skipped`: the epic lists no
 * requirements.
 */
export interface RalphEpicAudit {
  /** The audit round (1-based; rounds that judged the epic count). */
  round: number;
  /** The `ralph.audit-epic` job; null when skipped. */
  jobId: string | null;
  status: "running" | "passed" | "gaps" | "failed" | "skipped";
  /** The tracker IDs of the epic's tasks when it ran: new tasks since need a new audit. */
  storyIssueIds: string[];
  /** The commit audited; null for the branch as checked out. */
  commitSha: string | null;
  /** A finding per requirement (empty until it finishes, or when it failed). */
  requirements: RalphRequirementFindingRecord[];
  summary: string | null;
  /** Why it couldn't audit (`failed`). */
  error: string | null;
  /** Identifiers of the tasks filed for its gaps. */
  filed: string[];
  /** ISO timestamps. */
  startedAt: string;
  finishedAt: string | null;
}

export interface RalphPreparation {
  request: RalphPreparationRequest | null;
  /** Story issue ID -> how its preparation was settled; such stories aren't asked about again. */
  handled: Record<string, { how: "prepared" | "myself"; at: string; headSha?: string }>;
  /** `rerun preparation`: the next question is about the earliest open one, even if handled. */
  rerun?: boolean;
  /**
   * The branch HEAD a `ralph.prepare` job last reported (ISO `at` orders it against story commits),
   * in the lane it ran in (unset: the main lane).
   */
  head?: { sha: string; at: string; laneId?: string | null };
  /** Leads the next question (why it's asked again: a failure, or a stale approval). */
  lead?: string;
}

/**
 * A tool call a run's live session asked a person to approve in its conversation (the
 * repository's Claude Code settings `ask` about it). One at a time: the agent
 * waits for the answer before it asks about another call.
 */
export interface RalphPermissionQuestion {
  /** The agent's ID for the call; it reads the answer back with it. */
  requestId: string;
  /** The job whose session asks. */
  jobId: string;
  tool: string;
  detail: string;
  askedAt: string;
  /** When the agent stops waiting and denies the call (ISO 8601). */
  expiresAt: string;
  /** Unset while pending; `expired` when nobody answered in time (or the job ended). */
  answer?: "allowed" | "denied" | "expired";
  answeredAt?: string;
  answeredBy?: string | null;
}

/**
 * A file uploaded to the tracker (its upload host) that the run's jobs may
 * download through the control panel, by its attachment ID.
 */
export interface RalphAttachmentLink {
  /** The upload URL without its signed query. */
  url: string;
  title: string | null;
}

/**
 * A delegated work item being built story by story (the ralph loop), or a
 * request-mode run started from a chat thread (`origin` `chat`: no tracker
 * issue, session or stories). The control panel owns this state; every change goes through a row lock
 * (`lockRun`) because webhooks and job outcomes race.
 */
export const ralphRuns = pgTable(
  "ralph_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The organization whose tracker workspace delegated the issue (and whose repositories it uses). */
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    origin: ralphRunOrigin("origin").notNull().default("tracker"),
    /** The tracker of the run's issue and stories (`tracker` runs). */
    trackerProvider: integrationProvider("tracker_provider").notNull().default("linear"),
    /** The chat thread a `chat` run belongs to (its session posts there). */
    chatThreadId: uuid("chat_thread_id").references(() => chatThreads.id, {
      onDelete: "set null",
    }),
    /** The delegated issue (the epic, or the single issue); set for `tracker` runs only. */
    trackerIssueId: text("tracker_issue_id"),
    trackerIdentifier: text("tracker_identifier"),
    /** The delegated issue's title and tracker URL when the run started (for the Ralph runs pages). */
    trackerTitle: text("tracker_title"),
    trackerUrl: text("tracker_url"),
    /** The tracker's agent session, or a `comments:` ID on a tracker without sessions. */
    trackerSessionId: text("tracker_session_id"),
    kind: ralphRunKind("kind").notNull(),
    mode: ralphRunMode("mode").notNull().default("epic"),
    /** Tracker issue ID of the story to work on first (a delegated sub-issue). */
    focusStoryId: text("focus_story_id"),
    /** Null while the run waits for a person to pick one (`pending_elicitation`). */
    repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "cascade" }),
    /** How the repository was chosen, e.g. "team `ENG`" or "your selection" (kept on re-routing). */
    routedBy: text("routed_by"),
    /**
     * The main lane's sticky agent (`ralph_lanes.agent_id`), mirrored for
     * run-level readers. Lane jobs are targeted at their lane's agent.
     */
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
    /** The open tracker elicitation the run waits on an answer to. */
    pendingElicitation: jsonb("pending_elicitation").$type<RalphPendingElicitation>(),
    /** The `cyralph-prepare` question, approvals and answers of the run's manual stories. */
    preparation: jsonb("preparation").$type<RalphPreparation>(),
    /** The audits of the finished epic against its requirements, oldest first. */
    audits: jsonb("audits").$type<RalphEpicAudit[]>().notNull().default([]),
    /** The latest tool call a live session asked a person to approve, and the answer. */
    permission: jsonb("permission").$type<RalphPermissionQuestion>(),
    /** Attachment ID -> tracker upload, for every attachment listed in the run's job payloads. */
    attachments: jsonb("attachments")
      .$type<Record<string, RalphAttachmentLink>>()
      .notNull()
      .default({}),
    /**
     * The coding task the run's requests run on the repository's `tasks`
     * path, overriding its `request_task_id` (a chat run's "start work" task).
     */
    codingTaskId: text("coding_task_id"),
    /** Jobs enqueued for the run so far. */
    iterations: integer("iterations").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ralph_runs_agent_session_uq").on(t.trackerSessionId),
    /** At most one unfinished tracker run per delegated issue (and organization). */
    uniqueIndex("ralph_runs_issue_active_uq")
      .on(t.organizationId, t.trackerIssueId)
      .where(sql`origin = 'tracker' and status in ('pending', 'running', 'waiting')`),
    /** At most one unfinished chat run per thread. */
    uniqueIndex("ralph_runs_chat_thread_active_uq")
      .on(t.chatThreadId)
      .where(sql`origin = 'chat' and status in ('pending', 'running', 'waiting')`),
    index("ralph_runs_chat_thread_id_idx").on(t.chatThreadId, t.createdAt),
    /**
     * A tracker run has its issue and agent session; a chat run only does what
     * it was asked. A chat run starts with its thread (`createRun` requires
     * it), but loses it when the thread goes (e.g. the chat connection is
     * removed), so the thread can't be required here.
     */
    check(
      "ralph_runs_origin_check",
      sql`(origin = 'tracker' and tracker_issue_id is not null and tracker_identifier is not null and tracker_session_id is not null)
        or (origin = 'chat' and mode = 'request')`,
    ),
    index("ralph_runs_tracker_issue_id_idx").on(t.trackerIssueId, t.createdAt),
    index("ralph_runs_status_created_at_idx").on(t.status, t.createdAt),
    index("ralph_runs_repository_created_at_idx").on(t.repositoryId, t.createdAt),
    index("ralph_runs_organization_created_at_idx").on(t.organizationId, t.createdAt),
  ],
);

/**
 * A run started from a chat thread: a query run (its job) or a coding run
 * (its ralph run). Finds a thread's runs, and a run's thread. Tracker runs
 * delegated from chat keep only `ralph_runs.chat_thread_id`.
 */
export const chatThreadRuns = pgTable(
  "chat_thread_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    kind: chatThreadRunKind("kind").notNull(),
    /** A `query` run's job. */
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    /** A `coding` run. */
    ralphRunId: uuid("ralph_run_id").references(() => ralphRuns.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("chat_thread_runs_job_id_uq").on(t.jobId),
    uniqueIndex("chat_thread_runs_ralph_run_id_uq").on(t.ralphRunId),
    index("chat_thread_runs_chat_thread_id_created_at_idx").on(t.chatThreadId, t.createdAt),
    index("chat_thread_runs_organization_created_at_idx").on(t.organizationId, t.createdAt),
    check(
      "chat_thread_runs_kind_check",
      sql`(kind = 'query' and job_id is not null and ralph_run_id is null)
        or (kind = 'coding' and ralph_run_id is not null and job_id is null)`,
    ),
  ],
);

/**
 * Something a run mapped to a chat thread has for the thread (an answer, a
 * question, an approval request, its end), stored instead of posted: the
 * chat responder relays it in the thread (`processed_at` once it has).
 */
export const chatRunEvents = pgTable(
  "chat_run_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    chatThreadId: uuid("chat_thread_id")
      .notNull()
      .references(() => chatThreads.id, { onDelete: "cascade" }),
    threadRunId: uuid("thread_run_id")
      .notNull()
      .references(() => chatThreadRuns.id, { onDelete: "cascade" }),
    kind: chatRunEventKind("kind").notNull(),
    /** What happened, sanitized for the thread (`ChatRunEventBody`). */
    body: jsonb("body").$type<Record<string, unknown>>().notNull(),
    /** Identifies the event, so a replayed one is recorded once. */
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: createdAt(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [
    uniqueIndex("chat_run_events_idempotency_key_uq").on(t.idempotencyKey),
    index("chat_run_events_chat_thread_id_created_at_idx").on(t.chatThreadId, t.createdAt),
  ],
);

/** The history of the progress metric a story reported in its rounds (`ralph_stories.round_metrics`). */
export interface RalphRoundMetrics {
  name: string;
  /** Whether a higher or a lower value is better. */
  direction: "higher" | "lower";
  target?: number;
  /** Oldest first; `at` is an ISO timestamp. */
  values: { round: number; value: number; at: string }[];
}

/**
 * Advice a story's sessions gave for another project or repository (`ralph_stories.recommendations`):
 * shown in the run, never filed as an issue.
 */
export interface RalphStoryRecommendation {
  title: string;
  description: string;
  /** ISO timestamp of the result that last gave it. */
  at: string;
}

/** The verifier's verdict on one acceptance criterion of a story attempt. */
export interface RalphCriterionVerdictRecord {
  criterion: string;
  accepted: boolean;
  /** The evidence it was accepted on, or why it was sent back. */
  reason: string;
}

/** A follow-up a story's session reported, kept until its attempt is verified. */
export interface RalphPendingFollowUp {
  title: string;
  description: string;
  manual: boolean;
  after?: "epic";
  reason?: string;
}

/**
 * One check of a story attempt by the story playbook's task verifier
 * (`ralph_stories.verifications`, oldest first): `running` until the verifier
 * finishes, then `accepted` (the story is done), `rejected` (the attempt failed with
 * the reasons as feedback) or `failed` (the verifier couldn't check; the story counts
 * as done and the thread says so).
 */
export interface RalphTaskVerification {
  /** The verifier's `ralph.verify-task` job. */
  jobId: string;
  /** The `ralph.story` job of the attempt it checks. */
  storyJobId: string;
  /** The attempt it checks (1-based). */
  attempt: number;
  status: "running" | "accepted" | "rejected" | "failed";
  /** The attempt's commit; null when it committed nothing. */
  commitSha: string | null;
  /** A verdict per acceptance criterion (empty until it finishes, or when it failed). */
  criteria: RalphCriterionVerdictRecord[];
  summary: string | null;
  /** Why the verifier couldn't check (`failed`). */
  error: string | null;
  /** ISO timestamps. */
  startedAt: string;
  finishedAt: string | null;
  /**
   * While `running`: what completing the story applies once the verifier accepts it
   * (the session's summary and follow-ups, and whether it wrote the progress log).
   */
  pending?: { summary: string; followUps: RalphPendingFollowUp[]; wroteProgress: boolean };
}

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

/**
 * Cleanup of a lane after its PR/MR merged (cyralph's merged-worktree
 * cleanup), or its keep-branch form after the PR/MR closed unmerged or the
 * run stopped (`keepBranch`).
 */
export interface RalphLaneCleanup {
  /**
   * `pending`: waits until none of the run's jobs is active; `running`: its
   * `worktree.cleanup` RPC (or legacy `ralph.cleanup` job) runs; `done`: the worktree is gone (questions may be
   * open); `failed`: the job failed (the reconcile cron tries again).
   */
  status: "pending" | "running" | "done" | "failed";
  /** ISO timestamp of the last change. */
  at: string;
  /** The merged PR/MR head; null for a keep-branch cleanup. */
  mergedSha: string | null;
  /**
   * Set for a keep-branch cleanup, with why: the PR/MR closed unmerged, or
   * the run stopped (it may resume). It stashes and removes the worktree and
   * keeps the local branch; it asks no questions.
   */
  keepBranch?: "closed" | "stopped";
  /** The cleanup job (`worktree.cleanup`, or a legacy `ralph.cleanup`) doing the cleanup or carrying out an answer, until its outcome is applied. */
  jobId?: string;
  /** The answer that job carries out (`expired`: the branch question timed out). */
  answer?: { kind: "stashes" | "branch"; option: string; expired?: boolean };
  /** Open questions, oldest first. */
  questions: RalphCleanupQuestion[];
  error?: string;
}

/**
 * Where a lane is in the run's finish (cyralph's `publishLane`): with a story
 * task that pushes only at the end, its `ralph.push` run is pushing the
 * branch, then it was pushed; its `ralph.describe-pr` job is writing the
 * PR/MR, the PR/MR was opened or updated, or a step failed (collected into
 * the run's error once every lane is through). Null: not published since its
 * last story.
 */
export type RalphLanePublish =
  | { status: "pushing"; jobId: string }
  | { status: "pushed"; /** The branch head pushed. */ sha: string }
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
    /** Whether the open PR/MR is a draft, as its code host last said. */
    prDraft: boolean("pr_draft").notNull().default(false),
    /** Its human review state, from the code host's webhooks (the bot's own reviews don't count). */
    prReviewState: prReviewState("pr_review_state").notNull().default("none"),
    /** When the draft, review or merge state last changed. */
    prStateUpdatedAt: timestamp("pr_state_updated_at", { withTimezone: true }),
    mergeSha: text("merge_sha"),
    /** Omniralph reviews acted on for this PR/MR (capped by `maxReviewRounds`). */
    reviewRounds: integer("review_rounds").notNull().default(0),
    /** Reviews (`reviews.id`) already seen: acted on, skipped as stale, or over the round limit. */
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
    /**
     * The lane's sticky agent: the one its last job started on. Its later
     * jobs are targeted at it while it is usable (`laneAgentId`).
     */
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
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

/**
 * A run's hidden ref (`refs/omniralph/runs/<run>`, outside `refs/heads/`) on
 * a repository's `origin`: a run whose story task pushes only at the end
 * keeps its story commits there. Recorded from story outcomes; a
 * `worktree.cleanup` RPC deletes it on `origin` once the run is over (or the
 * age sweep finds it), which sets `deleted_at`.
 */
export const hiddenRefs = pgTable(
  "hidden_refs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references((): AnyPgColumn => ralphRuns.id, { onDelete: "cascade" }),
    ref: text("ref").notNull(),
    /** The SHA last pushed to it. */
    sha: text("sha").notNull(),
    createdAt: createdAt(),
    /** When it was deleted on `origin` (null: still there, as far as we know). */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("hidden_refs_repository_ref_uq").on(t.repositoryId, t.ref),
    index("hidden_refs_run_idx").on(t.runId),
  ],
);

/** One story (tracker sub-issue, or the single issue) of a run. */
export const ralphStories = pgTable(
  "ralph_stories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => ralphRuns.id, { onDelete: "cascade" }),
    trackerProvider: integrationProvider("tracker_provider").notNull().default("linear"),
    trackerIssueId: text("tracker_issue_id").notNull(),
    identifier: text("identifier").notNull(),
    title: text("title").notNull(),
    /** Sub-issue order in the epic (for display; selection re-reads the tracker). */
    position: integer("position").notNull().default(0),
    status: ralphStoryStatus("status").notNull().default("pending"),
    /** Finished attempts (redeliveries don't count). */
    attempts: integer("attempts").notNull().default(0),
    /** Rounds: blocked results that filed follow-ups (a review loop), which don't use attempts. */
    rounds: integer("rounds").notNull().default(0),
    /** The progress metric the story reported in its rounds; null until it reports one. */
    roundMetrics: jsonb("round_metrics").$type<RalphRoundMetrics>(),
    /** Advice for other projects its sessions gave, latest per title (never filed as issues). */
    recommendations: jsonb("recommendations")
      .$type<RalphStoryRecommendation[]>()
      .notNull()
      .default([]),
    /** The task verifier's checks of its attempts, oldest first. */
    verifications: jsonb("verifications").$type<RalphTaskVerification[]>().notNull().default([]),
    /** Why the last attempt didn't complete, passed to the next one. */
    lastFeedback: text("last_feedback"),
    commitSha: text("commit_sha"),
    lastJobId: uuid("last_job_id").references(() => jobs.id, { onDelete: "set null" }),
    /** The lane (repository) the story runs in; null until the run has a repository. */
    laneId: uuid("lane_id").references(() => ralphLanes.id, { onDelete: "set null" }),
    /**
     * Why the story is treated as manual although it isn't labelled so: it
     * routes to a repository with coding off (cyralph's `elsewhere`).
     */
    elsewhere: text("elsewhere"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("ralph_stories_run_issue_uq").on(t.runId, t.trackerIssueId)],
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
    /** `/ship`: the request job that takes it commits, pushes and opens the PR/MR. */
    ship: boolean("ship").notNull().default(false),
    /** Where the message came from (a request run's trigger kind); null for older messages. */
    trigger: ralphMessageTrigger("trigger"),
    /** Who wrote it in the tracker, when known. */
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

// ── Triage ───────────────────────────────────────────────────────────────────

/**
 * The last `triage.run` result a triage run applied (a `TriageRunResult` from
 * `@omniralph/shared`, which this package doesn't depend on).
 */
export type TriageLastResult = Record<string, unknown>;

/**
 * A triage of a tracker issue in one tracker agent session, so the session's
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
    trackerProvider: integrationProvider("tracker_provider").notNull().default("linear"),
    trackerIssueId: text("tracker_issue_id").notNull(),
    trackerSessionId: text("tracker_session_id").notNull(),
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
    uniqueIndex("triage_runs_agent_session_uq").on(t.trackerSessionId),
    /** At most one unfinished triage per issue (and organization). */
    uniqueIndex("triage_runs_issue_active_uq")
      .on(t.organizationId, t.trackerIssueId)
      .where(sql`status in ('queued', 'running')`),
    index("triage_runs_organization_created_at_idx").on(t.organizationId, t.createdAt),
  ],
);

// ── Run loop ─────────────────────────────────────────────────────────────────

/** The kinds of run the loop driver iterates (`run_iterations.run_kind`): the run's own table. */
export const LOOP_RUN_KINDS = ["review", "triage"] as const;
export type LoopRunKind = (typeof LOOP_RUN_KINDS)[number];

/**
 * Where an iteration is: its worker runs (`working`), its verifier checks the
 * worker's output (`verifying`), it got the verifier's verdict (`done`), or its
 * worker or verifier failed (`failed`).
 */
export const RUN_ITERATION_STATUSES = ["working", "verifying", "done", "failed"] as const;
export type RunIterationStatus = (typeof RUN_ITERATION_STATUSES)[number];

/** The verifier's verdict on an iteration: the run converged, or it needs another pass. */
export const RUN_ITERATION_VERDICTS = ["converged", "continue"] as const;
export type RunIterationVerdict = (typeof RUN_ITERATION_VERDICTS)[number];

/**
 * Why a looped run stopped, on its last iteration: the verifier reported
 * convergence, the run used `maxIterations`, its metric stalled for
 * `stallRounds`, or a worker or verifier failed.
 */
export const RUN_LOOP_OUTCOMES = ["converged", "max-iterations", "stalled", "failed"] as const;
export type RunLoopOutcome = (typeof RUN_LOOP_OUTCOMES)[number];

/** The progress metric a loop's verifier reported for an iteration (e.g. open findings). */
export interface RunIterationMetric {
  name: string;
  value: number;
  /** Whether a higher or a lower value is better. */
  direction: "higher" | "lower";
  target?: number;
}

/**
 * The iterations of a looped query or review run (`lib/runs/loop.ts`): each a
 * worker session then a verifier session, the verifier's findings feeding the
 * next iteration's worker. `run_kind` names the run's table (`review_runs`,
 * `triage_runs`) and `run_id` its row; the run's loop limits are copied onto
 * each iteration when it starts, so a playbook edit doesn't change a running loop.
 */
export const runIterations = pgTable(
  "run_iterations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    runKind: text("run_kind").$type<LoopRunKind>().notNull(),
    runId: uuid("run_id").notNull(),
    /** 1 for the first iteration. */
    number: integer("number").notNull(),
    status: text("status").$type<RunIterationStatus>().notNull().default("working"),
    /** The previous verifier's findings, the worker's input; null for the first iteration. */
    feedback: text("feedback"),
    workerJobId: uuid("worker_job_id").references(() => jobs.id, { onDelete: "set null" }),
    verifierJobId: uuid("verifier_job_id").references(() => jobs.id, { onDelete: "set null" }),
    /** Null until the verifier answered (and for a failed iteration). */
    verdict: text("verdict").$type<RunIterationVerdict>(),
    metric: jsonb("metric").$type<RunIterationMetric>(),
    /** The verifier's summary of the iteration. */
    summary: text("summary"),
    /** What the verifier sent back for the next iteration. */
    findings: jsonb("findings").$type<string[]>().notNull().default([]),
    /** Why the worker or verifier failed (`failed`). */
    error: text("error"),
    /** Set on the run's last iteration: why the loop stopped. */
    outcome: text("outcome").$type<RunLoopOutcome>(),
    maxIterations: integer("max_iterations").notNull(),
    stallRounds: integer("stall_rounds").notNull(),
    createdAt: createdAt(),
    /** When the worker finished and the verifier started. */
    verifyingAt: timestamp("verifying_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("run_iterations_run_number_uq").on(t.runKind, t.runId, t.number),
    index("run_iterations_worker_job_id_idx").on(t.workerJobId),
    index("run_iterations_verifier_job_id_idx").on(t.verifierJobId),
    check("run_iterations_run_kind_valid", sql`${t.runKind} in ('review', 'triage')`),
    check(
      "run_iterations_status_valid",
      sql`${t.status} in ('working', 'verifying', 'done', 'failed')`,
    ),
    check(
      "run_iterations_verdict_valid",
      sql`${t.verdict} is null or ${t.verdict} in ('converged', 'continue')`,
    ),
    check(
      "run_iterations_outcome_valid",
      sql`${t.outcome} is null or ${t.outcome} in ('converged', 'max-iterations', 'stalled', 'failed')`,
    ),
    check("run_iterations_number_positive", sql`${t.number} >= 1`),
  ],
);

// ── Webhooks ─────────────────────────────────────────────────────────────────

/**
 * Webhook deliveries that were acted on, keyed by the provider's delivery ID
 * (e.g. `X-GitHub-Delivery`, `X-Gitlab-Event-UUID`, or the tracker's header), so a
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

export const webhookEventOutcome = pgEnum("webhook_event_outcome", [
  "started_run",
  "updated_run",
  "ignored",
  "failed",
  "duplicate",
]);

/**
 * The delivery log: every verified code-host and tracker delivery that resolved to an
 * organization, with what it did (kept 14 days, `pruneWebhookEvents`). Separate from
 * `webhook_deliveries`, which only de-duplicates. A replay is a new row with
 * `replay_of_id`. Header values and signatures are never stored.
 */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    provider: webhookProvider("provider").notNull(),
    /** The code-host connection that verified it (GitHub, GitLab). */
    scmConnectionId: uuid("scm_connection_id").references(() => scmConnections.id, {
      onDelete: "cascade",
    }),
    /** The tracker integration it came through. */
    integrationId: uuid("integration_id").references(() => integrations.id, {
      onDelete: "cascade",
    }),
    repositoryId: uuid("repository_id").references(() => repositories.id, {
      onDelete: "set null",
    }),
    /** The provider's delivery ID (or, for a tracker without one, the body's hash). */
    deliveryId: text("delivery_id"),
    /** The event and its action, e.g. `pull_request.synchronize`, `AgentSessionEvent.created`. */
    event: text("event").notNull(),
    /** The parsed body; null when it was over the size limit (`payload_truncated`). */
    payload: jsonb("payload"),
    payloadTruncated: boolean("payload_truncated").notNull().default(false),
    outcome: webhookEventOutcome("outcome").notNull(),
    reasonCode: text("reason_code"),
    /** `reason_code` in plain language, or a failure's message. */
    reason: text("reason"),
    /** The run the delivery started or updated (no FK: a run lives in one of four tables). */
    runId: uuid("run_id"),
    runKind: text("run_kind").$type<"epic" | "request" | "review" | "triage" | "ask">(),
    replayOfId: uuid("replay_of_id").references((): AnyPgColumn => webhookEvents.id, {
      onDelete: "set null",
    }),
    replayedBy: text("replayed_by").references(() => users.id, { onDelete: "set null" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("webhook_events_scm_connection_received_at_idx").on(t.scmConnectionId, t.receivedAt),
    index("webhook_events_integration_received_at_idx").on(t.integrationId, t.receivedAt),
    index("webhook_events_received_at_idx").on(t.receivedAt),
    check(
      "webhook_events_source",
      sql`(${t.scmConnectionId} is null) <> (${t.integrationId} is null)`,
    ),
  ],
);

// ── Inbox ────────────────────────────────────────────────────────────────────

export const inboxItemState = pgEnum("inbox_item_state", ["done", "snoozed"]);

/**
 * A user's Done or Snooze of an Inbox item (`inbox.ts`), by the item's key. Items themselves
 * are derived from run state on read; a key encodes what makes an item new, so a new failure
 * of a run marked Done has a new key and shows up again.
 */
export const inboxItemStates = pgTable(
  "inbox_item_states",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    itemKey: text("item_key").notNull(),
    state: inboxItemState("state").notNull(),
    /** Until when a `snoozed` item is hidden; null for `done`. */
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.itemKey] }),
    index("inbox_item_states_updated_at_idx").on(t.updatedAt),
    check(
      "inbox_item_states_snooze",
      sql`(${t.state} = 'snoozed') = (${t.snoozedUntil} is not null)`,
    ),
  ],
);

// ── Settings change history ──────────────────────────────────────────────────

/** A changed field of a settings save: its display values before and after ("changed" for secrets). */
export interface SettingsFieldChange {
  field: string;
  label: string;
  before: SettingsDisplayValue;
  after: SettingsDisplayValue;
}

/** A field's value as a person reads it: text, a number, a switch, a list, or none. */
export type SettingsDisplayValue = string | number | boolean | null | string[];

/**
 * Who changed a tracked settings section (`section`, e.g. `repository.reviews`), when, and
 * which fields (`settings-changes.ts`). `subject_id` is the section's subject (a repository,
 * a connection) or null for organization-wide sections; it has no FK, so the history of a
 * removed connection stays readable. Written in the save's own transaction.
 */
export const settingsChanges = pgTable(
  "settings_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    section: text("section").notNull(),
    subjectId: uuid("subject_id"),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** The actor's name when they saved, kept when the user is gone. */
    actorName: text("actor_name").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
    changes: jsonb("changes").$type<SettingsFieldChange[]>().notNull(),
  },
  (t) => [
    index("settings_changes_organization_section_subject_changed_at_idx").on(
      t.organizationId,
      t.section,
      t.subjectId,
      t.changedAt,
    ),
  ],
);

// ── Search ───────────────────────────────────────────────────────────────────

/** What the search palette opens: a run, a Backlog work item, a repo, an agent or a settings page. */
export const recentItemKind = pgEnum("recent_item_kind", [
  "run",
  "work_item",
  "repository",
  "agent",
  "settings",
]);

/**
 * The items a user last opened from the search palette (`search.ts`), newest first, at most
 * `RECENT_ITEMS_CAP` per user. `ref_id` is the item's ID (a work item's URL ID, a settings
 * page's path); `organization_id` is the item's organization (null for a settings page), so
 * a read only shows items of organizations in the user's scope.
 */
export const userRecentItems = pgTable(
  "user_recent_items",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: recentItemKind("kind").notNull(),
    refId: text("ref_id").notNull(),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.kind, t.refId] }),
    index("user_recent_items_user_opened_at_idx").on(t.userId, t.openedAt),
  ],
);
