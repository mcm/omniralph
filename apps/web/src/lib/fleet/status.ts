/**
 * Fleet's display rules, pure so the API and the screens share them: an agent's status
 * (text and tone), the version and accepted-kinds summaries, and how pins collapse into
 * badges. Online and offline always come from the server's `live_online` flag (`online`),
 * never from a client clock.
 */

/** Fleet's tones (Design rule 15): mint for running, coral for trouble, neutral otherwise. */
export type FleetTone = "run" | "fail" | "neutral";

export const AGENT_STATUS_KINDS = [
  "revoked",
  "offline",
  "never_connected",
  "update_failed",
  "running",
  "updating",
  "idle",
] as const;
export type AgentStatusKind = (typeof AGENT_STATUS_KINDS)[number];

export interface AgentStatus {
  kind: AgentStatusKind;
  /** "Offline 3d", "Running 2", … */
  label: string;
  tone: FleetTone;
}

export interface AgentStatusInput {
  revoked: boolean;
  /** `agents.live_online`. */
  online: boolean;
  lastHeartbeatAt: Date | string | null;
  /** `AgentUpdateStatus` (`lib/agents/update.ts`). */
  updateStatus: "up_to_date" | "updating" | "failed" | "manual";
  /** Attempts running on the agent. */
  runningCount: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "4m", "5h", "3d": how long ago, at least a minute. */
export function compactSince(from: Date, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - from.getTime());
  if (elapsed < HOUR_MS) return `${Math.max(1, Math.floor(elapsed / MINUTE_MS))}m`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
  return `${Math.floor(elapsed / DAY_MS)}d`;
}

/**
 * An agent's status; the first match wins: Revoked, Offline (with the time since its last
 * heartbeat), Never connected, Update failed, Running N, Updating, Idle.
 */
export function agentStatus(agent: AgentStatusInput, now: Date = new Date()): AgentStatus {
  if (agent.revoked) return { kind: "revoked", label: "Revoked", tone: "neutral" };
  const lastHeartbeatAt = agent.lastHeartbeatAt === null ? null : new Date(agent.lastHeartbeatAt);
  if (!agent.online && lastHeartbeatAt) {
    return {
      kind: "offline",
      label: `Offline ${compactSince(lastHeartbeatAt, now)}`,
      tone: "fail",
    };
  }
  if (!lastHeartbeatAt) {
    return { kind: "never_connected", label: "Never connected", tone: "neutral" };
  }
  if (agent.updateStatus === "failed") {
    return { kind: "update_failed", label: "Update failed", tone: "fail" };
  }
  if (agent.runningCount > 0) {
    return { kind: "running", label: `Running ${agent.runningCount}`, tone: "run" };
  }
  if (agent.updateStatus === "updating") {
    return { kind: "updating", label: "Updating", tone: "neutral" };
  }
  return { kind: "idle", label: "Idle", tone: "neutral" };
}

/**
 * The version agents should run: npm's latest (`target` its last known version), a pin, or
 * none chosen yet (`unset`: agents stay on what they run).
 */
export interface VersionPolicy {
  mode: "latest" | "pinned" | "unset";
  /** The pinned version; null otherwise. */
  version: string | null;
  /** The version agents should be on now; null when unknown (npm never read, nothing pinned). */
  target: string | null;
}

/** How the online agents stand against the policy's target (`updateFailed`: any non-revoked agent). */
export interface VersionCounts {
  onTarget: number;
  behind: number;
  updateFailed: number;
}

/** "Track latest", "Pinned to 2.0.3", or "Varies by organization" (null under all organizations). */
export function versionPolicyLabel(policy: VersionPolicy | null): string {
  if (!policy) return "Varies by organization";
  if (policy.mode === "latest") return "Track latest";
  return policy.mode === "pinned" ? `Pinned to ${policy.version}` : "No version set";
}

export type VersionSummary =
  | { kind: "on_target"; label: string; version: string | null; tone: "neutral" }
  | { kind: "behind"; label: string; tone: "neutral" }
  | { kind: "update_failed"; label: string; tone: "fail" };

const agents = (n: number) => (n === 1 ? "1 agent" : `${n} agents`);

/**
 * The Version policy cell's detail: a failed update first ("1 update failed", coral), then
 * agents behind ("2 agents behind"), else "All agents on" the target version.
 */
export function versionSummary(
  policy: VersionPolicy | null,
  counts: VersionCounts,
): VersionSummary {
  if (counts.updateFailed > 0) {
    const label =
      counts.updateFailed === 1 ? "1 update failed" : `${counts.updateFailed} updates failed`;
    return { kind: "update_failed", label, tone: "fail" };
  }
  if (counts.behind > 0) {
    return { kind: "behind", label: `${agents(counts.behind)} behind`, tone: "neutral" };
  }
  return {
    kind: "on_target",
    label: "All agents on",
    version: policy?.target ?? null,
    tone: "neutral",
  };
}

/** Of the non-revoked agents, how many limit the kinds of work they accept. */
export interface AcceptedKindsCounts {
  limited: number;
  total: number;
}

/** "Accept all kinds", or "2 of 7 agents limit kinds". */
export function acceptedKindsSummary(counts: AcceptedKindsCounts): string {
  if (counts.limited === 0) return "Accept all kinds";
  const verb = counts.limited === 1 ? "limits" : "limit";
  return counts.total === 1
    ? "1 agent limits kinds"
    : `${counts.limited} of ${counts.total} agents ${verb} kinds`;
}

/** The pinned repos a row shows: one or two badges, or the first and a "+N" badge. */
export function pinBadges<T>(pins: readonly T[]): { shown: T[]; more: number } {
  if (pins.length <= 2) return { shown: [...pins], more: 0 };
  return { shown: pins.slice(0, 1), more: pins.length - 1 };
}

/** "Oct 20": a month and day, as the agent detail dates things. */
export function shortDate(value: Date | string): string {
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "just now", "2 minutes ago", "3 hours ago", "4 days ago". */
export function relativeAgo(from: Date | string, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - new Date(from).getTime());
  const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (elapsed < MINUTE_MS) return "just now";
  if (elapsed < HOUR_MS) return count(Math.floor(elapsed / MINUTE_MS), "minute");
  if (elapsed < DAY_MS) return count(Math.floor(elapsed / HOUR_MS), "hour");
  return count(Math.floor(elapsed / DAY_MS), "day");
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * How far `version` is behind `target`: "1 version behind" when both are plain versions of
 * one minor line (counted in patches), else "behind 2.1.0".
 */
export function versionsBehind(version: string | null, target: string): string {
  const from = version ? SEMVER.exec(version) : null;
  const to = SEMVER.exec(target);
  if (from && to && from[1] === to[1] && from[2] === to[2] && Number(to[3]) > Number(from[3])) {
    const n = Number(to[3]) - Number(from[3]);
    return n === 1 ? "1 version behind" : `${n} versions behind`;
  }
  return `behind ${target}`;
}

export interface AgentStatusLineInput extends AgentStatusInput {
  status: AgentStatus;
  version: string | null;
  /** The version it should run; null when none is chosen. */
  desiredVersion: string | null;
  revokedAt: Date | string | null;
}

/**
 * The agent detail's status line: "Running · up to date", "Offline 3d · 1 version behind",
 * "Update failed: 2.0.4", "Revoked Oct 20", "Never connected", "Updating to 2.0.4".
 */
export function agentStatusLine(agent: AgentStatusLineInput): { label: string; tone: FleetTone } {
  const { status } = agent;
  if (status.kind === "revoked") {
    return {
      label: agent.revokedAt ? `Revoked ${shortDate(agent.revokedAt)}` : "Revoked",
      tone: "neutral",
    };
  }
  if (status.kind === "never_connected") return { label: status.label, tone: status.tone };
  if (status.kind === "update_failed") {
    const failed = agent.desiredVersion ? `: ${agent.desiredVersion}` : "";
    return { label: `Update failed${failed}`, tone: "fail" };
  }
  if (status.kind === "updating") {
    return {
      label: agent.desiredVersion ? `Updating to ${agent.desiredVersion}` : "Updating",
      tone: "neutral",
    };
  }
  const head = status.kind === "running" ? "Running" : status.label;
  const versionPart =
    agent.updateStatus === "failed"
      ? "update failed"
      : agent.desiredVersion === null || agent.version === agent.desiredVersion
        ? "up to date"
        : versionsBehind(agent.version, agent.desiredVersion);
  return { label: `${head} · ${versionPart}`, tone: status.tone };
}

export interface SecurityInput {
  lastTokenRefreshAt: Date | string | null;
  reuseAlerts30d: number;
  lastReuseAt: Date | string | null;
  /** Whether the agent has ever heartbeated. */
  connected: boolean;
}

/**
 * The agent detail's Security line: "Token reuse detected Oct 20" (fail) when a refresh token
 * was reused in the last 30 days, else "Token refreshed 2 minutes ago · no reuse alerts", or
 * "Never connected" before its first heartbeat.
 */
export function securityLine(
  security: SecurityInput,
  now: Date = new Date(),
): { label: string; tone: FleetTone } {
  if (security.reuseAlerts30d > 0) {
    return {
      label: security.lastReuseAt
        ? `Token reuse detected ${shortDate(security.lastReuseAt)}`
        : "Token reuse detected",
      tone: "fail",
    };
  }
  if (!security.connected) return { label: "Never connected", tone: "neutral" };
  if (!security.lastTokenRefreshAt) {
    return { label: "Token not refreshed yet · no reuse alerts", tone: "neutral" };
  }
  return {
    label: `Token refreshed ${relativeAgo(security.lastTokenRefreshAt, now)} · no reuse alerts`,
    tone: "neutral",
  };
}
