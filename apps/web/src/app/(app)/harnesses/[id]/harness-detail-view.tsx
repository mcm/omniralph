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
  InlineCode,
  Input,
  Label,
  Muted,
  NativeSelect,
} from "@iamthemcmaster/ui";
import { IconBan, IconCloudDownload, IconPin, IconPinnedOff, IconTrash } from "@tabler/icons-react";
import { defaultPoolLimit } from "@omniralph/shared";
import { POOLS, TASK_TYPES } from "@omniralph/tasks";
import { AppHeader } from "@/components/app-header";
import { PageHeader } from "@/components/page-header";
import { SettingsCard } from "@/components/settings-card";
import { useAction } from "@/components/use-action";
import {
  formatSettingValue,
  settingChanges,
  withDefault,
  type SettingSpec,
  type SettingValue,
} from "@/lib/settings/changes";
import { typedNumber } from "@/lib/settings/forms";
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
  formatPoolLimits,
  HarnessStatusBadge,
  JobTargetLink,
  TaskTypeBadges,
  UpdateStatusBadge,
} from "../harness-parts";
import { ProviderIcon } from "../../repositories/repositories-view";
import { HarnessAuditLog, TokenTheftAlert, type AuditRow } from "./harness-audit-log";
import { HarnessHostTools, type HostToolRow } from "./harness-host-tools";
import {
  InstallForm,
  InstallJobs,
  InstalledInstallables,
  type InstallJobRow,
  type InstallableRow,
} from "./harness-installables";

interface HarnessDetailViewProps {
  harness: HarnessRow;
  now: number;
  /** Connected repositories (for pinning). */
  repositories: { id: string; provider: "github" | "gitlab"; fullPath: string }[];
  audit: AuditRow[];
  /** The installables the harness reported in its last heartbeat. */
  installables: InstallableRow[];
  /** `install` jobs targeted at the harness in the last 24 hours, newest first. */
  installJobs: InstallJobRow[];
  /** Every host tool of the organization's catalog with this harness's path and report, by name. */
  hostTools: HostToolRow[];
  /** Settings › Harness defaults version (described when it tracks npm's latest), used when the harness has no override. */
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

/** What each task type the harness may accept runs. */
const TASK_TYPE_HINTS: Record<(typeof TASK_TYPES)[number], string> = {
  query: "Read-only questions: replies, code questions, learned rules, triage.",
  review: "Pull request reviews.",
  coding: "Ralph runs that change code and push it.",
};

const TASK_TYPE_LABELS: Record<(typeof TASK_TYPES)[number], string> = {
  query: "Query",
  review: "Review",
  coding: "Coding",
};

/** A new harness's configuration (the `harnesses` column defaults in `@omniralph/db`). */
export const HARNESS_CONFIG_DEFAULTS = {
  maxConcurrency: 1,
  acceptedTaskTypes: ["query", "review"],
};

interface ConfigDraft {
  maxConcurrency: string;
  taskTypes: readonly string[];
  /** Blank for the pool's default. */
  limits: Readonly<Record<string, string>>;
}

function configDraft(harness: HarnessRow): ConfigDraft {
  return {
    maxConcurrency: String(harness.maxConcurrency),
    taskTypes: harness.acceptedTaskTypes.filter((t) =>
      (TASK_TYPES as readonly string[]).includes(t),
    ),
    limits: Object.fromEntries(
      Object.entries(harness.poolLimits).map(([name, limit]) => [name, String(limit)]),
    ),
  };
}

/** The draft as compared and saved: task types in their listed order, blank limits null. */
function configValues(draft: ConfigDraft): Record<string, SettingValue> {
  return {
    maxConcurrency: typedNumber(draft.maxConcurrency),
    acceptedTaskTypes: TASK_TYPES.filter((t) => draft.taskTypes.includes(t)),
    ...Object.fromEntries(
      POOLS.map((pool) => [pool, draft.limits[pool]?.trim() ? Number(draft.limits[pool]) : null]),
    ),
  };
}

const poolLimitFormat = (value: SettingValue) =>
  value === null ? "Default" : formatSettingValue(value);

const CONFIG_SPECS: SettingSpec[] = [
  { key: "maxConcurrency", label: "Max concurrency" },
  {
    key: "acceptedTaskTypes",
    label: "Accepted task types",
    format: (value) =>
      formatSettingValue(
        Array.isArray(value)
          ? value.map((t: string) => TASK_TYPE_LABELS[t as (typeof TASK_TYPES)[number]] ?? t)
          : value,
      ),
  },
  ...POOLS.map((pool) => ({
    key: pool,
    label: `${pool[0]!.toUpperCase()}${pool.slice(1)} pool limit`,
    format: poolLimitFormat,
  })),
];

function ConfigCard({ harness }: { harness: HarnessRow }) {
  const { pending, run } = useAction();
  const saved = React.useMemo(() => configDraft(harness), [harness]);
  const [draft, setDraft] = React.useState(saved);
  const disabled = harness.revoked || pending;
  const slots = Number(draft.maxConcurrency) >= 1 ? Math.floor(Number(draft.maxConcurrency)) : 1;
  const values = configValues(draft);

  const toggle = (taskType: string, on: boolean) =>
    setDraft((d) => ({
      ...d,
      taskTypes: TASK_TYPES.filter((t) => (t === taskType ? on : d.taskTypes.includes(t))),
    }));

  const prepare = () => ({
    action: () =>
      updateHarnessConfig(harness.id, {
        maxConcurrency: Number(draft.maxConcurrency),
        acceptedTaskTypes: [...(values.acceptedTaskTypes as string[])],
        // Blank limits use the default.
        poolLimits: Object.fromEntries(
          POOLS.filter((pool) => values[pool] !== null).map((pool) => [
            pool,
            values[pool] as number,
          ]),
        ),
      }),
    success: "Saved. The harness picks it up with its next heartbeat.",
  });

  return (
    <SettingsCard
      title="Configuration"
      description="Central settings, returned to the harness in every heartbeat response (every 20 seconds)."
      changes={settingChanges(CONFIG_SPECS, configValues(saved), values)}
      prepare={prepare}
      onDiscard={() => setDraft(saved)}
      confirm={{
        consequence:
          "The harness picks these up with its next heartbeat (within 20 seconds). Running jobs aren't cancelled; it takes new jobs by the new limits.",
      }}
      readOnly={harness.revoked}
      actions={
        harness.selfUpdate === "supported" && (
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
        )
      }
    >
      <div className="settings-row">
        <Field
          label="Max concurrency"
          htmlFor="max-concurrency"
          description={withDefault(
            "Jobs the harness runs at once (1–32).",
            String(HARNESS_CONFIG_DEFAULTS.maxConcurrency),
          )}
        >
          <Input
            id="max-concurrency"
            type="number"
            min={1}
            max={32}
            required
            disabled={harness.revoked}
            value={draft.maxConcurrency}
            onChange={(e) => setDraft((d) => ({ ...d, maxConcurrency: e.target.value }))}
          />
        </Field>
      </div>
      <div className="settings-group" role="group" aria-labelledby="task-types-label">
        <span id="task-types-label" className="settings-group-label">
          Accepted task types
        </span>
        <Muted>
          Which tasks this host may run. Housekeeping jobs (repository syncs) always run. Default:{" "}
          {HARNESS_CONFIG_DEFAULTS.acceptedTaskTypes
            .map((t) => TASK_TYPE_LABELS[t as (typeof TASK_TYPES)[number]])
            .join(" and ")}
          .
        </Muted>
        {TASK_TYPES.map((taskType) => (
          <div key={taskType} className="settings-check settings-check-center">
            <Checkbox
              id={`task-type-${taskType}`}
              checked={draft.taskTypes.includes(taskType)}
              disabled={harness.revoked}
              onCheckedChange={(checked) => toggle(taskType, checked === true)}
            />
            <Label htmlFor={`task-type-${taskType}`}>{TASK_TYPE_LABELS[taskType]}</Label>
            <Muted>{TASK_TYPE_HINTS[taskType]}</Muted>
          </div>
        ))}
      </div>
      <div className="settings-group" role="group" aria-labelledby="pool-limits-label">
        <span id="pool-limits-label" className="settings-group-label">
          Concurrency per pool
        </span>
        <Muted>
          Caps how many of the harness&apos;s slots a pool&apos;s jobs may take (1 to the max
          concurrency): <InlineCode>short</InlineCode> holds query and review tasks,{" "}
          <InlineCode>long</InlineCode> coding tasks. Leave blank for the default: long leaves one
          slot free for other work; short may use every slot. Lowering a limit doesn&apos;t cancel
          running jobs; the harness takes no new ones until it is under the limit.
        </Muted>
        <div className="settings-row">
          {POOLS.map((pool) => (
            <Field
              key={pool}
              label={`${pool[0]!.toUpperCase()}${pool.slice(1)} pool`}
              htmlFor={`limit-${pool}`}
              description={`Default: ${defaultPoolLimit(pool, slots)}. Effective now: ${harness.effectivePoolLimits[pool] ?? "unknown"}.`}
            >
              <Input
                id={`limit-${pool}`}
                type="number"
                min={1}
                max={slots}
                placeholder={`Default (${defaultPoolLimit(pool, slots)})`}
                disabled={harness.revoked}
                value={draft.limits[pool] ?? ""}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, limits: { ...d.limits, [pool]: e.target.value } }))
                }
              />
            </Field>
          ))}
        </div>
      </div>
      {harness.updateRequest && (
        <Muted>
          Update to {harness.updateRequest.version} requested{" "}
          {formatDateTime(harness.updateRequest.requestedAt)}; the harness starts it with its next
          heartbeat.
        </Muted>
      )}
    </SettingsCard>
  );
}

// ── Version ──────────────────────────────────────────────────────────────────

const VERSION_SPECS: SettingSpec[] = [
  {
    key: "override",
    label: "Desired version override",
    format: (value) => (value === "" ? "None (organization's version)" : formatSettingValue(value)),
  },
];

function VersionCard({
  harness,
  globalDesiredVersion,
}: {
  harness: HarnessRow;
  globalDesiredVersion: string | null;
}) {
  const savedOverride = harness.desiredVersionOverride ?? "";
  const [override, setOverride] = React.useState(savedOverride);

  return (
    <SettingsCard
      title="Version"
      description={
        harness.selfUpdate === "supported"
          ? "This harness runs under pm2 and updates itself: it stops taking jobs, lets running ones finish (up to 2 hours), installs the desired version and restarts. A version that doesn't stay up is rolled back and not tried again here unless you use Update now, which also updates to the latest on npm when no version is chosen."
          : "This harness can't update itself (it isn't running under pm2, or its version predates self-update). Install the desired version on the host."
      }
      changes={settingChanges(
        VERSION_SPECS,
        { override: savedOverride.trim() },
        { override: override.trim() },
      )}
      prepare={() => ({
        action: () => setHarnessDesiredVersion(harness.id, override),
        success: override.trim()
          ? `${harness.name} will update to ${override.trim()} with its next heartbeat.`
          : `${harness.name} follows the organization's version again.`,
      })}
      onDiscard={() => setOverride(savedOverride)}
      readOnly={harness.revoked}
    >
      <Field
        label="Desired version override"
        htmlFor="desired-version"
        description={`Semver, e.g. 1.4.0. Leave blank to use the global version (${globalDesiredVersion ?? "not set"}, Settings › Harness defaults). Default: blank.`}
      >
        <Input
          id="desired-version"
          placeholder={globalDesiredVersion ?? "Not set"}
          disabled={harness.revoked}
          value={override}
          onChange={(e) => setOverride(e.target.value)}
          className="settings-mono"
        />
      </Field>
    </SettingsCard>
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
        <CardTitle as="h2">Pinned repositories</CardTitle>
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

// ── Installables ─────────────────────────────────────────────────────────────

export function InstallablesCard({
  harness,
  installables,
  installJobs,
}: {
  harness: HarnessRow;
  installables: InstallableRow[];
  installJobs: InstallJobRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Installables</CardTitle>
        <CardDescription>
          npm packages that add commands, MCP servers and skills to this host, as reported in its
          last heartbeat. Installing or updating one runs on the harness, which refuses packages its
          local allowlist doesn&apos;t allow.
        </CardDescription>
      </CardHeader>
      <CardContent style={stack}>
        <InstalledInstallables installables={installables} />
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
          <span style={factLabel}>Installs in the last 24 hours</span>
          <InstallJobs jobs={installJobs} />
        </div>
        {!harness.revoked && <InstallForm harnessId={harness.id} />}
      </CardContent>
    </Card>
  );
}

// ── Host tools ───────────────────────────────────────────────────────────────

export function HostToolsCard({
  harness,
  hostTools,
}: {
  harness: HarnessRow;
  hostTools: HostToolRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Host tools</CardTitle>
        <CardDescription>
          Software installed on this host by hand. A configured path wins over the one the harness
          discovers on its <InlineCode>PATH</InlineCode>, even when it doesn&apos;t exist: the tool
          is then unavailable. Leave it blank to use the discovered one. The harness gets a new path
          with its next heartbeat and reports on it with the one after; it refuses paths its local{" "}
          <InlineCode>blockedExecPaths</InlineCode> covers.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <HarnessHostTools harnessId={harness.id} revoked={harness.revoked} hostTools={hostTools} />
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
        <CardTitle as="h2">Revoke</CardTitle>
        <CardDescription>
          Revoking is immediate: the harness&apos;s access, refresh and job tokens stop working on
          its next request, its running jobs are redelivered to other harnesses and its pins are
          removed. To use the host again, enroll it as a new harness.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="danger" disabled={pending}>
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
                variant="danger"
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
        <CardTitle as="h2">Delete</CardTitle>
        <CardDescription>
          Deleting removes the harness from the Harnesses pages for good
          {harness.revoked ? "." : ", revoking it first."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="danger" disabled={pending}>
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
                variant="danger"
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
  repositories,
  audit,
  installables,
  installJobs,
  hostTools,
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
          padding: "var(--space-8)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-6)",
        }}
      >
        <PageHeader title={harness.name} meta={<HarnessStatusBadge harness={harness} />} />

        <TokenTheftAlert audit={audit} />
        {harness.revoked && harness.revokedAt && (
          <Alert variant="warning">
            <AlertTitle as="h2">Revoked</AlertTitle>
            <AlertDescription>
              This harness was revoked {formatDateTime(harness.revokedAt)}. Its configuration can no
              longer be changed.
            </AlertDescription>
          </Alert>
        )}

        <Card>
          <CardHeader>
            <CardTitle as="h2">Status</CardTitle>
          </CardHeader>
          <CardContent>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(calc(var(--space-8) * 8), 1fr))",
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
              <Fact label="Accepted task types">
                <TaskTypeBadges accepted={harness.acceptedTaskTypes} />
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
              <Fact label="Concurrency per pool">
                {formatPoolLimits(harness.effectivePoolLimits)}
              </Fact>
              <Fact label="Enrolled">{formatDateTime(harness.createdAt)}</Fact>
            </div>
          </CardContent>
        </Card>

        <ConfigCard harness={harness} />
        <VersionCard harness={harness} globalDesiredVersion={globalDesiredVersion} />
        <PinsCard harness={harness} repositories={repositories} />
        <InstallablesCard harness={harness} installables={installables} installJobs={installJobs} />
        <HostToolsCard harness={harness} hostTools={hostTools} />

        <Card>
          <CardHeader>
            <CardTitle as="h2">Audit log</CardTitle>
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
