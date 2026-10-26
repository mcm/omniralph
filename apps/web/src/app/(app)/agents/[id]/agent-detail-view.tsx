"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
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
  Field,
  InlineCode,
  Input,
  Muted,
  Skeleton,
  Stack,
} from "@iamthemcmaster/ui";
import { IconBan, IconCheck, IconClock, IconCloudDownload, IconTrash } from "@tabler/icons-react";
import { defaultPoolLimit, AgentVersion, POOLS } from "@omniralph/shared";
import { AppHeader } from "@/components/app-header";
import { Freshness } from "@/components/freshness";
import { Timestamp } from "@/components/list-table";
import { PageHeader } from "@/components/page-header";
import { QueryBoundary } from "@/components/query-boundary";
import { JobStatusBadge } from "@/components/ralph-badges";
import { useNow } from "@/components/relative-time";
import { SettingsPanel, SettingsSection, SettingsSubsection } from "@/components/settings-section";
import { useApiAction } from "@/components/use-api-action";
import { useApiMutation } from "@/components/use-api-mutation";
import { useSeededDraft } from "@/components/use-seeded-draft";
import { api } from "@/lib/api/client";
import {
  agentSavedSchema,
  agentUpdateRequestedSchema,
  type AgentConfigForm,
  type AgentDetail,
  type AgentSettingsSave,
  type PinSyncJob,
} from "@/lib/api/agents";
import { mutationResultSchema } from "@/lib/api/schemas";
import {
  formatSettingValue,
  settingChanges,
  type SettingSpec,
  type SettingValue,
} from "@/lib/settings/changes";
import { typedNumber } from "@/lib/settings/forms";
import type { AgentRow } from "@/lib/agents/rows";
import {
  formatPoolLimits,
  AgentStatusBadge,
  JobTargetLink,
  UpdateStatusBadge,
  withClientOnline,
} from "../agent-parts";
import { AgentAuditLog, TokenTheftAlert } from "./agent-audit-log";
import { AgentHostTools, type HostToolRow } from "./agent-host-tools";
import {
  InstallForm,
  InstallJobs,
  InstalledInstallables,
  type InstallJobRow,
  type InstallableRow,
} from "./agent-installables";
import { AgentNav } from "./agent-nav";
import {
  agentChanged,
  useAgentDetail,
  useAgentHostTools,
  useAgentInstallables,
} from "./agent-queries";
import { AGENT_TAB_LABELS, type AgentTab } from "./agent-tabs";

/** A status fact. `wide` takes the whole row on phone, where the grid has two columns. */
function Fact({
  label,
  wide,
  children,
}: {
  label: string;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={wide ? "fact agent-fact-wide" : "fact"}>
      <span className="fact-label">{label}</span>
      <div className="fact-value">{children}</div>
    </div>
  );
}

// ── Configuration ────────────────────────────────────────────────────────────

export interface ConfigDraft {
  /** Use the organization's max concurrency (stored as null). */
  inheritMaxConcurrency: boolean;
  /** The agent's own max concurrency, used unless it inherits. */
  maxConcurrency: string;
  /** Blank for the pool's default. */
  limits: Readonly<Record<string, string>>;
}

/**
 * The form for an agent. Inherited fields start from the organization's values, so overriding
 * starts from what the agent runs now.
 */
export function configDraft(agent: AgentRow): ConfigDraft {
  return {
    inheritMaxConcurrency: agent.overrides.maxConcurrency === null,
    maxConcurrency: String(agent.maxConcurrency),
    limits: Object.fromEntries(
      Object.entries(agent.poolLimits).map(([name, limit]) => [name, String(limit)]),
    ),
  };
}

/** The draft as compared and saved: null for inherited fields, blank limits null. */
function configValues(draft: ConfigDraft): Record<string, SettingValue> {
  return {
    maxConcurrency: draft.inheritMaxConcurrency ? null : typedNumber(draft.maxConcurrency),
    ...Object.fromEntries(
      POOLS.map((pool) => [pool, draft.limits[pool]?.trim() ? Number(draft.limits[pool]) : null]),
    ),
  };
}

/** What `updateAgentConfig` saves for the draft. */
export function configInput(draft: ConfigDraft): AgentConfigForm {
  const values = configValues(draft);
  return {
    maxConcurrency: values.maxConcurrency as number | null,
    // Blank limits use the default.
    poolLimits: Object.fromEntries(
      POOLS.filter((pool) => values[pool] !== null).map((pool) => [pool, values[pool] as number]),
    ),
  };
}

const poolLimitFormat = (value: SettingValue) =>
  value === null ? "Default" : formatSettingValue(value);

/** What an inherited setting shows: "Inherits 6 from the organization". */
export function inheritsText(value: string): string {
  return `Inherits ${value} from the organization`;
}

function configSpecs(defaults: AgentRow["defaults"]): SettingSpec[] {
  return [
    {
      key: "maxConcurrency",
      label: "Max concurrency",
      format: (value) =>
        value === null ? inheritsText(String(defaults.maxConcurrency)) : formatSettingValue(value),
    },
    ...POOLS.map((pool) => ({
      key: pool,
      label: `${pool[0]!.toUpperCase()}${pool.slice(1)} pool limit`,
      format: poolLimitFormat,
    })),
  ];
}

/**
 * A setting the agent inherits from the organization unless it overrides it. While inherited
 * it says "Inherits N from the organization" with an Override button; while overridden it shows
 * its controls and a button to inherit again. Switching moves focus to what replaced the button.
 */
function InheritableSetting({
  id,
  label,
  inherited,
  organizationValue,
  readOnly,
  onInheritChange,
  children,
}: {
  id: string;
  /** The setting's name, lowercased in the buttons' accessible names. */
  label: string;
  inherited: boolean;
  /** The organization's value, as words. */
  organizationValue: string;
  readOnly: boolean;
  onInheritChange: (inherit: boolean) => void;
  /** The agent's own value's controls, shown while it overrides. */
  children: React.ReactNode;
}) {
  const groupRef = React.useRef<HTMLDivElement>(null);
  const switched = React.useRef(false);
  React.useEffect(() => {
    if (!switched.current) return;
    switched.current = false;
    const target = inherited
      ? groupRef.current?.querySelector<HTMLElement>(`#${id}-override`)
      : groupRef.current?.querySelector<HTMLElement>(
          `.settings-inherit-controls :is(input, button, [role="checkbox"]):not(:disabled)`,
        );
    target?.focus();
  }, [id, inherited]);
  const change = (inherit: boolean) => {
    switched.current = true;
    onInheritChange(inherit);
  };
  const name = label.toLowerCase();

  return (
    <div ref={groupRef} className="settings-group" role="group" aria-labelledby={`${id}-label`}>
      <span id={`${id}-label`} className="settings-group-label">
        {label}
      </span>
      <div className="settings-inherit" data-inherited={inherited ? "" : undefined}>
        <Muted id={`${id}-source`} className="settings-inherit-text">
          {inherited
            ? `${inheritsText(organizationValue)}.`
            : `Overrides the organization's ${organizationValue}.`}
        </Muted>
        {!readOnly &&
          (inherited ? (
            <Button
              id={`${id}-override`}
              type="button"
              variant="secondary"
              size="sm"
              aria-label={`Override ${name}`}
              onClick={() => change(false)}
            >
              Override
            </Button>
          ) : (
            <Button
              id={`${id}-inherit`}
              type="button"
              variant="secondary"
              size="sm"
              aria-label={`Inherit ${name} from the organization`}
              onClick={() => change(true)}
            >
              Inherit
            </Button>
          ))}
      </div>
      {!inherited && <div className="settings-inherit-controls">{children}</div>}
    </div>
  );
}

// ── Heartbeat-deferred changes ───────────────────────────────────────────────

/** A saved change on its way to the agent: `pending` until a heartbeat after the save. */
export type Pickup = "pending" | "applied";

/**
 * Whether the agent has picked up a change saved at `savedAt`: a heartbeat after it got the
 * change in its response. Both times are the server's clock.
 */
export function pickupState(savedAt: string | null, lastHeartbeatAt: string | null): Pickup | null {
  if (savedAt === null) return null;
  return lastHeartbeatAt !== null && Date.parse(lastHeartbeatAt) > Date.parse(savedAt)
    ? "applied"
    : "pending";
}

/** The save footer's status after a save the agent picks up with its next heartbeat. */
export function PickupStatus({ state, agentName }: { state: Pickup; agentName: string }) {
  return state === "applied" ? (
    <>
      <IconCheck size={14} aria-hidden="true" />
      Applied
    </>
  ) : (
    <>
      <IconClock size={14} aria-hidden="true" className="settings-pickup-pending" />
      Saved — waiting for {agentName} to pick it up
    </>
  );
}

/** When the agent has picked up the last save: the save's `savedAt`, compared to its heartbeats. */
function usePickup(agent: Pick<AgentRow, "name" | "lastHeartbeatAt">) {
  const [savedAt, setSavedAt] = React.useState<string | null>(null);
  const state = pickupState(savedAt, agent.lastHeartbeatAt);
  return {
    onSaved: setSavedAt,
    status: state ? <PickupStatus state={state} agentName={agent.name} /> : undefined,
  };
}

/** Where an "Update now" stands, as the agent reports it. */
export interface UpdateProgress {
  stage: "requested" | "updating" | "updated" | "failed";
  text: string;
}

const UPDATE_STEP_TEXT = {
  draining: "letting its running jobs finish",
  installing: "installing it",
  confirming: "restarting on it",
} as const;

/** "Update now" to `version`: requested → updating → updated (or failed), from the agent's reports. */
export function updateProgress(
  agent: Pick<AgentRow, "name" | "version" | "update" | "failedVersions" | "updateRequest">,
  version: string,
): UpdateProgress {
  const { name, update } = agent;
  if (agent.updateRequest?.version === version) {
    return {
      stage: "requested",
      text: `Update to ${version} requested; ${name} starts it with its next heartbeat.`,
    };
  }
  const busy = update !== null && update.state !== "idle";
  if (!busy && agent.version === version) {
    return { stage: "updated", text: `${name} updated to ${version}.` };
  }
  if (agent.failedVersions.includes(version) || (!busy && update?.error)) {
    return {
      stage: "failed",
      text: `Update to ${version} failed${update?.error ? `: ${update.error}` : "."}`,
    };
  }
  if (busy && update.state !== "idle") {
    return {
      stage: "updating",
      text: `${name} is updating to ${version}: ${UPDATE_STEP_TEXT[update.state]}.`,
    };
  }
  return { stage: "updating", text: `${name} is updating to ${version}.` };
}

function UpdateProgressNote({ progress }: { progress: UpdateProgress }) {
  return (
    <Muted
      role="status"
      data-update-stage={progress.stage}
      className={progress.stage === "failed" ? "agent-update-failed" : undefined}
    >
      {progress.text}
    </Muted>
  );
}

/** The organization's desired version as words, for "Inherits N from the organization". */
function organizationVersionText(globalDesiredVersion: string | null): string {
  return globalDesiredVersion ?? "no version";
}

function versionSpec(globalDesiredVersion: string | null): SettingSpec {
  return {
    key: "versionOverride",
    label: "Desired version",
    format: (value) =>
      value === null
        ? inheritsText(organizationVersionText(globalDesiredVersion))
        : value === ""
          ? "Empty"
          : formatSettingValue(value),
  };
}

export interface VersionDraft {
  /** Use the organization's desired version (no override, stored as null). */
  inherit: boolean;
  /** The agent's own desired version, used unless it inherits. */
  version: string;
}

export function versionDraft(agent: Pick<AgentRow, "desiredVersionOverride">): VersionDraft {
  return {
    inherit: agent.desiredVersionOverride === null,
    version: agent.desiredVersionOverride ?? "",
  };
}

/** The version as compared: null while inherited, else the trimmed override. */
function versionValue(draft: VersionDraft): string | null {
  return draft.inherit ? null : draft.version.trim();
}

/**
 * What `setAgentDesiredVersion` saves for the draft ("" clears the override), or an error
 * when the override isn't a version.
 */
export function versionInput(draft: VersionDraft): { version: string } | { error: string } {
  const version = versionValue(draft);
  if (version === null) return { version: "" };
  if (!AgentVersion.safeParse(version.replace(/^v(?=\d)/, "")).success) {
    return { error: "Enter a version like 2.0.0, or inherit the organization's." };
  }
  return { version };
}

/**
 * The agent's central settings, saved together: concurrency and pool limits and its
 * desired version override. They reach the agent with its next heartbeat. Pinned
 * repositories are edited from each repository's settings (the overview lists them).
 */
export function AgentSettingsSection({
  agent,
  globalDesiredVersion,
}: {
  agent: AgentRow;
  globalDesiredVersion: string | null;
}) {
  const apiAction = useApiAction();
  const pickup = usePickup(agent);
  // Seeded from the (polled) agent; a refetch re-seeds them only while they aren't edited.
  const [draft, setDraft] = useSeededDraft(configDraft(agent));
  const saved = configDraft(agent);
  const savedVersion = versionDraft(agent);
  const [version, setVersion] = useSeededDraft(savedVersion);
  const [versionError, setVersionError] = React.useState<string | undefined>();

  const { defaults } = agent;
  const readOnly = agent.revoked;
  const maxConcurrency = draft.inheritMaxConcurrency
    ? defaults.maxConcurrency
    : Number(draft.maxConcurrency);
  const slots = maxConcurrency >= 1 ? Math.floor(maxConcurrency) : 1;
  const specs = React.useMemo(
    () => [...configSpecs(defaults), versionSpec(globalDesiredVersion)],
    [defaults, globalDesiredVersion],
  );
  const values = (config: ConfigDraft, versionDraft: VersionDraft) => ({
    ...configValues(config),
    versionOverride: versionValue(versionDraft),
  });
  const changes = settingChanges(specs, values(saved, savedVersion), values(draft, version));

  const prepare = () => {
    const changed = new Set(changes.map((change) => change.key));
    const versionSave = changed.has("versionOverride") ? versionInput(version) : null;
    if (versionSave && "error" in versionSave) {
      setVersionError(versionSave.error);
      return null;
    }
    setVersionError(undefined);
    const configChanged = [...changed].some((key) => key !== "versionOverride");
    const body: AgentSettingsSave = {
      ...(configChanged && { config: configInput(draft) }),
      ...(versionSave && { version: versionSave.version }),
    };
    return {
      // One request; the page refetches once, after it.
      action: () =>
        apiAction(
          ({ organizationId }) =>
            api.put(`/api/ui/agents/${agent.id}/settings`, agentSavedSchema, {
              body,
              organizationId,
            }),
          agentChanged,
          (result) => pickup.onSaved(result.savedAt),
        ),
      success: "Saved. The agent picks it up with its next heartbeat.",
    };
  };

  return (
    <SettingsSection
      id="agent-settings"
      title="Settings"
      showTitle={false}
      description="Central settings, returned to the agent in every heartbeat response (every 20 seconds). Concurrency and the version are inherited from the organization (Settings › Agent defaults) unless you override them here."
      changes={changes}
      prepare={prepare}
      onDiscard={() => {
        setDraft(saved);
        setVersion(savedVersion);
        setVersionError(undefined);
      }}
      confirm={{
        consequence:
          "The agent picks these up with its next heartbeat (within 20 seconds). Running jobs aren't cancelled; it takes new jobs by the new limits.",
      }}
      readOnly={readOnly}
      savedStatus={pickup.status}
    >
      <SettingsSubsection
        id="agent-concurrency"
        title="Concurrency"
        description="How many jobs the agent runs at once, and how many of them each pool may take."
      >
        <InheritableSetting
          id="max-concurrency-source"
          label="Max concurrency"
          inherited={draft.inheritMaxConcurrency}
          organizationValue={String(defaults.maxConcurrency)}
          readOnly={readOnly}
          onInheritChange={(inherit) => setDraft((d) => ({ ...d, inheritMaxConcurrency: inherit }))}
        >
          <div className="settings-row">
            <Field
              label="Jobs at once"
              htmlFor="max-concurrency"
              description="Jobs the agent runs at once (1–32)."
            >
              <Input
                id="max-concurrency"
                type="number"
                className="input-number"
                min={1}
                max={32}
                required
                disabled={readOnly}
                value={draft.maxConcurrency}
                onChange={(e) => setDraft((d) => ({ ...d, maxConcurrency: e.target.value }))}
              />
            </Field>
          </div>
        </InheritableSetting>
        <div className="settings-group" role="group" aria-labelledby="pool-limits-label">
          <span id="pool-limits-label" className="settings-group-label">
            Concurrency per pool
          </span>
          <Muted>
            Caps how many of the agent&apos;s slots a pool&apos;s jobs may take (1 to the max
            concurrency): <InlineCode>short</InlineCode> holds query and review tasks,{" "}
            <InlineCode>long</InlineCode> coding tasks. Leave it empty for the default: long leaves
            one slot free for other work; short may use every slot. Lowering a limit doesn&apos;t
            cancel running jobs; the agent takes no new ones until it is under the limit.
          </Muted>
          <div className="settings-row">
            {POOLS.map((pool) => (
              <Field
                key={pool}
                label={`${pool[0]!.toUpperCase()}${pool.slice(1)} pool`}
                htmlFor={`limit-${pool}`}
                description={`Default: ${defaultPoolLimit(pool, slots)}. Effective now: ${agent.effectivePoolLimits[pool] ?? "unknown"}.`}
              >
                <Input
                  id={`limit-${pool}`}
                  type="number"
                  className="input-number-wide"
                  min={1}
                  max={slots}
                  placeholder={`Default (${defaultPoolLimit(pool, slots)})`}
                  disabled={readOnly}
                  value={draft.limits[pool] ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, limits: { ...d.limits, [pool]: e.target.value } }))
                  }
                />
              </Field>
            ))}
          </div>
        </div>
      </SettingsSubsection>

      <SettingsSubsection
        id="agent-version"
        title="Version"
        description={
          agent.selfUpdate === "supported"
            ? "This agent runs under pm2 and updates itself: it stops taking jobs, lets running ones finish (up to 2 hours), installs the desired version and restarts. A version that doesn't stay up is rolled back and not tried again here unless you use Update now, which also updates to the latest on npm when no version is chosen."
            : "This agent can't update itself (it isn't running under pm2, or its version predates self-update). Install the desired version on the host."
        }
      >
        <InheritableSetting
          id="desired-version-source"
          label="Desired version"
          inherited={version.inherit}
          organizationValue={organizationVersionText(globalDesiredVersion)}
          readOnly={readOnly}
          onInheritChange={(inherit) => {
            setVersionError(undefined);
            setVersion((v) => ({ ...v, inherit }));
          }}
        >
          <Field
            label="Version"
            htmlFor="desired-version"
            description="Semver, e.g. 2.0.0. The organization's version is set in Settings › Agent defaults."
            error={versionError}
          >
            <Input
              id="desired-version"
              placeholder="e.g. 2.0.0"
              disabled={readOnly}
              value={version.version}
              onChange={(e) => {
                setVersionError(undefined);
                setVersion((v) => ({ ...v, version: e.target.value }));
              }}
              className="settings-mono input-number-wide"
            />
          </Field>
        </InheritableSetting>
        {agent.selfUpdate === "supported" && !readOnly && <UpdateNow agent={agent} />}
      </SettingsSubsection>
    </SettingsSection>
  );
}

/** "Update now", then where the update stands as the agent reports it (requested → updating → updated or failed). */
function UpdateNow({ agent }: { agent: AgentRow }) {
  // The version this page asked for; else a pending request made elsewhere.
  const [requested, setRequested] = React.useState<string | null>(null);
  const update = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      api.post(`/api/ui/agents/${agent.id}/update`, agentUpdateRequestedSchema, {
        organizationId,
      }),
    invalidate: agentChanged,
    success: `${agent.name} will update with its next heartbeat.`,
    onSuccess: (result) => setRequested(result.version),
  });
  const version = requested ?? agent.updateRequest?.version ?? null;
  return (
    <>
      <div>
        <Button
          type="button"
          variant="secondary"
          disabled={update.isPending}
          title="Update to the saved desired version (the latest on npm when none is set) with the next heartbeat, even if it failed here before."
          onClick={() => update.mutate()}
        >
          <IconCloudDownload size={14} />
          {update.isPending ? "Requesting…" : "Update now"}
        </Button>
      </div>
      {version && <UpdateProgressNote progress={updateProgress(agent, version)} />}
    </>
  );
}

/** Each pinned repository's pre-clone (its latest `repo.sync` job), live. */
function PinSyncList({
  repositories,
  syncJobs,
}: {
  repositories: AgentRow["pinnedRepositories"];
  syncJobs: ReadonlyMap<string, PinSyncJob>;
}) {
  return (
    <ul className="agent-pin-syncs" aria-label="Pre-clones of the pinned repositories">
      {repositories.map((repo) => {
        const job = syncJobs.get(repo.id);
        return (
          <li key={repo.id} data-pin-sync={repo.fullPath}>
            <span className="font-mono text-sm">{repo.fullPath}</span>
            {job ? (
              <>
                <JobStatusBadge job={job} />
                {job.error && <Muted>{job.error}</Muted>}
              </>
            ) : (
              <Muted>No sync in the last 7 days</Muted>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Where a configuration value comes from, after the value. */
function ConfigSource({ override }: { override: boolean }) {
  return <span className="fact-secondary">{override ? "(override)" : "(organization)"}</span>;
}

// ── Installables ─────────────────────────────────────────────────────────────

export function InstallablesSection({
  agent,
  installables,
  installJobs,
}: {
  agent: AgentRow;
  installables: InstallableRow[];
  installJobs: InstallJobRow[];
}) {
  return (
    <SettingsPanel
      id="agent-installables"
      title="Installables"
      showTitle={false}
      description="npm packages that add commands, MCP servers and skills to this host, as reported in its last heartbeat. Installing or updating one runs on the agent, which refuses packages its local allowlist doesn't allow."
    >
      <SettingsSubsection
        id="installables-installed"
        className="settings-sub-wide"
        title="Installed"
      >
        <InstalledInstallables installables={installables} />
      </SettingsSubsection>
      <SettingsSubsection
        id="installables-jobs"
        className="settings-sub-wide"
        title="Installs in the last 24 hours"
      >
        <InstallJobs jobs={installJobs} />
      </SettingsSubsection>
      {!agent.revoked && (
        <SettingsSubsection
          id="installables-install"
          title="Install or update"
          description="Starts an install job on this agent; it picks it up with its next claim."
        >
          <InstallForm agentId={agent.id} installJobs={installJobs} />
        </SettingsSubsection>
      )}
    </SettingsPanel>
  );
}

/** A table's rows while the tab first loads. */
function TableSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Stack gap={3}>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} width={`${60 + ((index * 17) % 35)}%`} />
      ))}
    </Stack>
  );
}

/** The Installables tab: its own query (installables and install jobs), live. */
function InstallablesTab({ agent }: { agent: AgentRow }) {
  const query = useAgentInstallables(agent.id);
  return (
    <QueryBoundary query={query} skeleton={<TableSkeleton />} what="installables">
      {(data) => (
        <InstallablesSection
          agent={agent}
          installables={data.installables}
          installJobs={data.installJobs}
        />
      )}
    </QueryBoundary>
  );
}

// ── Host tools ───────────────────────────────────────────────────────────────

function hostToolPaths(hostTools: readonly HostToolRow[]): Record<string, string> {
  return Object.fromEntries(hostTools.map((tool) => [tool.hostToolId, tool.configuredPath ?? ""]));
}

const pathFormat = (value: SettingValue) =>
  value === "" ? "Discover on PATH" : formatSettingValue(value);

/**
 * The configured paths of the agent's host tools, saved together like the Settings tab. They
 * are settings of the agent, not a list to add to or delete from: the catalog (Settings ›
 * Agent defaults) holds the tools, and every path reaches the agent with the same heartbeat,
 * so one save with a change list and Discard fits better than a save per row.
 */
export function HostToolsSection({
  agent,
  hostTools,
}: {
  agent: AgentRow;
  hostTools: HostToolRow[];
}) {
  const apiAction = useApiAction();
  const pickup = usePickup(agent);
  const saved = hostToolPaths(hostTools);
  const [paths, setPaths] = useSeededDraft(saved);
  const specs = React.useMemo(
    () =>
      hostTools.map((tool): SettingSpec => ({
        key: tool.hostToolId,
        label: `${tool.name} path`,
        format: pathFormat,
      })),
    [hostTools],
  );
  const trimmed = (all: Record<string, string>) =>
    Object.fromEntries(Object.entries(all).map(([id, path]) => [id, path.trim()]));
  const changes = settingChanges(specs, trimmed(saved), trimmed(paths));

  return (
    <SettingsSection
      id="agent-host-tools"
      title="Host tools"
      showTitle={false}
      description={
        <>
          Software installed on this host by hand. A configured path wins over the one the agent
          discovers on its <InlineCode>PATH</InlineCode>, even when it doesn&apos;t exist: the tool
          is then unavailable. Leave it blank to use the discovered one. The agent gets a new path
          with its next heartbeat and reports on it with the one after; it refuses paths its local{" "}
          <InlineCode>blockedExecPaths</InlineCode> covers.
        </>
      }
      changes={changes}
      prepare={() => {
        const body = {
          paths: changes.map((change) => ({
            hostToolId: change.key,
            path: paths[change.key] ?? "",
          })),
        };
        return {
          // One request; the page refetches once, after it.
          action: () =>
            apiAction(
              ({ organizationId }) =>
                api.put(`/api/ui/agents/${agent.id}/host-tools`, agentSavedSchema, {
                  body,
                  organizationId,
                }),
              agentChanged,
              (result) => pickup.onSaved(result.savedAt),
            ),
          success: "Saved. The agent gets the paths with its next heartbeat.",
        };
      }}
      onDiscard={() => setPaths(saved)}
      readOnly={agent.revoked || hostTools.length === 0}
      savedStatus={pickup.status}
    >
      <SettingsSubsection id="host-tools-paths" className="settings-sub-wide" title="Paths">
        <AgentHostTools
          revoked={agent.revoked}
          hostTools={hostTools}
          paths={paths}
          onPathChange={(id, path) => setPaths((all) => ({ ...all, [id]: path }))}
        />
      </SettingsSubsection>
    </SettingsSection>
  );
}

/** The Host tools tab: its own query (the catalog with this agent's paths and reports), live. */
function HostToolsTab({ agent }: { agent: AgentRow }) {
  const query = useAgentHostTools(agent.id);
  return (
    <QueryBoundary query={query} skeleton={<TableSkeleton />} what="host tools">
      {(data) => <HostToolsSection agent={agent} hostTools={data.hostTools} />}
    </QueryBoundary>
  );
}

// ── Danger zone ───────────────────────────────────────────────────────────────

/**
 * Revoking or deleting the agent. Both leave its pages for the agent list, once the
 * change succeeded and the list was refetched (`useApiMutation` awaits the invalidation).
 */
function useLeaveAgent(agent: AgentRow, action: "revoke" | "delete") {
  const router = useRouter();
  return useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      action === "revoke"
        ? api.post(`/api/ui/agents/${agent.id}/revoke`, mutationResultSchema, {
            organizationId,
          })
        : api.delete(`/api/ui/agents/${agent.id}`, mutationResultSchema, { organizationId }),
    // The list (and the jobs and repositories it touched); this agent's detail goes with the page.
    invalidate: (keys) => [keys.agents.lists, keys.jobs.all, keys.repositories.all],
    success: `${action === "revoke" ? "Revoked" : "Deleted"} ${agent.name}`,
    onSuccess: () => router.push("/agents"),
  });
}

function RevokeSubsection({ agent }: { agent: AgentRow }) {
  const revoke = useLeaveAgent(agent, "revoke");
  return (
    <SettingsSubsection
      id="agent-revoke"
      title="Revoke"
      description={
        <>
          Revoking is immediate: the agent&apos;s access, refresh and job tokens stop working on its
          next request, its running jobs are redelivered to other agents and its pins are removed.
          To use the host again, enroll it as a new agent.
        </>
      }
    >
      <div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="danger" disabled={revoke.isPending}>
              <IconBan size={14} />
              {revoke.isPending ? "Revoking…" : "Revoke agent"}
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
              <AlertDialogAction variant="danger" onClick={() => revoke.mutate()}>
                Revoke
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </SettingsSubsection>
  );
}

function DeleteSubsection({ agent }: { agent: AgentRow }) {
  const remove = useLeaveAgent(agent, "delete");
  return (
    <SettingsSubsection
      id="agent-delete"
      title="Delete"
      description={`Deleting removes the agent from the Agents pages for good${agent.revoked ? "." : ", revoking it first."}`}
    >
      <div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="danger" disabled={remove.isPending}>
              <IconTrash size={14} />
              {remove.isPending ? "Deleting…" : "Delete agent"}
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
              <AlertDialogAction variant="danger" onClick={() => remove.mutate()}>
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </SettingsSubsection>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function DangerZone({ agent }: { agent: AgentRow }) {
  return (
    <SettingsPanel
      id="agent-danger"
      title="Danger zone"
      tone="danger"
      description="Revoking and deleting can't be undone."
    >
      {!agent.revoked && <RevokeSubsection agent={agent} />}
      <DeleteSubsection agent={agent} />
    </SettingsPanel>
  );
}

/** The Overview tab's status facts, live: heartbeat age (on the browser's clock), version, jobs, pins. */
function StatusCard({
  agent,
  pinSyncJobs,
  now,
}: {
  agent: AgentRow;
  pinSyncJobs: readonly PinSyncJob[];
  now: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Status</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="agent-status-grid">
          <Fact label="Last heartbeat">
            {agent.lastHeartbeatAt ? (
              <Timestamp iso={agent.lastHeartbeatAt} now={now} inline />
            ) : (
              "Never"
            )}
          </Fact>
          <Fact label="Version">
            {agent.version ? (
              <span className="text-numeric" data-agent-version>
                {agent.version}
              </span>
            ) : (
              "Unknown"
            )}
          </Fact>
          <Fact label="Desired version">
            {agent.desiredVersion ? (
              <>
                <span className="text-numeric">{agent.desiredVersion}</span>{" "}
                <span className="fact-secondary">
                  {agent.desiredVersionOverride
                    ? "(override)"
                    : agent.tracksLatest
                      ? "(latest on npm)"
                      : "(organization)"}
                </span>
              </>
            ) : agent.tracksLatest ? (
              "Latest on npm (not read yet)"
            ) : (
              "Not set"
            )}
          </Fact>
          <Fact label="Update status">
            <Stack gap={1}>
              <div>
                <UpdateStatusBadge agent={agent} />
              </div>
              {agent.updateRequest && (
                <UpdateProgressNote progress={updateProgress(agent, agent.updateRequest.version)} />
              )}
              {agent.update?.error && <Muted>{agent.update.error}</Muted>}
            </Stack>
          </Fact>
          <Fact label="Failed versions">
            {agent.failedVersions.length > 0 ? (
              <span className="text-numeric">{agent.failedVersions.join(", ")}</span>
            ) : (
              "None"
            )}
          </Fact>
          <Fact label="Running jobs" wide>
            <Stack gap={1}>
              <span>
                {agent.runningJobs.length} / {agent.maxConcurrency}{" "}
                <ConfigSource override={agent.overrides.maxConcurrency !== null} />
              </span>
              {agent.runningJobs.map((job) => (
                <JobTargetLink key={job.id} job={job} />
              ))}
            </Stack>
          </Fact>
          <Fact label="Concurrency per pool">{formatPoolLimits(agent.effectivePoolLimits)}</Fact>
          <Fact label="Pinned repositories" wide>
            {agent.pinnedRepositories.length > 0 ? (
              <PinSyncList
                repositories={agent.pinnedRepositories}
                syncJobs={new Map(pinSyncJobs.map((job) => [job.repositoryId, job]))}
              />
            ) : (
              "None"
            )}
          </Fact>
          <Fact label="Enrolled">
            <Timestamp iso={agent.createdAt} inline />
          </Fact>
        </div>
      </CardContent>
    </Card>
  );
}

/** A tab's content while the agent first loads: its header line and a card of facts. */
function DetailSkeleton() {
  return (
    <Card>
      <CardContent>
        <div className="agent-status-grid">
          {Array.from({ length: 6 }, (_, index) => (
            <div key={index} className="fact">
              <Skeleton width="40%" />
              <Skeleton width={`${50 + ((index * 13) % 40)}%`} />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function AgentTabContent({ tab, detail }: { tab: AgentTab; detail: AgentDetail }) {
  const now = useNow();
  const agent = withClientOnline(detail.agent, now);
  return (
    <>
      <TokenTheftAlert audit={detail.audit} />
      {agent.revoked && agent.revokedAt && (
        <Alert variant="warning">
          <AlertTitle as="h2">Revoked</AlertTitle>
          <AlertDescription>
            This agent was revoked <Timestamp iso={agent.revokedAt} inline />. Its configuration can
            no longer be changed.
          </AlertDescription>
        </Alert>
      )}

      <div className="settings-sections">
        {tab === "overview" && (
          <>
            <StatusCard agent={agent} pinSyncJobs={detail.pinSyncJobs} now={now} />

            <Card>
              <CardHeader>
                <CardTitle as="h2">Audit log</CardTitle>
                <CardDescription>
                  The 50 most recent security events for this agent.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <AgentAuditLog audit={detail.audit} />
              </CardContent>
            </Card>

            <DangerZone agent={agent} />
          </>
        )}
        {tab === "settings" && (
          <AgentSettingsSection agent={agent} globalDesiredVersion={detail.globalDesiredVersion} />
        )}
        {tab === "installables" && <InstallablesTab agent={agent} />}
        {tab === "host-tools" && <HostToolsTab agent={agent} />}
      </div>
    </>
  );
}

/**
 * An agent's tab (Overview, Settings, Installables or Host tools), live: the agent polls
 * (`GET /api/ui/agents/{id}`), and the Installables and Host tools tabs poll their own
 * part. An agent of another of the user's organizations switches to it first.
 */
export function AgentDetailView({ tab }: { tab: AgentTab }) {
  const { id } = useParams<{ id: string }>();
  const detail = useAgentDetail(id);
  const name = detail.data?.agent.name;
  return (
    <>
      <AppHeader
        breadcrumbs={[
          { label: "Agents", href: "/agents" },
          { label: name ?? "Agent" },
          { label: AGENT_TAB_LABELS[tab] },
        ]}
      />
      <div className="detail-main">
        <PageHeader
          title={name ?? <Skeleton width="12rem" height="1.75rem" />}
          meta={
            detail.data && (
              <>
                <AgentStatus agent={detail.data.agent} />
                <Freshness query={detail} />
              </>
            )
          }
        />
        <AgentNav agentId={id} current={tab} />
        <QueryBoundary query={detail} skeleton={<DetailSkeleton />} what="the agent">
          {(data) => <AgentTabContent tab={tab} detail={data} />}
        </QueryBoundary>
      </div>
    </>
  );
}

/** Online or offline against the browser's ticking clock. */
function AgentStatus({ agent }: { agent: AgentRow }) {
  return <AgentStatusBadge agent={withClientOnline(agent, useNow())} />;
}
