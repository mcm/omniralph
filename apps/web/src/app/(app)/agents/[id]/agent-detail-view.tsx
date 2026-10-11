"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Field,
  Input,
  Label,
  Muted,
  NativeSelect,
} from "@iamthemcmaster/ui";
import {
  IconBan,
  IconCloudDownload,
  IconDeviceFloppy,
  IconPin,
  IconPinnedOff,
  IconTrash,
} from "@tabler/icons-react";
import { defaultCapabilityLimit } from "@omniralph/shared";
import { AppHeader } from "@/components/app-header";
import { useAction } from "@/components/use-action";
import type { HarnessRow } from "@/lib/harnesses/rows";
import { formatDateTime, formatRelative } from "@/lib/format-date";
import {
  deleteHarness,
  pinRepository,
  requestHarnessUpdate,
  revokeHarness,
  setHarnessDesiredVersion,
  unpinRepository,
  updateHarnessConfig,
} from "../actions";
import {
  AgentStatusBadge,
  CapabilityBadges,
  JobTargetLink,
  UpdateStatusBadge,
} from "../agent-parts";
import { ProviderIcon } from "../../repositories/repositories-view";
import { AgentAuditLog, TokenTheftAlert, type AuditRow } from "./agent-audit-log";

interface AgentDetailViewProps {
  agent: HarnessRow;
  now: number;
  /** Capabilities the control panel can dispatch. */
  knownCapabilities: string[];
  /** Connected repositories (for pinning). */
  repositories: { id: string; provider: "github" | "gitlab"; fullPath: string }[];
  audit: AuditRow[];
  /** Settings › Agents version (described when it tracks npm's latest), used when the agent has no override. */
  globalDesiredVersion: string | null;
}

const stack = { display: "flex", flexDirection: "column", gap: "var(--space-4)" } as const;
const factLabel = { fontSize: "var(--text-xs)", color: "var(--text-tertiary)" } as const;
const factValue = { fontSize: "var(--text-sm)", color: "var(--text-primary)" } as const;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
      <span style={factLabel}>{label}</span>
      <div style={factValue}>{children}</div>
    </div>
  );
}

// ── Configuration ────────────────────────────────────────────────────────────

function ConfigCard({
  agent,
  knownCapabilities,
}: {
  agent: HarnessRow;
  knownCapabilities: string[];
}) {
  const { pending, run } = useAction();
  const [maxConcurrency, setMaxConcurrency] = React.useState(String(agent.maxConcurrency));
  const [capabilities, setCapabilities] = React.useState<string[]>(
    agent.enabledCapabilities.filter((c) => knownCapabilities.includes(c)),
  );
  const [limits, setLimits] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(agent.capabilityLimits).map(([name, limit]) => [name, String(limit)]),
    ),
  );
  const disabled = agent.revoked || pending;
  const slots = Number(maxConcurrency) >= 1 ? Math.floor(Number(maxConcurrency)) : 1;

  const toggle = (capability: string, on: boolean) =>
    setCapabilities((current) =>
      on ? [...new Set([...current, capability])] : current.filter((c) => c !== capability),
    );

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    run(
      () =>
        updateHarnessConfig(agent.id, {
          maxConcurrency: Number(maxConcurrency),
          enabledCapabilities: capabilities,
          // Blank limits use the default.
          capabilityLimits: Object.fromEntries(
            capabilities
              .filter((capability) => limits[capability]?.trim())
              .map((capability) => [capability, Number(limits[capability])]),
          ),
        }),
      "Saved. The agent picks it up with its next heartbeat.",
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
        <CardDescription>
          Central settings, returned to the agent in every heartbeat response (every 20 seconds).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} style={stack}>
          <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap" }}>
            <Field
              label="Max concurrency"
              htmlFor="max-concurrency"
              hint="Jobs the agent runs at once (1–32)."
            >
              <Input
                id="max-concurrency"
                type="number"
                min={1}
                max={32}
                required
                disabled={disabled}
                value={maxConcurrency}
                onChange={(e) => setMaxConcurrency(e.target.value)}
              />
            </Field>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            <span style={factLabel}>Enabled capabilities</span>
            {knownCapabilities.map((capability) => (
              <div
                key={capability}
                style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}
              >
                <Checkbox
                  id={`capability-${capability}`}
                  checked={capabilities.includes(capability)}
                  disabled={disabled}
                  onCheckedChange={(checked) => toggle(capability, checked === true)}
                />
                <Label htmlFor={`capability-${capability}`}>{capability}</Label>
                {!agent.reportedCapabilities.includes(capability) && (
                  <Muted>(not reported by the host)</Muted>
                )}
              </div>
            ))}
          </div>
          {capabilities.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              <span style={factLabel}>Concurrency per capability</span>
              <Muted>
                Caps how many of the agent&apos;s slots a capability&apos;s jobs may take (1 to the
                max concurrency). Leave blank for the default: ralph leaves one slot free for other
                work; triage and review may use every slot, so cap triage to keep room for ralph and
                reviews. Lowering a limit doesn&apos;t cancel running jobs; the agent takes no new
                ones until it is under the limit.
              </Muted>
              <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap" }}>
                {capabilities.map((capability) => (
                  <Field
                    key={capability}
                    label={capability}
                    htmlFor={`limit-${capability}`}
                    hint={`Effective now: ${agent.effectiveCapabilityLimits[capability] ?? "not enabled"}.`}
                    // Fields size to their hint; keep room for the "Default (n)" placeholder.
                    style={{ minWidth: "12rem" }}
                  >
                    <Input
                      id={`limit-${capability}`}
                      type="number"
                      min={1}
                      max={slots}
                      placeholder={`Default (${defaultCapabilityLimit(capability, slots)})`}
                      disabled={disabled}
                      value={limits[capability] ?? ""}
                      onChange={(e) =>
                        setLimits((current) => ({ ...current, [capability]: e.target.value }))
                      }
                    />
                  </Field>
                ))}
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button type="submit" variant="primary" disabled={disabled}>
              <IconDeviceFloppy size={14} />
              {pending ? "Saving…" : "Save"}
            </Button>
            {agent.selfUpdate === "supported" && (
              <Button
                type="button"
                variant="secondary"
                disabled={disabled}
                title="Update to the desired version (the latest on npm when none is set) with the next heartbeat, even if it failed here before."
                onClick={() =>
                  run(
                    () => requestHarnessUpdate(agent.id),
                    `${agent.name} will update with its next heartbeat.`,
                  )
                }
              >
                <IconCloudDownload size={14} />
                Update now
              </Button>
            )}
          </div>
          {agent.updateRequest && (
            <Muted>
              Update to {agent.updateRequest.version} requested{" "}
              {formatDateTime(agent.updateRequest.requestedAt)}; the agent starts it with its next
              heartbeat.
            </Muted>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

// ── Version ──────────────────────────────────────────────────────────────────

function VersionCard({
  agent,
  globalDesiredVersion,
}: {
  agent: HarnessRow;
  globalDesiredVersion: string | null;
}) {
  const { pending, run } = useAction();
  const [override, setOverride] = React.useState(agent.desiredVersionOverride ?? "");
  const disabled = agent.revoked || pending;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    run(
      () => setHarnessDesiredVersion(agent.id, override),
      override.trim()
        ? `${agent.name} will update to ${override.trim()} with its next heartbeat.`
        : `${agent.name} follows the organization's version again.`,
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Version</CardTitle>
        <CardDescription>
          {agent.selfUpdate === "supported"
            ? "This agent runs under pm2 and updates itself: it stops taking jobs, lets running ones finish (up to 2 hours), installs the desired version and restarts. A version that doesn't stay up is rolled back and not tried again here unless you use Update now, which also updates to the latest on npm when no version is chosen."
            : "This agent can't update itself (it isn't running under pm2, or its version predates self-update). Install the desired version on the host."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} style={stack}>
          <Field
            label="Desired version override"
            htmlFor="desired-version"
            hint={`Semver, e.g. 1.4.0. Leave blank to use the global version (${globalDesiredVersion ?? "not set"}, Settings › Agents).`}
          >
            <Input
              id="desired-version"
              placeholder={globalDesiredVersion ?? "Not set"}
              disabled={disabled}
              value={override}
              onChange={(e) => setOverride(e.target.value)}
              style={{ fontFamily: "var(--font-mono)" }}
            />
          </Field>
          <div>
            <Button type="submit" variant="primary" disabled={disabled}>
              <IconDeviceFloppy size={14} />
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ── Pinned repositories ──────────────────────────────────────────────────────

function PinsCard({
  agent,
  repositories,
}: {
  agent: HarnessRow;
  repositories: AgentDetailViewProps["repositories"];
}) {
  const { pending, run } = useAction();
  const pinnedIds = new Set(agent.pinnedRepositories.map((r) => r.id));
  const available = repositories.filter((r) => !pinnedIds.has(r.id));
  const [selected, setSelected] = React.useState("");
  const selectedRepo = available.find((r) => r.id === selected);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pinned repositories</CardTitle>
        <CardDescription>
          Jobs for a pinned repository only go to the agents it&apos;s pinned to. Pinning makes this
          agent pre-clone the repository.
        </CardDescription>
      </CardHeader>
      <CardContent style={stack}>
        {agent.pinnedRepositories.length === 0 ? (
          <Muted>
            No pinned repositories. This agent serves every repository that isn&apos;t pinned
            elsewhere.
          </Muted>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            {agent.pinnedRepositories.map((repo) => (
              <div
                key={repo.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--space-3)",
                  padding: "var(--space-2) var(--space-4)",
                  background: "var(--bg-raised)",
                  borderRadius: "var(--radius-md)",
                  border: "1px solid var(--border-subtle)",
                }}
              >
                <ProviderIcon provider={repo.provider} size={14} />
                <a
                  href={repo.webUrl}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    flex: 1,
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-sm)",
                    color: "var(--text-primary)",
                    textDecoration: "none",
                  }}
                >
                  {repo.fullPath}
                </a>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending || agent.revoked}
                  onClick={() =>
                    run(() => unpinRepository(agent.id, repo.id), `Unpinned ${repo.fullPath}`)
                  }
                >
                  <IconPinnedOff size={14} />
                  Unpin
                </Button>
              </div>
            ))}
          </div>
        )}
        {!agent.revoked && (
          <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
            <NativeSelect
              aria-label="Repository to pin"
              value={selected}
              disabled={pending || available.length === 0}
              onChange={(e) => setSelected(e.target.value)}
              style={{ flex: 1 }}
            >
              <option value="">
                {available.length === 0
                  ? "No other connected repositories"
                  : "Choose a repository…"}
              </option>
              {available.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.fullPath} ({repo.provider === "github" ? "GitHub" : "GitLab"})
                </option>
              ))}
            </NativeSelect>
            <Button
              variant="secondary"
              disabled={pending || !selectedRepo}
              onClick={() =>
                selectedRepo &&
                run(
                  () => pinRepository(agent.id, selectedRepo.id),
                  `Pinned ${selectedRepo.fullPath}; the agent will pre-clone it`,
                  () => setSelected(""),
                )
              }
            >
              <IconPin size={14} />
              Pin
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Revoke ────────────────────────────────────────────────────────────────────

function RevokeCard({ agent }: { agent: HarnessRow }) {
  const { pending, run } = useAction();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revoke</CardTitle>
        <CardDescription>
          Revoking is immediate: the agent&apos;s access, refresh and job tokens stop working on its
          next request, its running jobs are redelivered to other agents and its pins are removed.
          To use the host again, enroll it as a new agent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" disabled={pending}>
              <IconBan size={14} />
              Revoke agent
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke {agent.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This can&apos;t be undone.{" "}
                {agent.runningJobs.length > 0
                  ? `Its ${agent.runningJobs.length} running job${agent.runningJobs.length === 1 ? "" : "s"} will be retried by other agents.`
                  : "It has no running jobs."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => run(() => revokeHarness(agent.id), `Revoked ${agent.name}`)}
              >
                Revoke
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

// ── Delete ────────────────────────────────────────────────────────────────────

function DeleteCard({ agent }: { agent: HarnessRow }) {
  const router = useRouter();
  const { pending, run } = useAction();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete</CardTitle>
        <CardDescription>
          Deleting removes the agent from the Agents pages for good
          {agent.revoked ? "." : ", revoking it first."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" disabled={pending}>
              <IconTrash size={14} />
              Delete agent
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This can&apos;t be undone.{" "}
                {agent.revoked
                  ? "It disappears from the agent list."
                  : agent.runningJobs.length > 0
                    ? `It's revoked and its ${agent.runningJobs.length} running job${agent.runningJobs.length === 1 ? "" : "s"} will be retried by other agents.`
                    : "It's revoked and disappears from the agent list."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  run(
                    () => deleteHarness(agent.id),
                    `Deleted ${agent.name}`,
                    () => router.push("/agents"),
                  )
                }
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function AgentDetailView({
  agent,
  now,
  knownCapabilities,
  repositories,
  audit,
  globalDesiredVersion,
}: AgentDetailViewProps) {
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Agents", href: "/agents" }, { label: agent.name }]} />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-6)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <h1 style={{ margin: 0, fontSize: "var(--text-2xl)", fontWeight: 600 }}>{agent.name}</h1>
          <AgentStatusBadge agent={agent} />
        </div>

        <TokenTheftAlert audit={audit} />
        {agent.revoked && agent.revokedAt && (
          <Alert variant="warning">
            <AlertTitle>Revoked</AlertTitle>
            <AlertDescription>
              This agent was revoked {formatDateTime(agent.revokedAt)}. Its configuration can no
              longer be changed.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(calc(var(--space-6) * 8), 1fr))",
                gap: "var(--space-4)",
              }}
            >
              <Fact label="Last heartbeat">
                {agent.lastHeartbeatAt ? formatRelative(agent.lastHeartbeatAt, now) : "Never"}
              </Fact>
              <Fact label="Version">{agent.version ?? "Unknown"}</Fact>
              <Fact label="Desired version">
                {agent.desiredVersion
                  ? `${agent.desiredVersion}${agent.desiredVersionOverride ? " (override)" : agent.tracksLatest ? " (latest on npm)" : " (organization)"}`
                  : agent.tracksLatest
                    ? "Latest on npm (not read yet)"
                    : "Not set"}
              </Fact>
              <Fact label="Update status">
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                  <div>
                    <UpdateStatusBadge agent={agent} />
                  </div>
                  {agent.update?.error && <Muted>{agent.update.error}</Muted>}
                </div>
              </Fact>
              <Fact label="Failed versions">
                {agent.failedVersions.length > 0 ? agent.failedVersions.join(", ") : "None"}
              </Fact>
              <Fact label="Capabilities (reported vs. enabled)">
                <CapabilityBadges
                  reported={agent.reportedCapabilities}
                  enabled={agent.enabledCapabilities}
                />
              </Fact>
              <Fact label="Running jobs">
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                  <span>
                    {agent.runningJobs.length} / {agent.maxConcurrency}
                  </span>
                  {agent.runningJobs.map((job) => (
                    <JobTargetLink key={job.id} job={job} />
                  ))}
                </div>
              </Fact>
              <Fact label="Concurrency per capability">
                {Object.keys(agent.effectiveCapabilityLimits).length === 0
                  ? "No capabilities enabled"
                  : Object.entries(agent.effectiveCapabilityLimits)
                      .map(([capability, limit]) => `${capability}: ${limit}`)
                      .join(", ")}
              </Fact>
              <Fact label="Enrolled">{formatDateTime(agent.createdAt)}</Fact>
            </div>
          </CardContent>
        </Card>

        <ConfigCard agent={agent} knownCapabilities={knownCapabilities} />
        <VersionCard agent={agent} globalDesiredVersion={globalDesiredVersion} />
        <PinsCard agent={agent} repositories={repositories} />

        <Card>
          <CardHeader>
            <CardTitle>Audit log</CardTitle>
            <CardDescription>The 50 most recent security events for this agent.</CardDescription>
          </CardHeader>
          <CardContent>
            <AgentAuditLog audit={audit} />
          </CardContent>
        </Card>

        {!agent.revoked && <RevokeCard agent={agent} />}
        <DeleteCard agent={agent} />
      </main>
    </>
  );
}
