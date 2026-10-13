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
  Stack,
} from "@iamthemcmaster/ui";
import { IconBan, IconCloudDownload, IconTrash } from "@tabler/icons-react";
import { defaultPoolLimit } from "@omniralph/shared";
import { POOLS, TASK_TYPES } from "@omniralph/tasks";
import { AppHeader } from "@/components/app-header";
import { Timestamp } from "@/components/list-table";
import { PageHeader } from "@/components/page-header";
import { MultiSelect, type MultiSelectOption } from "@/components/pickers";
import {
  saveInOrder,
  SettingsPanel,
  SettingsSection,
  SettingsSubsection,
} from "@/components/settings-section";
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
import {
  deleteHarness,
  pinRepository,
  requestHarnessUpdate,
  revokeHarness,
  searchPinnableRepositories,
  setHarnessDesiredVersion,
  setHostToolPath,
  unpinRepository,
  updateHarnessConfig,
  type HarnessConfigForm,
  type PinnableRepository,
} from "../actions";
import {
  formatPoolLimits,
  HarnessStatusBadge,
  JobTargetLink,
  TaskTypeBadges,
  UpdateStatusBadge,
} from "../harness-parts";
import { HarnessAuditLog, TokenTheftAlert, type AuditRow } from "./harness-audit-log";
import { HarnessHostTools, type HostToolRow } from "./harness-host-tools";
import {
  InstallForm,
  InstallJobs,
  InstalledInstallables,
  type InstallJobRow,
  type InstallableRow,
} from "./harness-installables";
import { HarnessNav } from "./harness-nav";
import { HARNESS_TAB_LABELS, type HarnessTab } from "./harness-tabs";

interface HarnessDetailViewProps {
  tab: HarnessTab;
  harness: HarnessRow;
  now: number;
  audit: AuditRow[];
  /** The installables the harness reported in its last heartbeat. */
  installables: InstallableRow[];
  /** `install` jobs targeted at the harness in the last 24 hours, newest first (Installables tab). */
  installJobs: InstallJobRow[];
  /** Every host tool of the organization's catalog with this harness's path and report, by name (Host tools tab). */
  hostTools: HostToolRow[];
  /** Settings › Harness defaults version (described when it tracks npm's latest), used when the harness has no override. */
  globalDesiredVersion: string | null;
}

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
    <div className={wide ? "fact harness-fact-wide" : "fact"}>
      <span className="fact-label">{label}</span>
      <div className="fact-value">{children}</div>
    </div>
  );
}

// ── Configuration ────────────────────────────────────────────────────────────

/** What each task type the harness may accept runs. */
const TASK_TYPE_HINTS: Record<(typeof TASK_TYPES)[number], string> = {
  query: "Read-only questions: replies, code questions, learned rules, triage.",
  review: "Pull request reviews.",
  coding: "Coding tasks that change code and push it.",
};

const TASK_TYPE_LABELS: Record<(typeof TASK_TYPES)[number], string> = {
  query: "Query",
  review: "Review",
  coding: "Coding",
};

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

/** Task types as the form words them: "Query, Review and Coding", "None". */
function taskTypeList(taskTypes: readonly string[]): string {
  return taskTypes.length === 0
    ? "None"
    : listFormat.format(
        taskTypes.map((t) => TASK_TYPE_LABELS[t as (typeof TASK_TYPES)[number]] ?? t),
      );
}

export interface ConfigDraft {
  /** Use the organization's max concurrency (stored as null). */
  inheritMaxConcurrency: boolean;
  /** The harness's own max concurrency, used unless it inherits. */
  maxConcurrency: string;
  /** Use the organization's task types (stored as null). */
  inheritTaskTypes: boolean;
  /** The harness's own task types, used unless it inherits. */
  taskTypes: readonly string[];
  /** Blank for the pool's default. */
  limits: Readonly<Record<string, string>>;
}

/**
 * The form for a harness. Inherited fields start from the organization's values, so turning
 * "Use organization default" off overrides from what the harness runs now.
 */
export function configDraft(harness: HarnessRow): ConfigDraft {
  return {
    inheritMaxConcurrency: harness.overrides.maxConcurrency === null,
    maxConcurrency: String(harness.maxConcurrency),
    inheritTaskTypes: harness.overrides.acceptedTaskTypes === null,
    taskTypes: harness.acceptedTaskTypes.filter((t) =>
      (TASK_TYPES as readonly string[]).includes(t),
    ),
    limits: Object.fromEntries(
      Object.entries(harness.poolLimits).map(([name, limit]) => [name, String(limit)]),
    ),
  };
}

/**
 * The draft as compared and saved: null for inherited fields, task types in their listed
 * order, blank limits null.
 */
function configValues(draft: ConfigDraft): Record<string, SettingValue> {
  return {
    maxConcurrency: draft.inheritMaxConcurrency ? null : typedNumber(draft.maxConcurrency),
    acceptedTaskTypes: draft.inheritTaskTypes
      ? null
      : TASK_TYPES.filter((t) => draft.taskTypes.includes(t)),
    ...Object.fromEntries(
      POOLS.map((pool) => [pool, draft.limits[pool]?.trim() ? Number(draft.limits[pool]) : null]),
    ),
  };
}

/** What `updateHarnessConfig` saves for the draft. */
export function configInput(draft: ConfigDraft): HarnessConfigForm {
  const values = configValues(draft);
  return {
    maxConcurrency: values.maxConcurrency as number | null,
    acceptedTaskTypes:
      values.acceptedTaskTypes === null ? null : [...(values.acceptedTaskTypes as string[])],
    // Blank limits use the default.
    poolLimits: Object.fromEntries(
      POOLS.filter((pool) => values[pool] !== null).map((pool) => [pool, values[pool] as number]),
    ),
  };
}

const poolLimitFormat = (value: SettingValue) =>
  value === null ? "Default" : formatSettingValue(value);

function configSpecs(defaults: HarnessRow["defaults"]): SettingSpec[] {
  return [
    {
      key: "maxConcurrency",
      label: "Max concurrency",
      format: (value) =>
        value === null
          ? `Organization default (${defaults.maxConcurrency})`
          : formatSettingValue(value),
    },
    {
      key: "acceptedTaskTypes",
      label: "Accepted task types",
      format: (value) =>
        value === null
          ? `Organization default (${taskTypeList(defaults.acceptedTaskTypes)})`
          : taskTypeList(value as readonly string[]),
    },
    ...POOLS.map((pool) => ({
      key: pool,
      label: `${pool[0]!.toUpperCase()}${pool.slice(1)} pool limit`,
      format: poolLimitFormat,
    })),
  ];
}

/** The "Use organization default" switch of a field. */
function InheritCheck({
  id,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  onChange: (inherit: boolean) => void;
}) {
  return (
    <div className="settings-check settings-check-center">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <Label htmlFor={id}>Use organization default</Label>
      <Muted>Settings › Harnesses; follows it when it changes.</Muted>
    </div>
  );
}

const PROVIDER_LABELS: Record<PinnableRepository["provider"], string> = {
  github: "GitHub",
  gitlab: "GitLab",
};

function repositoryOption(repo: PinnableRepository): MultiSelectOption {
  return { value: repo.id, label: repo.fullPath, hint: PROVIDER_LABELS[repo.provider] };
}

/** The repositories matching a search, for the pins picker; a failed search shows its error. */
async function searchRepositoryOptions(query: string): Promise<MultiSelectOption[]> {
  const result = await searchPinnableRepositories(query);
  if (!result.ok) throw new Error(result.error);
  return (result.repositories ?? []).map(repositoryOption);
}

const VERSION_SPEC: SettingSpec = {
  key: "versionOverride",
  label: "Desired version override",
  format: (value) =>
    value === "" ? "Not set (organization's version)" : formatSettingValue(value),
};

function pinSpec(labels: ReadonlyMap<string, string>): SettingSpec {
  return {
    key: "pinnedRepositoryIds",
    label: "Pinned repositories",
    format: (value) =>
      Array.isArray(value) && value.length > 0
        ? value.map((id) => labels.get(id) ?? id).join(", ")
        : "None",
  };
}

/** What pinning says about the repositories the harness serves. */
function pinsDescription(count: number): string {
  if (count === 0) {
    return "None: this harness serves every repository that isn't pinned elsewhere. Jobs for a pinned repository only go to the harnesses it's pinned to, which pre-clone it.";
  }
  const repos = count === 1 ? "this repository" : `these ${count} repositories`;
  return `Jobs for ${repos} only go to the harnesses they're pinned to; this harness pre-clones them.`;
}

/**
 * The harness's central settings, saved together: concurrency and pool limits, task types,
 * pinned repositories and its desired version override. They reach the harness with its next
 * heartbeat.
 */
export function HarnessSettingsSection({
  harness,
  globalDesiredVersion,
}: {
  harness: HarnessRow;
  globalDesiredVersion: string | null;
}) {
  const { pending, run } = useAction();
  const saved = React.useMemo(() => configDraft(harness), [harness]);
  const [draft, setDraft] = React.useState(saved);
  const savedOverride = harness.desiredVersionOverride ?? "";
  const [override, setOverride] = React.useState(savedOverride);
  const savedPins = React.useMemo(
    () => harness.pinnedRepositories.map((repo) => repo.id),
    [harness.pinnedRepositories],
  );
  const [pins, setPins] = React.useState<string[]>(savedPins);
  const pinnedOptions = React.useMemo(
    () => harness.pinnedRepositories.map(repositoryOption),
    [harness.pinnedRepositories],
  );
  // Repository paths by id, for the change list: the saved pins and every search result.
  const [labels, setLabels] = React.useState<ReadonlyMap<string, string>>(
    () => new Map(pinnedOptions.map((option) => [option.value, option.label])),
  );
  const search = React.useCallback(async (query: string) => {
    const options = await searchRepositoryOptions(query);
    setLabels((known) => {
      const next = new Map(known);
      for (const option of options) next.set(option.value, option.label);
      return next;
    });
    return options;
  }, []);

  const { defaults } = harness;
  const readOnly = harness.revoked;
  const maxConcurrency = draft.inheritMaxConcurrency
    ? defaults.maxConcurrency
    : Number(draft.maxConcurrency);
  const slots = maxConcurrency >= 1 ? Math.floor(maxConcurrency) : 1;
  const taskTypes = draft.inheritTaskTypes ? defaults.acceptedTaskTypes : draft.taskTypes;
  const specs = React.useMemo(
    () => [...configSpecs(defaults), VERSION_SPEC, pinSpec(labels)],
    [defaults, labels],
  );
  const values = (config: ConfigDraft, version: string, pinned: readonly string[]) => ({
    ...configValues(config),
    versionOverride: version.trim(),
    // The saved pins come back in path order: compare them as a set.
    pinnedRepositoryIds: [...pinned].sort(),
  });
  const changes = settingChanges(
    specs,
    values(saved, savedOverride, savedPins),
    values(draft, override, pins),
  );

  const toggle = (taskType: string, on: boolean) =>
    setDraft((d) => ({
      ...d,
      taskTypes: TASK_TYPES.filter((t) => (t === taskType ? on : d.taskTypes.includes(t))),
    }));

  const prepare = () => {
    const changed = new Set(changes.map((change) => change.key));
    const configChanged = [...changed].some(
      (key) => key !== "versionOverride" && key !== "pinnedRepositoryIds",
    );
    const added = pins.filter((id) => !savedPins.includes(id));
    const removed = savedPins.filter((id) => !pins.includes(id));
    return {
      action: () =>
        saveInOrder([
          ...(configChanged ? [() => updateHarnessConfig(harness.id, configInput(draft))] : []),
          ...(changed.has("versionOverride")
            ? [() => setHarnessDesiredVersion(harness.id, override)]
            : []),
          ...removed.map((id) => () => unpinRepository(harness.id, id)),
          ...added.map((id) => () => pinRepository(harness.id, id)),
        ]),
      success:
        added.length > 0
          ? "Saved. The harness picks it up with its next heartbeat and pre-clones the repositories you pinned."
          : "Saved. The harness picks it up with its next heartbeat.",
    };
  };

  return (
    <SettingsSection
      id="harness-settings"
      title="Settings"
      showTitle={false}
      description="Central settings, returned to the harness in every heartbeat response (every 20 seconds). Concurrency and task types use the organization's default unless you set them here."
      changes={changes}
      prepare={prepare}
      onDiscard={() => {
        setDraft(saved);
        setOverride(savedOverride);
        setPins(savedPins);
      }}
      confirm={{
        consequence:
          "The harness picks these up with its next heartbeat (within 20 seconds). Running jobs aren't cancelled; it takes new jobs by the new limits.",
      }}
      readOnly={readOnly}
    >
      <SettingsSubsection
        id="harness-concurrency"
        title="Concurrency"
        description="How many jobs the harness runs at once, and how many of them each pool may take."
      >
        <div className="settings-group" role="group" aria-labelledby="max-concurrency-label">
          <span id="max-concurrency-label" className="settings-group-label">
            Max concurrency
          </span>
          <InheritCheck
            id="max-concurrency-inherit"
            checked={draft.inheritMaxConcurrency}
            disabled={readOnly}
            onChange={(inherit) =>
              setDraft((d) => ({
                ...d,
                inheritMaxConcurrency: inherit,
                maxConcurrency: inherit ? String(defaults.maxConcurrency) : d.maxConcurrency,
              }))
            }
          />
          <div className="settings-row">
            <Field
              label="Jobs at once"
              htmlFor="max-concurrency"
              description={
                draft.inheritMaxConcurrency
                  ? `Jobs the harness runs at once: the organization's ${defaults.maxConcurrency}.`
                  : withDefault(
                      "Jobs the harness runs at once (1–32).",
                      `the organization's ${defaults.maxConcurrency}`,
                    )
              }
            >
              <Input
                id="max-concurrency"
                type="number"
                className="input-number"
                min={1}
                max={32}
                required
                disabled={readOnly || draft.inheritMaxConcurrency}
                value={
                  draft.inheritMaxConcurrency
                    ? String(defaults.maxConcurrency)
                    : draft.maxConcurrency
                }
                onChange={(e) => setDraft((d) => ({ ...d, maxConcurrency: e.target.value }))}
              />
            </Field>
          </div>
        </div>
        <div className="settings-group" role="group" aria-labelledby="pool-limits-label">
          <span id="pool-limits-label" className="settings-group-label">
            Concurrency per pool
          </span>
          <Muted>
            Caps how many of the harness&apos;s slots a pool&apos;s jobs may take (1 to the max
            concurrency): <InlineCode>short</InlineCode> holds query and review tasks,{" "}
            <InlineCode>long</InlineCode> coding tasks. Leave it empty for the default: long leaves
            one slot free for other work; short may use every slot. Lowering a limit doesn&apos;t
            cancel running jobs; the harness takes no new ones until it is under the limit.
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
        id="harness-task-types"
        title="Task types"
        description={`Which tasks this host may run. Housekeeping jobs (repository syncs) always run. Organization default: ${taskTypeList(defaults.acceptedTaskTypes)}.`}
      >
        <div className="settings-group" role="group" aria-label="Accepted task types">
          <InheritCheck
            id="task-types-inherit"
            checked={draft.inheritTaskTypes}
            disabled={readOnly}
            onChange={(inherit) =>
              setDraft((d) => ({
                ...d,
                inheritTaskTypes: inherit,
                taskTypes: inherit ? defaults.acceptedTaskTypes : d.taskTypes,
              }))
            }
          />
          {TASK_TYPES.map((taskType) => (
            <div key={taskType} className="settings-check settings-check-center">
              <Checkbox
                id={`task-type-${taskType}`}
                checked={taskTypes.includes(taskType)}
                disabled={readOnly || draft.inheritTaskTypes}
                onCheckedChange={(checked) => toggle(taskType, checked === true)}
              />
              <Label htmlFor={`task-type-${taskType}`}>{TASK_TYPE_LABELS[taskType]}</Label>
              <Muted>{TASK_TYPE_HINTS[taskType]}</Muted>
            </div>
          ))}
        </div>
      </SettingsSubsection>

      <SettingsSubsection
        id="harness-pins"
        title="Pinned repositories"
        description="Pin repositories to keep their jobs on this harness, for instance one that holds their credentials or a warm clone."
      >
        <Field label="Pinned repositories" description={pinsDescription(pins.length)}>
          <MultiSelect
            id="pinned-repositories"
            value={pins}
            onChange={setPins}
            onSearch={search}
            selectedOptions={pinnedOptions}
            disabled={readOnly}
            placeholder="No pinned repositories"
            searchPlaceholder="Search repositories…"
            searchLabel="Search repositories"
            staleMessage="It was disconnected. It's kept until you remove it."
          />
        </Field>
      </SettingsSubsection>

      <SettingsSubsection
        id="harness-version"
        title="Version"
        description={
          harness.selfUpdate === "supported"
            ? "This harness runs under pm2 and updates itself: it stops taking jobs, lets running ones finish (up to 2 hours), installs the desired version and restarts. A version that doesn't stay up is rolled back and not tried again here unless you use Update now, which also updates to the latest on npm when no version is chosen."
            : "This harness can't update itself (it isn't running under pm2, or its version predates self-update). Install the desired version on the host."
        }
      >
        <Field
          label="Desired version override"
          htmlFor="desired-version"
          description={`Semver, e.g. 1.4.0. Leave it empty to use the organization's version (${globalDesiredVersion ?? "not set"}, Settings › Harness defaults). Default: not set.`}
        >
          <Input
            id="desired-version"
            placeholder={`Organization (${globalDesiredVersion ?? "not set"})`}
            disabled={readOnly}
            value={override}
            onChange={(e) => setOverride(e.target.value)}
            className="settings-mono input-number-wide"
          />
        </Field>
        {harness.selfUpdate === "supported" && !readOnly && (
          <div>
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              title="Update to the saved desired version (the latest on npm when none is set) with the next heartbeat, even if it failed here before."
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
          </div>
        )}
        {harness.updateRequest && (
          <Muted>
            Update to {harness.updateRequest.version} requested{" "}
            <Timestamp iso={harness.updateRequest.requestedAt} inline />; the harness starts it with
            its next heartbeat.
          </Muted>
        )}
      </SettingsSubsection>
    </SettingsSection>
  );
}

/** Where a configuration value comes from, after the value. */
function ConfigSource({ override }: { override: boolean }) {
  return <span className="fact-secondary">{override ? "(override)" : "(organization)"}</span>;
}

// ── Installables ─────────────────────────────────────────────────────────────

export function InstallablesSection({
  harness,
  installables,
  installJobs,
}: {
  harness: HarnessRow;
  installables: InstallableRow[];
  installJobs: InstallJobRow[];
}) {
  return (
    <SettingsPanel
      id="harness-installables"
      title="Installables"
      showTitle={false}
      description="npm packages that add commands, MCP servers and skills to this host, as reported in its last heartbeat. Installing or updating one runs on the harness, which refuses packages its local allowlist doesn't allow."
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
      {!harness.revoked && (
        <SettingsSubsection
          id="installables-install"
          title="Install or update"
          description="Starts an install job on this harness; it picks it up with its next claim."
        >
          <InstallForm harnessId={harness.id} />
        </SettingsSubsection>
      )}
    </SettingsPanel>
  );
}

// ── Host tools ───────────────────────────────────────────────────────────────

function hostToolPaths(hostTools: readonly HostToolRow[]): Record<string, string> {
  return Object.fromEntries(hostTools.map((tool) => [tool.hostToolId, tool.configuredPath ?? ""]));
}

const pathFormat = (value: SettingValue) =>
  value === "" ? "Discover on PATH" : formatSettingValue(value);

/** The configured paths of the harness's host tools, saved together. */
export function HostToolsSection({
  harness,
  hostTools,
}: {
  harness: HarnessRow;
  hostTools: HostToolRow[];
}) {
  const saved = React.useMemo(() => hostToolPaths(hostTools), [hostTools]);
  const [paths, setPaths] = React.useState(saved);
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
      id="harness-host-tools"
      title="Host tools"
      showTitle={false}
      description={
        <>
          Software installed on this host by hand. A configured path wins over the one the harness
          discovers on its <InlineCode>PATH</InlineCode>, even when it doesn&apos;t exist: the tool
          is then unavailable. Leave it blank to use the discovered one. The harness gets a new path
          with its next heartbeat and reports on it with the one after; it refuses paths its local{" "}
          <InlineCode>blockedExecPaths</InlineCode> covers.
        </>
      }
      changes={changes}
      prepare={() => ({
        action: () =>
          saveInOrder(
            changes.map(
              (change) => () => setHostToolPath(harness.id, change.key, paths[change.key] ?? ""),
            ),
          ),
        success: "Saved. The harness gets the paths with its next heartbeat.",
      })}
      onDiscard={() => setPaths(saved)}
      readOnly={harness.revoked || hostTools.length === 0}
    >
      <SettingsSubsection id="host-tools-paths" className="settings-sub-wide" title="Paths">
        <HarnessHostTools
          revoked={harness.revoked}
          hostTools={hostTools}
          paths={paths}
          onPathChange={(id, path) => setPaths((all) => ({ ...all, [id]: path }))}
        />
      </SettingsSubsection>
    </SettingsSection>
  );
}

// ── Danger zone ───────────────────────────────────────────────────────────────

function RevokeSubsection({ harness }: { harness: HarnessRow }) {
  const { pending, run } = useAction();
  return (
    <SettingsSubsection
      id="harness-revoke"
      title="Revoke"
      description={
        <>
          Revoking is immediate: the harness&apos;s access, refresh and job tokens stop working on
          its next request, its running jobs are redelivered to other harnesses and its pins are
          removed. To use the host again, enroll it as a new harness.
        </>
      }
    >
      <div>
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
      </div>
    </SettingsSubsection>
  );
}

function DeleteSubsection({ harness }: { harness: HarnessRow }) {
  const router = useRouter();
  const { pending, run } = useAction();
  return (
    <SettingsSubsection
      id="harness-delete"
      title="Delete"
      description={`Deleting removes the harness from the Harnesses pages for good${harness.revoked ? "." : ", revoking it first."}`}
    >
      <div>
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
      </div>
    </SettingsSubsection>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

function DangerZone({ harness }: { harness: HarnessRow }) {
  return (
    <SettingsPanel
      id="harness-danger"
      title="Danger zone"
      tone="danger"
      description="Revoking and deleting can't be undone."
    >
      {!harness.revoked && <RevokeSubsection harness={harness} />}
      <DeleteSubsection harness={harness} />
    </SettingsPanel>
  );
}

export function HarnessDetailView({
  tab,
  harness,
  now,
  audit,
  installables,
  installJobs,
  hostTools,
  globalDesiredVersion,
}: HarnessDetailViewProps) {
  return (
    <>
      <AppHeader
        breadcrumbs={[
          { label: "Harnesses", href: "/harnesses" },
          { label: harness.name },
          { label: HARNESS_TAB_LABELS[tab] },
        ]}
      />
      <main className="detail-main">
        <PageHeader title={harness.name} meta={<HarnessStatusBadge harness={harness} />} />
        <HarnessNav harnessId={harness.id} current={tab} />

        <TokenTheftAlert audit={audit} />
        {harness.revoked && harness.revokedAt && (
          <Alert variant="warning">
            <AlertTitle as="h2">Revoked</AlertTitle>
            <AlertDescription>
              This harness was revoked <Timestamp iso={harness.revokedAt} inline />. Its
              configuration can no longer be changed.
            </AlertDescription>
          </Alert>
        )}

        <div className="settings-sections">
          {tab === "overview" && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle as="h2">Status</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="harness-status-grid">
                    <Fact label="Last heartbeat">
                      {harness.lastHeartbeatAt ? (
                        <Timestamp iso={harness.lastHeartbeatAt} now={now} inline />
                      ) : (
                        "Never"
                      )}
                    </Fact>
                    <Fact label="Version">
                      {harness.version ? (
                        <span className="text-numeric">{harness.version}</span>
                      ) : (
                        "Unknown"
                      )}
                    </Fact>
                    <Fact label="Desired version">
                      {harness.desiredVersion ? (
                        <>
                          <span className="text-numeric">{harness.desiredVersion}</span>{" "}
                          <span className="fact-secondary">
                            {harness.desiredVersionOverride
                              ? "(override)"
                              : harness.tracksLatest
                                ? "(latest on npm)"
                                : "(organization)"}
                          </span>
                        </>
                      ) : harness.tracksLatest ? (
                        "Latest on npm (not read yet)"
                      ) : (
                        "Not set"
                      )}
                    </Fact>
                    <Fact label="Update status">
                      <Stack gap={1}>
                        <div>
                          <UpdateStatusBadge harness={harness} />
                        </div>
                        {harness.update?.error && <Muted>{harness.update.error}</Muted>}
                      </Stack>
                    </Fact>
                    <Fact label="Failed versions">
                      {harness.failedVersions.length > 0 ? (
                        <span className="text-numeric">{harness.failedVersions.join(", ")}</span>
                      ) : (
                        "None"
                      )}
                    </Fact>
                    <Fact label="Accepted task types">
                      <Stack gap={1}>
                        <TaskTypeBadges accepted={harness.acceptedTaskTypes} />
                        <ConfigSource override={harness.overrides.acceptedTaskTypes !== null} />
                      </Stack>
                    </Fact>
                    <Fact label="Running jobs" wide>
                      <Stack gap={1}>
                        <span>
                          {harness.runningJobs.length} / {harness.maxConcurrency}{" "}
                          <ConfigSource override={harness.overrides.maxConcurrency !== null} />
                        </span>
                        {harness.runningJobs.map((job) => (
                          <JobTargetLink key={job.id} job={job} />
                        ))}
                      </Stack>
                    </Fact>
                    <Fact label="Concurrency per pool">
                      {formatPoolLimits(harness.effectivePoolLimits)}
                    </Fact>
                    <Fact label="Enrolled">
                      <Timestamp iso={harness.createdAt} inline />
                    </Fact>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle as="h2">Audit log</CardTitle>
                  <CardDescription>
                    The 50 most recent security events for this harness.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <HarnessAuditLog audit={audit} />
                </CardContent>
              </Card>

              <DangerZone harness={harness} />
            </>
          )}
          {tab === "settings" && (
            <HarnessSettingsSection harness={harness} globalDesiredVersion={globalDesiredVersion} />
          )}
          {tab === "installables" && (
            <InstallablesSection
              harness={harness}
              installables={installables}
              installJobs={installJobs}
            />
          )}
          {tab === "host-tools" && <HostToolsSection harness={harness} hostTools={hostTools} />}
        </div>
      </main>
    </>
  );
}
