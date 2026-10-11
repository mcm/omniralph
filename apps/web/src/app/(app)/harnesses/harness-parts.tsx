"use client";

import { Badge, Muted } from "@iamthemcmaster/ui";
import { IconExternalLink } from "@tabler/icons-react";
import type { HarnessRow } from "@/lib/harnesses/rows";
import { UPDATE_STATUS_LABELS } from "@/lib/harnesses/update";
import { ProviderIcon } from "../repositories/repositories-view";

export function HarnessStatusBadge({
  harness,
}: {
  harness: Pick<HarnessRow, "online" | "revoked">;
}) {
  if (harness.revoked) return <Badge variant="danger">Revoked</Badge>;
  return harness.online ? (
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

export function JobTargetLink({ job }: { job: HarnessRow["runningJobs"][number] }) {
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
  repositories: HarnessRow["pinnedRepositories"];
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

const UPDATE_STATUS_VARIANTS = {
  up_to_date: "success",
  updating: "info",
  failed: "danger",
  manual: "warning",
} as const;

const UPDATE_STATE_LABELS: Record<NonNullable<HarnessRow["update"]>["state"], string | null> = {
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
    HarnessRow,
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
    <Badge variant={UPDATE_STATUS_VARIANTS[harness.updateStatus]} title={title}>
      {UPDATE_STATUS_LABELS[harness.updateStatus]}
      {harness.updateStatus === "updating" && step && ` (${step})`}
    </Badge>
  );
}

/** The reported version, and the desired one when it differs. */
export function HarnessVersionCell({ harness }: { harness: HarnessRow }) {
  const target = harness.updateRequest?.version ?? harness.desiredVersion;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      {harness.version ? (
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--text-sm)",
            color: "var(--text-secondary)",
          }}
        >
          {harness.version}
          {target && target !== harness.version && (
            <span style={{ color: "var(--text-tertiary)" }}> → {target}</span>
          )}
        </span>
      ) : (
        <Muted>Unknown</Muted>
      )}
      {!harness.revoked && <UpdateStatusBadge harness={harness} />}
    </div>
  );
}
