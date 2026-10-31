import "server-only";
/**
 * Fleet's responses: the agents of the organizations in scope with their summary
 * (`GET /api/ui/agents`), and one agent's detail (`GET /api/ui/agents/{id}`).
 */
import {
  getAgentOverview,
  getAgentSecuritySummary,
  getRunIndexEntries,
  listAgentAttempts,
  listAgentInstallJobs,
  listAgentOverview,
  listRecentAgentAudit,
  listAgentPinSyncJobs,
  listRequiredHostTools,
  loadRunListEntries,
  missingHostToolNames,
  type AgentAttempt,
  type AgentOverview,
  type Database,
} from "@omniralph/db";
import { TASK_TYPES } from "@omniralph/tasks";
import type {
  AgentDetail,
  AgentInstall,
  AgentList,
  FleetAgentRow,
  FleetSummary,
  RecentAttempt,
  RunningAttempt,
} from "@/lib/api/agents";
import type { RunRow } from "@/lib/api/runs";
import type { ScopedOrganization } from "@/lib/api/scope";
import {
  organizationAgentVersion,
  type OrganizationAgentVersion,
} from "@/lib/agents/desired-version";
import { agentRow } from "@/lib/agents/rows";
import { describeAttempt, type AttemptLabelContext } from "@omniralph/shared";
import { attemptLabelBase } from "@/lib/runs/detail";
import { runRow } from "@/lib/runs/list";
import { loadSettingsHistory } from "@/lib/settings-history/history";
import { versionCounts, type VersionPolicy } from "./status";

/** npm's `latest` is read at most every 5 minutes (cached); never let it hold up a read for long. */
const NPM_TIMEOUT_MS = 2_000;
/** Audit events the detail shows. */
const AUDIT_LIMIT = 50;
/** Finished attempts Recent work shows. */
const RECENT_WORK_LIMIT = 10;
/** The Security line's window. */
const SECURITY_WINDOW_MS = 30 * 24 * 3600_000;
/** How far back pinned repositories' sync jobs are shown. */
const PIN_SYNC_WINDOW_MS = 7 * 24 * 3600_000;
/** How far back Packages shows installs. */
const INSTALLS_WINDOW_MS = 24 * 3600_000;

function versionPolicy(version: OrganizationAgentVersion): VersionPolicy {
  if (version.tracksLatest) return { mode: "latest", version: null, target: version.version };
  if (version.version === null) return { mode: "unset", version: null, target: null };
  return { mode: "pinned", version: version.version, target: version.version };
}

function fleetRow(
  agent: AgentOverview,
  now: Date,
  version: OrganizationAgentVersion,
  organization: ScopedOrganization,
): FleetAgentRow {
  return {
    ...agentRow(agent, now, version.version, version.tracksLatest),
    organization: { id: organization.id, name: organization.name, role: organization.role },
  };
}

/** Fleet's summary cells over the rows' non-revoked agents; `policies`: one per organization. */
export function fleetSummary(
  rows: readonly FleetAgentRow[],
  policies: readonly VersionPolicy[],
): FleetSummary {
  const active = rows.filter((row) => !row.revoked);
  const online = active.filter((row) => row.online);
  const [first] = policies;
  const same =
    first !== undefined &&
    policies.every(
      (p) => p.mode === first.mode && p.version === first.version && p.target === first.target,
    );
  return {
    total: active.length,
    online: online.length,
    offline: active.length - online.length,
    busy: active.filter((row) => row.runningCount > 0).length,
    versionPolicy: same ? first : null,
    versions: versionCounts(active),
    acceptedKinds: {
      limited: active.filter((row) => row.acceptedTaskTypes.length < TASK_TYPES.length).length,
      total: active.length,
    },
  };
}

/**
 * The agents of `organizations` (each organization's active agents first, then revoked;
 * by name), organizations in the order given, with Fleet's summary.
 */
export async function loadFleet(
  db: Database,
  organizations: readonly ScopedOrganization[],
): Promise<AgentList> {
  const now = new Date();
  const perOrganization = await Promise.all(
    organizations.map(async (organization) => {
      const [agents, version] = await Promise.all([
        listAgentOverview(db, organization.id),
        organizationAgentVersion(db, organization.id, { timeoutMs: NPM_TIMEOUT_MS }),
      ]);
      return {
        rows: agents.map((agent) => fleetRow(agent, now, version, organization)),
        policy: versionPolicy(version),
      };
    }),
  );
  const rows = perOrganization.flatMap((o) => o.rows);
  // The Version policy cell's ⓘ: one organization's history only.
  const versionHistory =
    organizations.length === 1
      ? (await loadSettingsHistory(db, organizations, { section: "agent_defaults", limit: 1 }))
          .latest
      : null;
  return {
    agents: rows,
    summary: fleetSummary(
      rows,
      perOrganization.map((o) => o.policy),
    ),
    versionHistory,
  };
}

function present(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

const durationMs = (attempt: AgentAttempt) =>
  attempt.startedAt && attempt.finishedAt
    ? Math.max(0, attempt.finishedAt.getTime() - attempt.startedAt.getTime())
    : null;

/** One agent of `organization` with what its detail shows; null when it isn't there. */
export async function loadAgentDetail(
  db: Database,
  agentId: string,
  organization: ScopedOrganization,
): Promise<AgentDetail | null> {
  const now = new Date();
  const [agent, version, attempts, security, audit, pinSyncJobs, installJobs, requiredHostTools] =
    await Promise.all([
      getAgentOverview(db, organization.id, agentId),
      organizationAgentVersion(db, organization.id, { timeoutMs: NPM_TIMEOUT_MS }),
      listAgentAttempts(db, agentId, RECENT_WORK_LIMIT),
      getAgentSecuritySummary(db, agentId, new Date(now.getTime() - SECURITY_WINDOW_MS)),
      listRecentAgentAudit(db, agentId, AUDIT_LIMIT),
      listAgentPinSyncJobs(
        db,
        organization.id,
        agentId,
        new Date(now.getTime() - PIN_SYNC_WINDOW_MS),
      ),
      listAgentInstallJobs(
        db,
        organization.id,
        agentId,
        new Date(now.getTime() - INSTALLS_WINDOW_MS),
      ),
      listRequiredHostTools(db, organization.id),
    ]);
  if (!agent) return null;

  const runIds = [
    ...new Set([...attempts.running, ...attempts.recent].flatMap((a) => a.runId ?? [])),
  ];
  const entries = await loadRunListEntries(db, await getRunIndexEntries(db, runIds));
  const runs = new Map<string, RunRow>(
    entries
      .filter((entry) => entry.organizationId === organization.id)
      .map((entry) => [entry.id, runRow(entry, organization)]),
  );
  const runOf = (attempt: AgentAttempt) => (attempt.runId && runs.get(attempt.runId)) || null;
  const label = (attempt: AgentAttempt) => {
    const run = runOf(attempt);
    const base: AttemptLabelContext = run ? attemptLabelBase(run) : {};
    return describeAttempt({
      type: attempt.type,
      status: attempt.status,
      context: {
        ...base,
        repository: base.repository ?? attempt.repository?.fullPath ?? null,
        provider: base.provider ?? attempt.repository?.provider ?? null,
        story: attempt.story?.identifier ?? null,
        packageName: present(attempt.payload.name),
      },
    });
  };
  const runRef = (run: RunRow | null) => run && { id: run.id, kind: run.kind, title: run.title };

  const runningNow: RunningAttempt[] = attempts.running.map((attempt) => {
    const run = runOf(attempt);
    const repository = run?.repository ?? attempt.repository;
    return {
      id: attempt.id,
      type: attempt.type,
      label: label(attempt),
      run: runRef(run),
      repository: repository && {
        id: repository.id,
        provider: repository.provider,
        fullPath: repository.fullPath,
      },
      workItem: run?.workItem ?? null,
      step: attempt.story ? `Story ${attempt.story.number} of ${attempt.story.total}` : null,
      startedAt: attempt.startedAt?.toISOString() ?? null,
    };
  });
  const recentWork: RecentAttempt[] = attempts.recent.map((attempt) => ({
    id: attempt.id,
    type: attempt.type,
    label: label(attempt),
    status: attempt.status,
    durationMs: durationMs(attempt),
    finishedAt: attempt.finishedAt!.toISOString(),
    run: runRef(runOf(attempt)),
  }));

  const row = fleetRow(agent, now, version, organization);
  return {
    agent: row,
    models: agent.reportedModels,
    installables: agent.reportedInstallables,
    installs: installJobs.flatMap((job): AgentInstall[] => {
      const installing = job.status === "queued" || job.status === "running";
      if (!installing && job.status !== "failed") return [];
      return [
        {
          id: job.id,
          name: job.name,
          state: installing ? "installing" : "failed",
          error: installing ? null : job.error,
          createdAt: job.createdAt.toISOString(),
        },
      ];
    }),
    runningNow,
    recentWork,
    security: {
      lastTokenRefreshAt: security.lastTokenRefreshAt?.toISOString() ?? null,
      reuseAlerts30d: security.reuseAlerts,
      lastReuseAt: security.lastReuseAt?.toISOString() ?? null,
      authFailures30d: security.authFailures,
    },
    globalDesiredVersion: version.tracksLatest
      ? version.version
        ? `${version.version} (latest on npm)`
        : "the latest on npm"
      : version.version,
    local: {
      poolLimits: agent.reportedPoolLimits
        ? { short: agent.reportedPoolLimits.short, long: agent.reportedPoolLimits.long }
        : null,
      versionPin: agent.reportedVersionPin,
      installablesAllow: agent.reportedInstallablesAllow,
    },
    hostTools: agent.reportedHostTools.map(({ name, path, source, problem }) => ({
      name,
      path,
      source,
      problem,
    })),
    missingRequiredHostTools: missingHostToolNames(agent.reportedHostTools, requiredHostTools),
    claude: agent.reportedClaude
      ? { status: agent.reportedClaude.status, source: agent.reportedClaude.source }
      : null,
    audit: audit.map((entry) => ({
      id: entry.id,
      event: entry.event,
      ip: entry.ip,
      detail: entry.detail,
      actor: entry.actorName,
      createdAt: entry.createdAt.toISOString(),
    })),
    pinSyncJobs: pinSyncJobs.map((job) => ({
      ...job,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
    })),
  };
}
