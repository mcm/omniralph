"use client";

import * as React from "react";
import { Button, Checkbox, Field, InlineCode, Input, Label, Muted } from "@iamthemcmaster/ui";
import { IconCloudDownload } from "@tabler/icons-react";
import { TASK_TYPES, type TaskType } from "@omniralph/tasks";
import { AppHeader } from "@/components/app-header";
import { PageHeader } from "@/components/page-header";
import {
  saveInOrder,
  SettingsPanel,
  SettingsSection,
  SettingsSubsection,
} from "@/components/settings-section";
import {
  formatSettingValue,
  settingChanges,
  withDefault,
  type SettingSpec,
  type SettingValue,
} from "@/lib/settings/changes";
import { typedNumber } from "@/lib/settings/forms";
import { formatDateTime } from "@/lib/format-date";
import { setGlobalHarnessVersion, setOrganizationDefaults } from "./actions";
import {
  HARNESS_SETTINGS_TAB_LABELS,
  HarnessSettingsNav,
  type HarnessSettingsTab,
} from "./harness-settings-nav";
import { HostToolsCatalog, type HostToolCatalogRow } from "./host-tools-catalog";

const TASK_TYPE_LABELS: Record<TaskType, string> = {
  query: "Query",
  review: "Review",
  coding: "Coding",
};

/** What each task type runs. */
const TASK_TYPE_HINTS: Record<TaskType, string> = {
  query: "Read-only questions: replies, code questions, learned rules, triage.",
  review: "Pull request reviews.",
  coding: "Coding runs that change code and push it.",
};

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

function formatTaskTypes(types: readonly string[]): string {
  return types.length === 0
    ? "None"
    : listFormat.format(types.map((t) => TASK_TYPE_LABELS[t as TaskType] ?? t));
}

const DEFAULTS_SPECS: SettingSpec[] = [
  {
    key: "allowedTaskTypes",
    label: "Task types",
    format: (value) => (Array.isArray(value) ? formatTaskTypes(value) : formatSettingValue(value)),
  },
  { key: "maxConcurrency", label: "Max concurrency" },
  { key: "version", label: "Desired version", format: formatSettingValue },
];

/** An organization's task types and max concurrency, saved or built in. */
export interface OrganizationDefaults {
  allowedTaskTypes: string[];
  maxConcurrency: number;
}

interface DefaultsDraft {
  taskTypes: readonly string[];
  maxConcurrency: string;
  /** A version, `latest`, or blank to not manage versions. */
  version: string;
}

function defaultsDraft(defaults: OrganizationDefaults, version: string | null): DefaultsDraft {
  return {
    taskTypes: defaults.allowedTaskTypes,
    maxConcurrency: String(defaults.maxConcurrency),
    version: version ?? "",
  };
}

/** The draft as compared and saved: task types in their listed order. */
function defaultsValues(draft: DefaultsDraft): Record<string, SettingValue> {
  return {
    allowedTaskTypes: TASK_TYPES.filter((t) => draft.taskTypes.includes(t)),
    maxConcurrency: typedNumber(draft.maxConcurrency),
    version: draft.version.trim(),
  };
}

const tracksLatest = (version: string) => version.trim().toLowerCase() === "latest";

/** What a saved version change does, as the save's success message. */
function versionSuccess(version: string): string {
  const trimmed = version.trim();
  if (tracksLatest(trimmed)) return "Saved. Harnesses will follow the latest version on npm.";
  return trimmed
    ? `Saved. Harnesses will update to ${trimmed} with their next heartbeat.`
    : "Saved. Harnesses keep the version they run.";
}

interface DefaultsSectionProps {
  desiredVersion: string | null;
  updatedAt: string | null;
  latest: HarnessSettingsViewProps["latest"];
  packageName: string;
  defaults: OrganizationDefaults;
  builtInDefaults: OrganizationDefaults;
}

/**
 * The organization's harness defaults, saved together: the task types and max concurrency
 * harnesses and repositories use unless they set their own, and the version harnesses run.
 */
export function DefaultsSection({
  desiredVersion,
  updatedAt,
  latest,
  packageName,
  defaults,
  builtInDefaults,
}: DefaultsSectionProps) {
  const saved = React.useMemo(
    () => defaultsDraft(defaults, desiredVersion),
    [defaults, desiredVersion],
  );
  const [draft, setDraft] = React.useState(saved);
  const values = defaultsValues(draft);
  const changes = settingChanges(DEFAULTS_SPECS, defaultsValues(saved), values);

  const toggle = (taskType: TaskType, on: boolean) =>
    setDraft((d) => ({
      ...d,
      taskTypes: TASK_TYPES.filter((t) => (t === taskType ? on : d.taskTypes.includes(t))),
    }));

  const prepare = () => {
    const changed = new Set(changes.map((change) => change.key));
    const defaultsChanged = changed.has("allowedTaskTypes") || changed.has("maxConcurrency");
    return {
      action: () =>
        saveInOrder([
          ...(defaultsChanged
            ? [
                () =>
                  setOrganizationDefaults({
                    allowedTaskTypes: [...(values.allowedTaskTypes as string[])],
                    maxConcurrency: Number(draft.maxConcurrency),
                  }),
              ]
            : []),
          ...(changed.has("version") ? [() => setGlobalHarnessVersion(draft.version)] : []),
        ]),
      success: changed.has("version")
        ? versionSuccess(draft.version)
        : "Saved. Harnesses pick it up with their next heartbeat.",
    };
  };

  const changedAt = updatedAt ? ` Last changed ${formatDateTime(updatedAt)}.` : "";
  let hint = `Semver, e.g. 1.4.0, or latest to follow the latest on npm. Leave it empty to not manage versions. Default: not set.${changedAt}`;
  if (latest) {
    const read = latest.checkedAt ? ` (read ${formatDateTime(latest.checkedAt)})` : "";
    hint = latest.error
      ? `Following the latest on npm, but reading it failed: ${latest.error}.${latest.version ? ` Harnesses stay on ${latest.version} meanwhile.` : ""}${changedAt}`
      : `Following the latest on npm: ${latest.version ?? "not read yet"}${read}. npm is read again every few minutes.${changedAt}`;
  }

  return (
    <SettingsSection
      id="harness-defaults"
      title="Defaults"
      showTitle={false}
      description="What every harness and repository of this organization uses unless it sets its own on its page. A harness's or repository's own setting always wins, on or off."
      changes={changes}
      prepare={prepare}
      onDiscard={() => setDraft(saved)}
      confirm={{
        consequence:
          "Every harness and repository without its own setting uses these with its next claim or heartbeat, and harnesses without their own version override update to the desired version. Running jobs aren't cancelled.",
      }}
    >
      <SettingsSubsection
        id="default-task-types"
        title="Task types"
        description={`Which tasks harnesses may run and repositories get. Housekeeping jobs (repository syncs) always run. Default: ${formatTaskTypes(builtInDefaults.allowedTaskTypes)}.`}
      >
        <div className="settings-group" role="group" aria-label="Task types">
          {TASK_TYPES.map((taskType) => (
            <div key={taskType} className="settings-check settings-check-center">
              <Checkbox
                id={`default-task-type-${taskType}`}
                checked={draft.taskTypes.includes(taskType)}
                onCheckedChange={(checked) => toggle(taskType, checked === true)}
              />
              <Label htmlFor={`default-task-type-${taskType}`}>{TASK_TYPE_LABELS[taskType]}</Label>
              <Muted>{TASK_TYPE_HINTS[taskType]}</Muted>
            </div>
          ))}
        </div>
      </SettingsSubsection>

      <SettingsSubsection id="default-concurrency" title="Concurrency">
        <div className="settings-row">
          <Field
            label="Max concurrency"
            htmlFor="default-max-concurrency"
            description={withDefault(
              "Jobs a harness runs at once (1–32). Pool limits default from it.",
              String(builtInDefaults.maxConcurrency),
            )}
          >
            <Input
              id="default-max-concurrency"
              type="number"
              className="input-number"
              min={1}
              max={32}
              required
              value={draft.maxConcurrency}
              onChange={(e) => setDraft((d) => ({ ...d, maxConcurrency: e.target.value }))}
            />
          </Field>
        </div>
      </SettingsSubsection>

      <SettingsSubsection
        id="default-version"
        title="Harness version"
        description={
          <>
            The version of <InlineCode>{packageName}</InlineCode> harnesses should run, or{" "}
            <InlineCode>latest</InlineCode> to update them with each release. Harnesses under pm2
            stop taking jobs, let running ones finish (up to 2 hours), install it and restart; a
            version that doesn&apos;t stay up is rolled back and not tried again on that harness
            unless you use &quot;Update now&quot; on its page. Other harnesses show &quot;Update
            manually&quot;. A harness&apos;s own override (on its page) wins over this one.
          </>
        }
      >
        <Field label="Desired version" htmlFor="desired-version" description={hint}>
          <Input
            id="desired-version"
            placeholder="e.g. 1.4.0"
            value={draft.version}
            onChange={(e) => setDraft((d) => ({ ...d, version: e.target.value }))}
            className="settings-mono"
          />
        </Field>
        <div>
          <Button
            type="button"
            variant="secondary"
            disabled={tracksLatest(draft.version)}
            onClick={() => setDraft((d) => ({ ...d, version: "latest" }))}
          >
            <IconCloudDownload size={14} />
            Track latest on npm
          </Button>
        </div>
      </SettingsSubsection>
    </SettingsSection>
  );
}

interface HarnessSettingsViewProps {
  tab: HarnessSettingsTab;
  /** A version, `latest` or null. */
  desiredVersion: string | null;
  /** ISO timestamp of the last change. */
  updatedAt: string | null;
  /** Tracking `latest`: the version last read from npm (`checkedAt` is ISO), or why reading failed. */
  latest: { version: string | null; error: string | null; checkedAt: string | null } | null;
  packageName: string;
  /** The organization's task-type and max concurrency defaults (the built-in ones when not saved). */
  defaults: OrganizationDefaults;
  /** The defaults when the organization hasn't saved any. */
  builtInDefaults: OrganizationDefaults;
  /** The organization's host tools, by name (Host tools tab). */
  hostTools: HostToolCatalogRow[];
}

export function HarnessSettingsView({ tab, hostTools, ...defaults }: HarnessSettingsViewProps) {
  return (
    <>
      <AppHeader
        breadcrumbs={[
          { label: "Harness defaults", href: "/settings/harnesses" },
          { label: HARNESS_SETTINGS_TAB_LABELS[tab] },
        ]}
      />
      <main className="detail-main">
        <PageHeader
          title="Harness defaults"
          description="Settings every harness of this organization gets with its heartbeat."
        />
        <HarnessSettingsNav current={tab} />

        <div className="settings-sections">
          {tab === "defaults" && <DefaultsSection {...defaults} />}
          {tab === "host-tools" && (
            <SettingsPanel
              id="host-tools"
              title="Host tools"
              showTitle={false}
              description={
                <>
                  Software harness owners install by hand, such as Semgrep, that tasks can require.
                  Harnesses get this list with their heartbeat and report where they find each tool;
                  set a harness&apos;s path to one on its Host tools tab.
                </>
              }
            >
              <HostToolsCatalog hostTools={hostTools} />
            </SettingsPanel>
          )}
        </div>
      </main>
    </>
  );
}
