"use client";

import { Badge, Muted } from "@iamthemcmaster/ui";
import { IconExternalLink } from "@tabler/icons-react";
import type { AgentRow } from "@/lib/agents/rows";
import { ProviderIcon } from "../repositories/repositories-view";

export function AgentStatusBadge({ agent }: { agent: Pick<AgentRow, "online" | "revoked"> }) {
  if (agent.revoked) return <Badge variant="danger">Revoked</Badge>;
  return agent.online ? (
    <Badge variant="success" live>
      Online
    </Badge>
  ) : (
    <Badge variant="neutral" dot>
      Offline
    </Badge>
  );
}

/**
 * Capabilities the host reports vs. the ones enabled centrally: enabled and
 * reported run; enabled but not reported can't run on this host.
 */
export function CapabilityBadges({ reported, enabled }: { reported: string[]; enabled: string[] }) {
  const all = [...new Set([...enabled, ...reported])].sort();
  if (all.length === 0) return <Muted>None</Muted>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
      {all.map((capability) => {
        const isEnabled = enabled.includes(capability);
        const isReported = reported.includes(capability);
        const [variant, title] = isEnabled
          ? isReported
            ? (["success", "Enabled and reported by the host"] as const)
            : (["warning", "Enabled, but the host doesn't report it"] as const)
          : (["outline", "Reported by the host, not enabled"] as const);
        return (
          <Badge key={capability} variant={variant} title={title}>
            {capability}
            {!isEnabled && " (off)"}
            {isEnabled && !isReported && " (unsupported)"}
          </Badge>
        );
      })}
    </div>
  );
}

export function JobTargetLink({ job }: { job: AgentRow["runningJobs"][number] }) {
  const label = job.target?.label ?? job.id.slice(0, 8);
  const text = (
    <>
      <span style={{ color: "var(--text-tertiary)" }}>{job.type}</span> {label}
    </>
  );
  const style = {
    display: "inline-flex",
    alignItems: "center",
    gap: "var(--space-1)",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    color: "var(--text-secondary)",
    textDecoration: "none",
  } as const;
  return job.target?.url ? (
    <a href={job.target.url} target="_blank" rel="noreferrer" style={style}>
      {text}
      <IconExternalLink size={12} />
    </a>
  ) : (
    <span style={style}>{text}</span>
  );
}

export function RepositoryBadges({
  repositories,
}: {
  repositories: AgentRow["pinnedRepositories"];
}) {
  if (repositories.length === 0) return <Muted>None</Muted>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-1)" }}>
      {repositories.map((repo) => (
        <Badge key={repo.id} variant="info">
          <ProviderIcon provider={repo.provider} size={12} />
          {repo.fullPath}
        </Badge>
      ))}
    </div>
  );
}
