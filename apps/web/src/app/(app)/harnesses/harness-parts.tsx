"use client";

import { Badge, Cluster, Muted } from "@iamthemcmaster/ui";
import { IconExternalLink } from "@tabler/icons-react";
import { isAgentOnline } from "@/lib/agents/display";
import type { AgentRow } from "@/lib/agents/rows";
import { UPDATE_STATUS_LABELS } from "@/lib/agents/update";
import {
  AGENT_CONNECTION_VARIANTS,
  AGENT_UPDATE_STATUS_VARIANTS,
  agentConnectionState,
} from "@/lib/state-variants";
import { ProviderIcon } from "@/components/provider-icon";
import { MonoValue } from "@/components/mono-value";
import { stateLabel } from "@/lib/state-variants";

/** `harness` with `online` computed against the browser's clock `now`, not the server's. */
export function withClientOnline(harness: AgentRow, now: number): AgentRow {
  const heartbeat = harness.lastHeartbeatAt ? new Date(harness.lastHeartbeatAt) : null;
  return { ...harness, online: !harness.revoked && isAgentOnline(heartbeat, new Date(now)) };
}

const HARNESS_CONNECTION_LABELS = { online: "Online", offline: "Offline", revoked: "Revoked" };

export function HarnessStatusBadge({ harness }: { harness: Pick<AgentRow, "online" | "revoked"> }) {
  const state = agentConnectionState(harness);
  return (
    <Badge variant={AGENT_CONNECTION_VARIANTS[state]} dot live={state === "online"}>
      {HARNESS_CONNECTION_LABELS[state]}
    </Badge>
  );
}

/** The task types a harness accepts (it always runs `system` jobs too). */
export function TaskTypeBadges({ accepted }: { accepted: string[] }) {
  if (accepted.length === 0) return <Muted>None</Muted>;
  return (
    <div className="harness-badge-row">
      {accepted.map((taskType) => (
        <Badge key={taskType} variant="neutral">
          {stateLabel(taskType)}
        </Badge>
      ))}
    </div>
  );
}

/** Effective pool limits, e.g. `short: 2, long: 1`. */
export function formatPoolLimits(limits: Record<string, number>): string {
  return Object.entries(limits)
    .map(([pool, limit]) => `${pool}: ${limit}`)
    .join(", ");
}

export function JobTargetLink({ job }: { job: AgentRow["runningJobs"][number] }) {
  const label = job.target?.label ?? job.id.slice(0, 8);
  const text = (
    <>
      <MonoValue value={job.type} truncate="end" className="shrink-0 text-text-tertiary" />
      <MonoValue value={label} />
    </>
  );
  const className = "list-secondary harness-job-link";
  return job.target?.url ? (
    <a href={job.target.url} target="_blank" rel="noreferrer" className={className}>
      {text}
      <IconExternalLink size={12} />
    </a>
  ) : (
    <span className={className}>{text}</span>
  );
}

export function RepositoryBadges({
  repositories,
}: {
  repositories: AgentRow["pinnedRepositories"];
}) {
  if (repositories.length === 0) return <Muted>None</Muted>;
  return (
    <Cluster gap={1}>
      {repositories.map((repo) => (
        <Badge key={repo.id} variant="neutral" className="harness-repo-badge">
          <ProviderIcon provider={repo.provider} size={12} />
          <MonoValue value={repo.fullPath} />
        </Badge>
      ))}
    </Cluster>
  );
}

const UPDATE_STATE_LABELS: Record<NonNullable<AgentRow["update"]>["state"], string | null> = {
  idle: null,
  draining: "waiting for running jobs",
  installing: "installing",
  confirming: "confirming",
};

/** Up to date / Updating (with the step) / Failed / Update manually. */
export function UpdateStatusBadge({
  harness,
}: {
  harness: Pick<
    AgentRow,
    "updateStatus" | "update" | "updateRequest" | "desiredVersion" | "selfUpdate"
  >;
}) {
  const step =
    (harness.update && UPDATE_STATE_LABELS[harness.update.state]) ??
    (harness.updateRequest && `${harness.updateRequest.version} requested`);
  const title =
    harness.updateStatus === "manual"
      ? harness.selfUpdate === null
        ? "This harness version can't update itself; install the desired version on the host."
        : "Not running under pm2, so it can't update itself; install the desired version on the host."
      : harness.updateStatus === "failed"
        ? `${harness.desiredVersion} failed on this harness, so it won't try it again unless you use Update now on its page.`
        : undefined;
  return (
    <Badge
      variant={AGENT_UPDATE_STATUS_VARIANTS[harness.updateStatus]}
      dot
      live={harness.updateStatus === "updating"}
      title={title}
    >
      {UPDATE_STATUS_LABELS[harness.updateStatus]}
      {harness.updateStatus === "updating" && step && ` (${step})`}
    </Badge>
  );
}

/** The reported version, and the desired one when it differs. */
export function AgentVersion({ harness }: { harness: AgentRow }) {
  const target = harness.updateRequest?.version ?? harness.desiredVersion;
  return harness.version ? (
    <span className="list-text text-numeric list-nowrap">
      {harness.version}
      {target && target !== harness.version && (
        <span className="text-text-tertiary"> → {target}</span>
      )}
    </span>
  ) : (
    <Muted>Unknown</Muted>
  );
}
