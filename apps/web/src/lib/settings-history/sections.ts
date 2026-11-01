import "server-only";
import { createHash } from "node:crypto";
import {
  connectionCredentials,
  DESIRED_AGENT_VERSION_KEY,
  getAppSetting,
  getChatConnection,
  getChatPlaybookDefaults,
  getIntegrationById,
  getRepository,
  getTrackerLabels,
  getWorkItemMatch,
  getScmConnection,
  listChatChannelPlaybookSettings,
  listConnectionRepositories,
  listMembers,
  listOrganizationDomains,
  listPendingInvitationsForOrganization,
  listRepositoryOverview,
  listRepositoryPinnedAgentNames,
  listRoutingRules,
  getOrganization,
  recordSettingsChange,
  storedCredentialsDigest,
  type Database,
  type Repository,
  type RunsSinceScope,
  type SettingsActor,
  type SettingsFields,
  type SettingsValues,
  type TrackedSettings,
} from "@omniralph/db";
import { REVIEW_DEPTHS } from "@omniralph/shared";
import type { OrgUser } from "@/lib/auth/session";
import { platformChannelId } from "@/lib/chat/playbooks";
import { listPlaybooks } from "@/lib/playbooks";
import type { SettingsSection } from "@/lib/live/events";
import { ROUTING_FIELDS } from "@/lib/routing/fields";
import { describeQuery } from "@/lib/routing/describe";
import { matchSentence } from "@/lib/routing/match";
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

const onOff = (value: boolean) => (value ? "On" : "Off");

/** Playbook names by ID (built-in and the organization's own); unknown IDs read as themselves. */
async function taskNames(db: Database, organizationId: string) {
  const playbooks = await listPlaybooks(db, organizationId);
  const names = new Map(playbooks.map(({ playbook }) => [playbook.id, playbook.name]));
  return (id: string) => names.get(id) ?? id;
}

// ── repository.reviews ──────────────────────────────────────────────────────

/** The Reviews card's fields, labeled as the card shows them (PR or MR by provider). */
function repositoryReviewsFields(provider: Repository["provider"]): SettingsFields {
  return {
    reviews: { label: "Reviews" },
    onOpen: { label: provider === "gitlab" ? "MR opened" : "PR opened" },
    onPush: { label: "New commits pushed" },
    drafts: { label: "Drafts too" },
    depth: { label: "Depth" },
    pathExcludes: { label: "Skip paths" },
    reviewerInstructions: { label: "Reviewer instructions" },
  };
}

async function readRepositoryReviews(
  db: Database,
  organizationId: string,
  repositoryId: string,
): Promise<SettingsValues | null> {
  const repository = await getRepository(db, repositoryId, organizationId);
  if (!repository) return null;
  return {
    reviews: onOff(repository.reviewsEnabled),
    onOpen: onOff(repository.triggers.onOpen),
    onPush: onOff(repository.triggers.onPush),
    drafts: onOff(repository.triggers.drafts),
    depth: REVIEW_DEPTHS[repository.reviewDepth].label,
    pathExcludes: repository.pathExcludes,
    reviewerInstructions: repository.customInstructions,
  };
}

/** The repository's Reviews card (`repository.reviews`). */
export function trackedRepositoryReviews(
  repository: Pick<Repository, "id" | "organizationId" | "provider">,
): TrackedSettings {
  return {
    organizationId: repository.organizationId,
    section: "repository.reviews",
    subjectId: repository.id,
    fields: repositoryReviewsFields(repository.provider),
    read: (db) => readRepositoryReviews(db, repository.organizationId, repository.id),
  };
}

// ── repository.coding ───────────────────────────────────────────────────────

const HISTORY_REWRITE_LABELS: Record<Repository["historyRewrite"], string> = {
  "when-asked": "When asked",
  always: "Always",
  never: "Never",
};

/** The Coding card's fields, labeled as the card shows them (PR or MR by provider). */
function repositoryCodingFields(provider: Repository["provider"]): SettingsFields {
  return {
    coding: { label: "Coding" },
    workItemMatch: { label: "Work item match" },
    codingInstructions: { label: "Extra instructions" },
    openPullRequestEarly: {
      label: `Open a draft ${provider === "gitlab" ? "merge" : "pull"} request after the first story`,
    },
    respondToReviewsAndCi: { label: "Fix review comments and CI failures" },
    historyRewrite: { label: "Rewrite history" },
  };
}

async function readRepositoryCoding(
  db: Database,
  organizationId: string,
  repositoryId: string,
): Promise<SettingsValues | null> {
  const repository = await getRepository(db, repositoryId, organizationId);
  if (!repository) return null;
  const match = await getWorkItemMatch(db, organizationId, repositoryId);
  return {
    coding: onOff(repository.codingEnabled),
    workItemMatch: match ? matchSentence(match) : null,
    codingInstructions: repository.codingInstructions,
    openPullRequestEarly: onOff(repository.openPullRequestEarly),
    respondToReviewsAndCi: onOff(repository.respondToReviewsAndCi),
    historyRewrite: HISTORY_REWRITE_LABELS[repository.historyRewrite],
  };
}

/** The repository's Coding card (`repository.coding`): its switch, work item match and policy. */
export function trackedRepositoryCoding(
  repository: Pick<Repository, "id" | "organizationId" | "provider">,
): TrackedSettings {
  return {
    organizationId: repository.organizationId,
    section: "repository.coding",
    subjectId: repository.id,
    fields: repositoryCodingFields(repository.provider),
    read: (db) => readRepositoryCoding(db, repository.organizationId, repository.id),
  };
}

// ── repository.ask ──────────────────────────────────────────────────────────

/** The repository's Ask card (`repository.ask`). */
export function trackedRepositoryAsk(
  organizationId: string,
  repositoryId: string,
): TrackedSettings {
  return {
    organizationId,
    section: "repository.ask",
    subjectId: repositoryId,
    fields: { ask: { label: "Ask" } },
    read: async (db) => {
      const repository = await getRepository(db, repositoryId, organizationId);
      return repository ? { ask: onOff(repository.askEnabled) } : null;
    },
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
        ? { agents: await listRepositoryPinnedAgentNames(db, repositoryId) }
        : null,
  };
}

// ── repository.playbooks ────────────────────────────────────────────────────

/** The Playbooks card's bindings, labeled as its selects. */
const REPOSITORY_PLAYBOOKS_FIELDS: SettingsFields = {
  review: { label: "Review playbook" },
  correlation: { label: "Combine review findings playbook" },
  story: { label: "Stories playbook" },
  request: { label: "Requests playbook" },
};

async function readRepositoryPlaybooks(
  db: Database,
  organizationId: string,
  repositoryId: string,
): Promise<SettingsValues | null> {
  const repository = await getRepository(db, repositoryId, organizationId);
  if (!repository) return null;
  const task = await taskNames(db, organizationId);
  return {
    review: repository.reviewPlaybookIds.map(task),
    correlation: task(repository.correlationPlaybookId),
    story: task(repository.storyPlaybookId),
    request: task(repository.requestPlaybookId),
  };
}

/** The repository's Playbooks card (`repository.playbooks`). */
export function trackedRepositoryPlaybooks(
  organizationId: string,
  repositoryId: string,
): TrackedSettings {
  return {
    organizationId,
    section: "repository.playbooks",
    subjectId: repositoryId,
    fields: REPOSITORY_PLAYBOOKS_FIELDS,
    read: (db) => readRepositoryPlaybooks(db, organizationId, repositoryId),
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
  return `${describeQuery(query, ROUTING_FIELDS)} → ${target}`;
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

/**
 * The organization's manual and blocked tracker labels: routing applies them before any
 * playbook is chosen, so their history is the routing section's (no subject).
 */
export function trackedTrackerLabels(organizationId: string): TrackedSettings {
  return {
    organizationId,
    section: "routing_rules",
    fields: {
      manualLabels: { label: "Manual labels" },
      blockedLabels: { label: "Blocked labels" },
    },
    read: async (db) => ({ ...(await getTrackerLabels(db, organizationId)) }),
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
    repositories: connected.filter((r) => r.reviewsEnabled).map((r) => r.fullPath),
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
    listChatChannelPlaybookSettings(db, organizationId, connectionId),
    taskNames(db, organizationId),
  ]);
  return {
    connected: "On",
    name: connection.name,
    credentials: await storedCredentialsDigest(db, connectionId),
    ...Object.fromEntries(
      channels.map((c) => [
        `channel:${c.channelId}|Playbooks of channel ${platformChannelId(c.channelId)}`,
        [
          c.askPlaybookId && `Ask about code: ${task(c.askPlaybookId)}`,
          c.startWorkPlaybookId && `Start work: ${task(c.startWorkPlaybookId)}`,
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

/** The playbooks chat runs for the whole organization (no single connection: subject none). */
export function trackedChatPlaybookDefaults(organizationId: string): TrackedSettings {
  return {
    organizationId,
    section: "connection",
    fields: {
      ask: { label: "Ask about code playbook" },
      startWork: { label: "Start work playbook" },
    },
    read: async (db) => {
      const [playbooks, name] = await Promise.all([
        getChatPlaybookDefaults(db, organizationId),
        taskNames(db, organizationId),
      ]);
      return { ask: name(playbooks.ask), startWork: name(playbooks.startWork) };
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

export function trackedAgentDefaults(organizationId: string): TrackedSettings {
  return {
    organizationId,
    section: "agent_defaults",
    fields: {
      desiredVersion: { label: "Agent version" },
    },
    read: async (db) => {
      const version = await getAppSetting(db, organizationId, DESIRED_AGENT_VERSION_KEY);
      return { desiredVersion: typeof version?.value === "string" ? version.value : null };
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
    case "repository.ask":
      return { kinds: ["ask"], repositoryId: subjectId ?? undefined };
    case "repository.agents":
    case "repository.playbooks":
      return { repositoryId: subjectId ?? undefined };
    case "routing_rules":
      return { kinds: ["epic", "request", "triage"] };
    case "connection":
      // The organization's chat playbook choices: the runs chat starts.
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
