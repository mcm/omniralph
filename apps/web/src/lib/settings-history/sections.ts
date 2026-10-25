import "server-only";
import { createHash } from "node:crypto";
import {
  connectionCredentials,
  DESIRED_HARNESS_VERSION_KEY,
  getAllowedTaskTypeDefaults,
  getAppSetting,
  getChatConnection,
  getChatTaskDefaults,
  getDefaultMaxConcurrency,
  getIntegrationById,
  getRepository,
  getScmConnection,
  listChatChannelTaskSettings,
  listConnectionRepositories,
  listMembers,
  listOrganizationDomains,
  listPendingInvitationsForOrganization,
  listRepositoryOverview,
  listRepositoryPinnedHarnessNames,
  listReviewProfiles,
  listRoutingRules,
  getOrganization,
  recordSettingsChange,
  storedCredentialsDigest,
  type Database,
  type RunsSinceScope,
  type SettingsActor,
  type SettingsFields,
  type SettingsValues,
  type TrackedSettings,
} from "@omniralph/db";
import { parseRalphSettings, type RalphSettings } from "@omniralph/shared";
import type { TaskType } from "@omniralph/tasks";
import type { OrgUser } from "@/lib/auth/session";
import { platformChannelId } from "@/lib/chat/tasks";
import { listTaskDefinitions } from "@/lib/definitions";
import type { SettingsSection } from "@/lib/live/events";
import { LINEAR_ROUTING_FIELDS } from "@/lib/linear/routing-fields";
import { describeQuery } from "@/lib/routing/describe";
import { userDisplayName } from "@/lib/user-display";

/**
 * The tracked settings sections of the change history (Design rule 11): each section's
 * field map (labels, secret fields), how to read its display values on the save's
 * transaction, and which runs count as "runs since" a change. Save paths wrap their writes
 * in `withSettingsChanges` with the `tracked*` specs here.
 */

/** Who saves: the signed-in user, by the name the panel shows. */
export function settingsActor(user: Pick<OrgUser, "id" | "name" | "email">) {
  return { userId: user.id, name: userDisplayName(user) };
}

/** A repository's task-type switch: on, off, or the organization's default. */
function switchValue(value: boolean | null): string {
  if (value === null) return "Organization default";
  return value ? "On" : "Off";
}

const onOff = (value: boolean) => (value ? "On" : "Off");

/** Task names by ID (built-in and the organization's own); unknown IDs read as themselves. */
async function taskNames(db: Database, organizationId: string) {
  const tasks = await listTaskDefinitions(db, organizationId);
  const names = new Map(tasks.map((t) => [t.definition.id, t.definition.name]));
  return (id: string) => names.get(id) ?? id;
}

// ── repository.reviews ──────────────────────────────────────────────────────

const REPOSITORY_REVIEWS_FIELDS: SettingsFields = {
  reviews: { label: "Reviews" },
  profile: { label: "Review profile" },
  onOpen: { label: "Review when opened" },
  onPush: { label: "Review on push" },
  drafts: { label: "Review drafts" },
  pathExcludes: { label: "Excluded paths" },
  customInstructions: { label: "Custom instructions" },
  reviewTasks: { label: "Review tasks" },
  correlationTask: { label: "Correlation task" },
};

async function readRepositoryReviews(
  db: Database,
  organizationId: string,
  repositoryId: string,
): Promise<SettingsValues | null> {
  const repository = await getRepository(db, repositoryId, organizationId);
  if (!repository) return null;
  const [profiles, task] = await Promise.all([
    listReviewProfiles(db, organizationId),
    taskNames(db, organizationId),
  ]);
  return {
    reviews: switchValue(repository.enabled),
    profile: profiles.find((p) => p.id === repository.profileId)?.name ?? repository.profileId,
    onOpen: onOff(repository.triggers.onOpen),
    onPush: onOff(repository.triggers.onPush),
    drafts: onOff(repository.triggers.drafts),
    pathExcludes: repository.pathExcludes,
    customInstructions: repository.customInstructions,
    reviewTasks: repository.reviewTaskIds.map(task),
    correlationTask: task(repository.correlationTaskId),
  };
}

export function trackedRepositoryReviews(
  organizationId: string,
  repositoryId: string,
): TrackedSettings {
  return {
    organizationId,
    section: "repository.reviews",
    subjectId: repositoryId,
    fields: REPOSITORY_REVIEWS_FIELDS,
    read: (db) => readRepositoryReviews(db, organizationId, repositoryId),
  };
}

// ── repository.coding ───────────────────────────────────────────────────────

const RALPH_SETTING_LABELS = {
  verifyCommands: "Quality gate commands",
  runPrdQualityGates: "Run the PRD's quality gates",
  appendInstruction: "Extra instructions",
  allowedTools: "Allowed tools",
  disallowedTools: "Disallowed tools",
  model: "Model",
  fallbackModel: "Fallback model",
  allowPreparation: "Offer to run a manual story's preparation",
  manualLabels: "Manual labels",
  blockedLabels: "Blocked labels",
  historyRewrite: "Rewrite history",
  respondToReviews: "Fix review findings",
  maxReviewRounds: "Review rounds",
  respondToCiFailures: "Fix failed CI",
  maxFixRounds: "CI fix rounds",
  cleanupMergedWorktrees: "Clean up after merge",
  unmergedBranchTimeoutMinutes: "Unmerged branch timeout (minutes)",
  epicCompletedState: "Epic completed state",
  openPullRequestEarly: "Open the pull request early",
  setupCommand: "Setup command",
} as const satisfies Record<keyof RalphSettings, string>;

const REPOSITORY_CODING_FIELDS: SettingsFields = {
  coding: { label: "Coding" },
  query: { label: "Ask about code" },
  codingPath: { label: "Coding path" },
  storyTask: { label: "Story task" },
  requestTask: { label: "Request task" },
  ...Object.fromEntries(
    Object.entries(RALPH_SETTING_LABELS).map(([key, label]) => [key, { label }]),
  ),
};

const CODING_PATH_LABELS = { legacy: "Legacy jobs", tasks: "Coding tasks" } as const;

/** A coding setting's display value: lists of text stay lists, the rest as text. */
function ralphValue(value: unknown): SettingsValues[string] {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "boolean") return onOff(value);
  if (typeof value === "number" || typeof value === "string") return value;
  return JSON.stringify(value);
}

async function readRepositoryCoding(
  db: Database,
  organizationId: string,
  repositoryId: string,
): Promise<SettingsValues | null> {
  const repository = await getRepository(db, repositoryId, organizationId);
  if (!repository) return null;
  const task = await taskNames(db, organizationId);
  const settings = parseRalphSettings(repository.ralphSettings);
  return {
    coding: switchValue(repository.ralphEnabled),
    query: switchValue(repository.queryEnabled),
    codingPath: CODING_PATH_LABELS[repository.codingPath],
    storyTask: task(repository.storyTaskId),
    requestTask: task(repository.requestTaskId),
    ...Object.fromEntries(
      Object.keys(RALPH_SETTING_LABELS).map((key) => [
        key,
        ralphValue(settings[key as keyof RalphSettings]),
      ]),
    ),
  };
}

export function trackedRepositoryCoding(
  organizationId: string,
  repositoryId: string,
): TrackedSettings {
  return {
    organizationId,
    section: "repository.coding",
    subjectId: repositoryId,
    fields: REPOSITORY_CODING_FIELDS,
    read: (db) => readRepositoryCoding(db, organizationId, repositoryId),
  };
}

// ── repository.agents ───────────────────────────────────────────────────────

export function trackedRepositoryAgents(
  organizationId: string,
  repositoryId: string,
): TrackedSettings {
  return {
    organizationId,
    section: "repository.agents",
    subjectId: repositoryId,
    fields: { agents: { label: "Pinned agents" } },
    read: async (db) =>
      (await getRepository(db, repositoryId, organizationId))
        ? { agents: await listRepositoryPinnedHarnessNames(db, repositoryId) }
        : null,
  };
}

// ── routing_rules ───────────────────────────────────────────────────────────

/** One field per rule position: `Rule 2` → `Team is ENG → mcm/omniralph`. */
function ruleFields(before: SettingsValues | null, after: SettingsValues | null): SettingsFields {
  const count = Math.max(Object.keys(before ?? {}).length, Object.keys(after ?? {}).length);
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`rule.${i + 1}`, { label: `Rule ${i + 1}` }]),
  );
}

/** A rule as the history shows it: its condition in words and the repository it routes to. */
export function describeRoutingRule(query: Parameters<typeof describeQuery>[0], target: string) {
  return `${describeQuery(query, LINEAR_ROUTING_FIELDS)} → ${target}`;
}

async function readRoutingRules(db: Database, organizationId: string): Promise<SettingsValues> {
  const [rules, repositories] = await Promise.all([
    listRoutingRules(db, organizationId),
    listRepositoryOverview(db, organizationId),
  ]);
  const paths = new Map(repositories.map((r) => [r.id, r.fullPath]));
  return Object.fromEntries(
    rules.map((rule, i) => [
      `rule.${i + 1}`,
      describeRoutingRule(rule.query, paths.get(rule.repositoryId) ?? "a removed repo"),
    ]),
  );
}

export function trackedRoutingRules(organizationId: string): TrackedSettings {
  return {
    organizationId,
    section: "routing_rules",
    fields: ruleFields,
    read: (db) => readRoutingRules(db, organizationId),
  };
}

// ── connection ──────────────────────────────────────────────────────────────

/** Compares secrets without keeping them: a digest of the decrypted credentials. */
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A field the values name themselves (`webhook:<repo>|Webhook of acme/web`). */
const LABELED_KEY = /^(.+?)\|(.+)$/;

/**
 * Values may carry fields of their own (per repository, channel, member) as `<key>|<label>`
 * keys; the field map adds them with their label, so a label is shown even when only one side
 * has the field.
 */
function labeledFields(base: SettingsFields) {
  return (before: SettingsValues | null, after: SettingsValues | null): SettingsFields => {
    const fields: SettingsFields = { ...base };
    for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
      const labeled = LABELED_KEY.exec(key);
      if (labeled) fields[key] = { label: labeled[2]! };
    }
    return fields;
  };
}

const CONNECTION_FIELDS: SettingsFields = {
  connected: { label: "Connected" },
  name: { label: "Name" },
  url: { label: "URL" },
  credentials: { label: "Credentials", secret: true },
  repositories: { label: "Reviewed repos" },
  ready: { label: "Ready to start" },
  needsRefining: { label: "Needs refining" },
};

async function readScmConnection(
  db: Database,
  organizationId: string,
  connectionId: string,
): Promise<SettingsValues | null> {
  const connection = await getScmConnection(db, organizationId, connectionId);
  if (!connection) return null;
  let credentials: string;
  try {
    credentials = digest(JSON.stringify(connectionCredentials(connection)));
  } catch {
    credentials = digest(connection.encryptedCredentials);
  }
  const repositories = await listConnectionRepositories(db, connectionId);
  const connected = repositories.filter((r) => !r.disconnectedAt);
  return {
    connected: "On",
    name: connection.name,
    url: connection.baseUrl,
    credentials,
    repositories: connected.filter((r) => r.effective.review).map((r) => r.fullPath),
    ...Object.fromEntries(
      connected
        .filter((r) => r.webhookId)
        .map((r) => [`webhook:${r.id}|Webhook of ${r.fullPath}`, `ID ${r.webhookId}`]),
    ),
  };
}

async function readIntegration(
  db: Database,
  organizationId: string,
  integrationId: string,
): Promise<SettingsValues | null> {
  const integration = await getIntegrationById(db, integrationId);
  if (!integration || integration.organizationId !== organizationId) return null;
  const { ready, needsRefining, teams } = integration.stateMapping;
  return {
    connected: "On",
    name: integration.name,
    credentials: await storedCredentialsDigest(db, integrationId),
    ready: ready.types,
    needsRefining: needsRefining.types,
    ...Object.fromEntries(
      Object.entries(teams).map(([team, states]) => [
        `team:${team}|States of team ${team}`,
        `Ready to start: ${states.ready.join(", ") || "none"}; needs refining: ${states.needsRefining.join(", ") || "none"}`,
      ]),
    ),
  };
}

async function readChatConnection(
  db: Database,
  organizationId: string,
  connectionId: string,
): Promise<SettingsValues | null> {
  const connection = await getChatConnection(db, organizationId, connectionId);
  if (!connection) return null;
  const [channels, task] = await Promise.all([
    listChatChannelTaskSettings(db, organizationId, connectionId),
    taskNames(db, organizationId),
  ]);
  return {
    connected: "On",
    name: connection.name,
    credentials: await storedCredentialsDigest(db, connectionId),
    ...Object.fromEntries(
      channels.map((c) => [
        `channel:${c.channelId}|Tasks of channel ${platformChannelId(c.channelId)}`,
        [
          c.askAboutCodeTaskId && `Ask about code: ${task(c.askAboutCodeTaskId)}`,
          c.startWorkTaskId && `Start work: ${task(c.startWorkTaskId)}`,
        ]
          .filter(Boolean)
          .join("; "),
      ]),
    ),
  };
}

/** A code-host connection, tracker integration or chat connection (their IDs don't collide). */
async function readConnection(
  db: Database,
  organizationId: string,
  connectionId: string,
): Promise<SettingsValues | null> {
  return (
    (await readScmConnection(db, organizationId, connectionId)) ??
    (await readIntegration(db, organizationId, connectionId)) ??
    (await readChatConnection(db, organizationId, connectionId))
  );
}

/** A connection's settings; `connectionId` may name one a connect is about to create. */
export function trackedConnection(organizationId: string, connectionId: string): TrackedSettings {
  return {
    organizationId,
    section: "connection",
    subjectId: connectionId,
    fields: labeledFields(CONNECTION_FIELDS),
    read: (db) => readConnection(db, organizationId, connectionId),
  };
}

/** The tasks chat runs for the whole organization (no single connection: subject none). */
export function trackedChatTaskDefaults(organizationId: string): TrackedSettings {
  return {
    organizationId,
    section: "connection",
    fields: {
      askAboutCode: { label: "Ask about code task" },
      startWork: { label: "Start work task" },
    },
    read: async (db) => {
      const [tasks, task] = await Promise.all([
        getChatTaskDefaults(db, organizationId),
        taskNames(db, organizationId),
      ]);
      return { askAboutCode: task(tasks.askAboutCode), startWork: task(tasks.startWork) };
    },
  };
}

// ── organization ────────────────────────────────────────────────────────────

async function readOrganization(
  db: Database,
  organizationId: string,
): Promise<SettingsValues | null> {
  const organization = await getOrganization(db, organizationId);
  if (!organization) return null;
  const [domains, members, invitations] = await Promise.all([
    listOrganizationDomains(db, organizationId),
    listMembers(db, organizationId),
    listPendingInvitationsForOrganization(db, organizationId),
  ]);
  return {
    name: organization.name,
    allowDomainJoin: onOff(organization.allowDomainJoin),
    domains: [...domains].sort(),
    ...Object.fromEntries(
      members.map((m) => [`member:${m.userId}|Role of ${userDisplayName(m)}`, m.role]),
    ),
    ...Object.fromEntries(
      invitations.map((i) => [
        `invitation:${i.email.toLowerCase()}|Invitation for ${i.email}`,
        i.role,
      ]),
    ),
  };
}

export function trackedOrganization(organizationId: string): TrackedSettings {
  return {
    organizationId,
    section: "organization",
    fields: labeledFields({
      name: { label: "Name" },
      allowDomainJoin: { label: "Anyone with a matching email can join" },
      domains: { label: "Email domains" },
    }),
    read: (db) => readOrganization(db, organizationId),
  };
}

// ── agent_defaults ──────────────────────────────────────────────────────────

const TASK_TYPE_LABELS = {
  query: "Ask about code",
  review: "Reviews",
  coding: "Coding",
} as const satisfies Record<TaskType, string>;

export function trackedAgentDefaults(organizationId: string): TrackedSettings {
  return {
    organizationId,
    section: "agent_defaults",
    fields: {
      allowedTaskTypes: { label: "Task types" },
      maxConcurrency: { label: "Max concurrency" },
      desiredVersion: { label: "Agent version" },
    },
    read: async (db) => {
      const [allowed, maxConcurrency, version] = await Promise.all([
        getAllowedTaskTypeDefaults(db, organizationId),
        getDefaultMaxConcurrency(db, organizationId),
        getAppSetting(db, organizationId, DESIRED_HARNESS_VERSION_KEY),
      ]);
      return {
        allowedTaskTypes: allowed.map((t) => TASK_TYPE_LABELS[t as TaskType] ?? t),
        maxConcurrency,
        desiredVersion: typeof version?.value === "string" ? version.value : null,
      };
    },
  };
}

// ── Runs since ──────────────────────────────────────────────────────────────

/** Which runs count as "since" a change of each section (of the section's subject). */
export function runsSinceScope(section: SettingsSection, subjectId: string | null): RunsSinceScope {
  switch (section) {
    case "repository.reviews":
      return { kinds: ["review"], repositoryId: subjectId ?? undefined };
    case "repository.coding":
      return { kinds: ["epic", "request"], repositoryId: subjectId ?? undefined };
    case "repository.agents":
      return { repositoryId: subjectId ?? undefined };
    case "routing_rules":
      return { kinds: ["epic", "request", "triage"] };
    case "connection":
      // The organization's chat task choices: the runs chat starts.
      return subjectId ? { connectionId: subjectId } : { origins: ["chat"] };
    case "organization":
    case "agent_defaults":
      return {};
  }
}

/**
 * Runs a connect (a new connection, or one connected again) and records it in the connection's
 * history, in the save's transaction: the connection's ID is only known once `save` returns
 * (`connectionId`; null when nothing was connected). `existingId` is the connection the
 * connect may update.
 */
export async function connectingWithHistory<T>(
  db: Database,
  actor: SettingsActor,
  organizationId: string,
  existingId: string | null,
  save: (tx: Database) => Promise<T>,
  connectionId: (result: T) => string | null,
): Promise<T> {
  return db.transaction(async (transaction) => {
    const tx = transaction as unknown as Database;
    const before = existingId ? await readConnection(tx, organizationId, existingId) : null;
    const result = await save(tx);
    const id = connectionId(result);
    if (!id) return result;
    const after = await readConnection(tx, organizationId, id);
    const previous = id === existingId ? before : null;
    await recordSettingsChange(tx, {
      organizationId,
      section: "connection",
      subjectId: id,
      actor,
      fields: labeledFields(CONNECTION_FIELDS)(previous, after),
      before: previous,
      after,
    });
    return result;
  });
}
