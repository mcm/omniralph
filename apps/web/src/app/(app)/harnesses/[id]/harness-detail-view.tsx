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
  HarnessStatusBadge,
  CapabilityBadges,
  JobTargetLink,
  UpdateStatusBadge,
} from "../harness-parts";
import { ProviderIcon } from "../../repositories/repositories-view";
import { HarnessAuditLog, TokenTheftAlert, type AuditRow } from "./harness-audit-log";

interface HarnessDetailViewProps {
  harness: HarnessRow;
  now: number;
  /** Capabilities the control panel can dispatch. */
  knownCapabilities: string[];
  /** Connected repositories (for pinning). */
  repositories: { id: string; provider: "github" | "gitlab"; fullPath: string }[];
  audit: AuditRow[];
  /** Settings › Harnesses version (described when it tracks npm's latest), used when the harness has no override. */
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
  harness,
  knownCapabilities,
}: {
  harness: HarnessRow;
  knownCapabilities: string[];
}) {
  const { pending, run } = useAction();
  const [maxConcurrency, setMaxConcurrency] = React.useState(String(harness.maxConcurrency));
  const [capabilities, setCapabilities] = React.useState<string[]>(
    harness.enabledCapabilities.filter((c) => knownCapabilities.includes(c)),
  );
  const [limits, setLimits] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(harness.capabilityLimits).map(([name, limit]) => [name, String(limit)]),
    ),
  );
  const disabled = harness.revoked || pending;
  const slots = Number(maxConcurrency) >= 1 ? Math.floor(Number(maxConcurrency)) : 1;

  const toggle = (capability: string, on: boolean) =>
    setCapabilities((current) =>
      on ? [...new Set([...current, capability])] : current.filter((c) => c !== capability),
    );

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    run(
      () =>
        updateHarnessConfig(harness.id, {
          maxConcurrency: Number(maxConcurrency),
          enabledCapabilities: capabilities,
          // Blank limits use the default.
          capabilityLimits: Object.fromEntries(
            capabilities
              .filter((capability) => limits[capability]?.trim())
              .map((capability) => [capability, Number(limits[capability])]),
          ),
        }),
      "Saved. The harness picks it up with its next heartbeat.",
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Configuration</CardTitle>
        <CardDescription>
          Central settings, returned to the harness in every heartbeat response (every 20 seconds).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} style={stack}>
          <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap" }}>
            <Field
              label="Max concurrency"
              htmlFor="max-concurrency"
              hint="Jobs the harness runs at once (1–32)."
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
                {!harness.reportedCapabilities.includes(capability) && (
                  <Muted>(not reported by the host)</Muted>
                )}
              </div>
            ))}
          </div>
          {capabilities.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
              <span style={factLabel}>Concurrency per capability</span>
              <Muted>
                Caps how many of the harness&apos;s slots a capability&apos;s jobs may take (1 to
                the max concurrency). Leave blank for the default: ralph leaves one slot free for
                other work; triage and review may use every slot, so cap triage to keep room for
                ralph and reviews. Lowering a limit doesn&apos;t cancel running jobs; the harness
                takes no new ones until it is under the limit.
              </Muted>
              <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap" }}>
                {capabilities.map((capability) => (
                  <Field
                    key={capability}
                    label={capability}
                    htmlFor={`limit-${capability}`}
                    hint={`Effective now: ${harness.effectiveCapabilityLimits[capability] ?? "not enabled"}.`}
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
            {harness.selfUpdate === "supported" && (
              <Button
                type="button"
                variant="secondary"
                disabled={disabled}
                title="Update to the desired version (the latest on npm when none is set) with the next heartbeat, even if it failed here before."
                onClick={() =>
                  run(
                    () => requestHarnessUpdate(harness.id),
                    `${harness.name} will update with its next heartbeat.`,
                  )
                }
              >
                <IconCloudDownload size={14} />
                Update now
              </Button>
            )}
          </div>
          {harness.updateRequest && (
            <Muted>
              Update to {harness.updateRequest.version} requested{" "}
              {formatDateTime(harness.updateRequest.requestedAt)}; the harness starts it with its
              next heartbeat.
            </Muted>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

// ── Version ──────────────────────────────────────────────────────────────────

function VersionCard({
  harness,
  globalDesiredVersion,
}: {
  harness: HarnessRow;
  globalDesiredVersion: string | null;
}) {
  const { pending, run } = useAction();
  const [override, setOverride] = React.useState(harness.desiredVersionOverride ?? "");
  const disabled = harness.revoked || pending;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    run(
      () => setHarnessDesiredVersion(harness.id, override),
      override.trim()
        ? `${harness.name} will update to ${override.trim()} with its next heartbeat.`
        : `${harness.name} follows the organization's version again.`,
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Version</CardTitle>
        <CardDescription>
          {harness.selfUpdate === "supported"
            ? "This harness runs under pm2 and updates itself: it stops taking jobs, lets running ones finish (up to 2 hours), installs the desired version and restarts. A version that doesn't stay up is rolled back and not tried again here unless you use Update now, which also updates to the latest on npm when no version is chosen."
            : "This harness can't update itself (it isn't running under pm2, or its version predates self-update). Install the desired version on the host."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save} style={stack}>
          <Field
            label="Desired version override"
            htmlFor="desired-version"
            hint={`Semver, e.g. 1.4.0. Leave blank to use the global version (${globalDesiredVersion ?? "not set"}, Settings › Harnesses).`}
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
  harness,
  repositories,
}: {
  harness: HarnessRow;
  repositories: HarnessDetailViewProps["repositories"];
}) {
  const { pending, run } = useAction();
  const pinnedIds = new Set(harness.pinnedRepositories.map((r) => r.id));
  const available = repositories.filter((r) => !pinnedIds.has(r.id));
  const [selected, setSelected] = React.useState("");
  const selectedRepo = available.find((r) => r.id === selected);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pinned repositories</CardTitle>
        <CardDescription>
          Jobs for a pinned repository only go to the harnesses it&apos;s pinned to. Pinning makes
          this harness pre-clone the repository.
        </CardDescription>
      </CardHeader>
      <CardContent style={stack}>
        {harness.pinnedRepositories.length === 0 ? (
          <Muted>
            No pinned repositories. This harness serves every repository that isn&apos;t pinned
            elsewhere.
          </Muted>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
            {harness.pinnedRepositories.map((repo) => (
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
                  disabled={pending || harness.revoked}
                  onClick={() =>
                    run(() => unpinRepository(harness.id, repo.id), `Unpinned ${repo.fullPath}`)
                  }
                >
                  <IconPinnedOff size={14} />
                  Unpin
                </Button>
              </div>
            ))}
          </div>
        )}
        {!harness.revoked && (
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
                  () => pinRepository(harness.id, selectedRepo.id),
                  `Pinned ${selectedRepo.fullPath}; the harness will pre-clone it`,
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

function RevokeCard({ harness }: { harness: HarnessRow }) {
  const { pending, run } = useAction();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Revoke</CardTitle>
        <CardDescription>
          Revoking is immediate: the harness&apos;s access, refresh and job tokens stop working on
          its next request, its running jobs are redelivered to other harnesses and its pins are
          removed. To use the host again, enroll it as a new harness.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" disabled={pending}>
              <IconBan size={14} />
              Revoke harness
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke {harness.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This can&apos;t be undone.{" "}
                {harness.runningJobs.length > 0
                  ? `Its ${harness.runningJobs.length} running job${harness.runningJobs.length === 1 ? "" : "s"} will be retried by other harnesses.`
                  : "It has no running jobs."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => run(() => revokeHarness(harness.id), `Revoked ${harness.name}`)}
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

function DeleteCard({ harness }: { harness: HarnessRow }) {
  const router = useRouter();
  const { pending, run } = useAction();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete</CardTitle>
        <CardDescription>
          Deleting removes the harness from the Harnesses pages for good
          {harness.revoked ? "." : ", revoking it first."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" disabled={pending}>
              <IconTrash size={14} />
              Delete harness
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {harness.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                This can&apos;t be undone.{" "}
                {harness.revoked
                  ? "It disappears from the harness list."
                  : harness.runningJobs.length > 0
                    ? `It's revoked and its ${harness.runningJobs.length} running job${harness.runningJobs.length === 1 ? "" : "s"} will be retried by other harnesses.`
                    : "It's revoked and disappears from the harness list."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={() =>
                  run(
                    () => deleteHarness(harness.id),
                    `Deleted ${harness.name}`,
                    () => router.push("/harnesses"),
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

export function HarnessDetailView({
  harness,
  now,
  knownCapabilities,
  repositories,
  audit,
  globalDesiredVersion,
}: HarnessDetailViewProps) {
  return (
    <>
      <AppHeader
        breadcrumbs={[{ label: "Harnesses", href: "/harnesses" }, { label: harness.name }]}
      />
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
          <h1 style={{ margin: 0, fontSize: "var(--text-2xl)", fontWeight: 600 }}>
            {harness.name}
          </h1>
          <HarnessStatusBadge harness={harness} />
        </div>

        <TokenTheftAlert audit={audit} />
        {harness.revoked && harness.revokedAt && (
          <Alert variant="warning">
            <AlertTitle>Revoked</AlertTitle>
            <AlertDescription>
              This harness was revoked {formatDateTime(harness.revokedAt)}. Its configuration can no
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
                {harness.lastHeartbeatAt ? formatRelative(harness.lastHeartbeatAt, now) : "Never"}
              </Fact>
              <Fact label="Version">{harness.version ?? "Unknown"}</Fact>
              <Fact label="Desired version">
                {harness.desiredVersion
                  ? `${harness.desiredVersion}${harness.desiredVersionOverride ? " (override)" : harness.tracksLatest ? " (latest on npm)" : " (organization)"}`
                  : harness.tracksLatest
                    ? "Latest on npm (not read yet)"
                    : "Not set"}
              </Fact>
              <Fact label="Update status">
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                  <div>
                    <UpdateStatusBadge harness={harness} />
                  </div>
                  {harness.update?.error && <Muted>{harness.update.error}</Muted>}
                </div>
              </Fact>
              <Fact label="Failed versions">
                {harness.failedVersions.length > 0 ? harness.failedVersions.join(", ") : "None"}
              </Fact>
              <Fact label="Capabilities (reported vs. enabled)">
                <CapabilityBadges
                  reported={harness.reportedCapabilities}
                  enabled={harness.enabledCapabilities}
                />
              </Fact>
              <Fact label="Running jobs">
                <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-1)" }}>
                  <span>
                    {harness.runningJobs.length} / {harness.maxConcurrency}
                  </span>
                  {harness.runningJobs.map((job) => (
                    <JobTargetLink key={job.id} job={job} />
                  ))}
                </div>
              </Fact>
              <Fact label="Concurrency per capability">
                {Object.keys(harness.effectiveCapabilityLimits).length === 0
                  ? "No capabilities enabled"
                  : Object.entries(harness.effectiveCapabilityLimits)
                      .map(([capability, limit]) => `${capability}: ${limit}`)
                      .join(", ")}
              </Fact>
              <Fact label="Enrolled">{formatDateTime(harness.createdAt)}</Fact>
            </div>
          </CardContent>
        </Card>

        <ConfigCard harness={harness} knownCapabilities={knownCapabilities} />
        <VersionCard harness={harness} globalDesiredVersion={globalDesiredVersion} />
        <PinsCard harness={harness} repositories={repositories} />

        <Card>
          <CardHeader>
            <CardTitle>Audit log</CardTitle>
            <CardDescription>The 50 most recent security events for this harness.</CardDescription>
          </CardHeader>
          <CardContent>
            <HarnessAuditLog audit={audit} />
          </CardContent>
        </Card>

        {!harness.revoked && <RevokeCard harness={harness} />}
        <DeleteCard harness={harness} />
      </main>
    </>
  );
}
