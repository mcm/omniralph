"use client";

import * as React from "react";
import {
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
} from "@iamthemcmaster/ui";
import { IconCloudDownload } from "@tabler/icons-react";
import { TASK_TYPES, type TaskType } from "@omniralph/tasks";
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
import { formatDateTime } from "@/lib/format-date";
import {
  setGlobalHarnessVersion,
  setOrganizationDefaults,
  trackLatestHarnessVersion,
} from "./actions";
import { HostToolsCatalog, type HostToolCatalogRow } from "./host-tools-catalog";

const VERSION_SPECS: SettingSpec[] = [
  {
    key: "version",
    label: "Desired version",
    format: formatSettingValue,
  },
];

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
];

/** An organization's task types and max concurrency, saved or built in. */
export interface OrganizationDefaults {
  allowedTaskTypes: string[];
  maxConcurrency: number;
}

interface DefaultsDraft {
  taskTypes: readonly string[];
  maxConcurrency: string;
}

function defaultsDraft(defaults: OrganizationDefaults): DefaultsDraft {
  return { taskTypes: defaults.allowedTaskTypes, maxConcurrency: String(defaults.maxConcurrency) };
}

/** The draft as compared and saved: task types in their listed order. */
function defaultsValues(draft: DefaultsDraft): Record<string, SettingValue> {
  return {
    allowedTaskTypes: TASK_TYPES.filter((t) => draft.taskTypes.includes(t)),
    maxConcurrency: typedNumber(draft.maxConcurrency),
  };
}

function DefaultsCard({
  defaults,
  builtInDefaults,
}: {
  defaults: OrganizationDefaults;
  builtInDefaults: OrganizationDefaults;
}) {
  const saved = React.useMemo(() => defaultsDraft(defaults), [defaults]);
  const [draft, setDraft] = React.useState(saved);
  const values = defaultsValues(draft);

  const toggle = (taskType: TaskType, on: boolean) =>
    setDraft((d) => ({
      ...d,
      taskTypes: TASK_TYPES.filter((t) => (t === taskType ? on : d.taskTypes.includes(t))),
    }));

  return (
    <SettingsCard
      title="Defaults"
      description="What every harness and repository of this organization uses unless it sets its own on its page. A harness's or repository's own setting always wins, on or off."
      changes={settingChanges(DEFAULTS_SPECS, defaultsValues(saved), values)}
      prepare={() => ({
        action: () =>
          setOrganizationDefaults({
            allowedTaskTypes: [...(values.allowedTaskTypes as string[])],
            maxConcurrency: Number(draft.maxConcurrency),
          }),
        success: "Saved. Harnesses pick it up with their next heartbeat.",
      })}
      onDiscard={() => setDraft(saved)}
      confirm={{
        consequence:
          "Every harness and repository without its own setting uses these with its next claim or heartbeat. Running jobs aren't cancelled.",
      }}
    >
      <div className="settings-group" role="group" aria-labelledby="default-task-types-label">
        <span id="default-task-types-label" className="settings-group-label">
          Task types
        </span>
        <Muted>
          Which tasks harnesses may run and repositories get. Housekeeping jobs (repository syncs)
          always run. Default: {formatTaskTypes(builtInDefaults.allowedTaskTypes)}.
        </Muted>
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
    </SettingsCard>
  );
}

export function HarnessSettingsView({
  desiredVersion,
  updatedAt,
  latest,
  packageName,
  defaults,
  builtInDefaults,
  hostTools,
}: {
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
  /** The organization's host tools, by name. */
  hostTools: HostToolCatalogRow[];
}) {
  const { pending, run } = useAction();
  const [version, setVersion] = React.useState(desiredVersion ?? "");

  const changed = updatedAt ? ` Last changed ${formatDateTime(updatedAt)}.` : "";
  let hint = `Semver, e.g. 1.4.0, or latest to follow the latest on npm. Leave it empty to not manage versions. Default: not set.${changed}`;
  if (latest) {
    const read = latest.checkedAt ? ` (read ${formatDateTime(latest.checkedAt)})` : "";
    hint = latest.error
      ? `Following the latest on npm, but reading it failed: ${latest.error}.${latest.version ? ` Harnesses stay on ${latest.version} meanwhile.` : ""}${changed}`
      : `Following the latest on npm: ${latest.version ?? "not read yet"}${read}. npm is read again every few minutes.${changed}`;
  }

  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Harness defaults" }]} />
      <main className="detail-main">
        <PageHeader
          title="Harness defaults"
          description="Settings every harness of this organization gets with its heartbeat."
        />

        <SettingsCard
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
          changes={settingChanges(
            VERSION_SPECS,
            { version: (desiredVersion ?? "").trim() },
            { version: version.trim() },
          )}
          prepare={() => {
            const trimmed = version.trim();
            return {
              action: () => setGlobalHarnessVersion(version),
              success:
                trimmed.toLowerCase() === "latest"
                  ? "Harnesses will follow the latest version on npm."
                  : trimmed
                    ? `Harnesses will update to ${trimmed} with their next heartbeat.`
                    : "Cleared. Harnesses keep the version they run.",
            };
          }}
          onDiscard={() => setVersion(desiredVersion ?? "")}
          confirm={{
            consequence:
              "Every harness without its own override updates to this version with its next heartbeat.",
          }}
          actions={
            <Button
              type="button"
              variant="secondary"
              disabled={pending || (desiredVersion ?? "").trim().toLowerCase() === "latest"}
              onClick={() =>
                run(async () => {
                  const result = await trackLatestHarnessVersion();
                  if (result.ok) setVersion("latest");
                  return result;
                }, "Harnesses will follow the latest version on npm.")
              }
            >
              <IconCloudDownload size={14} />
              Track latest on npm
            </Button>
          }
        >
          <Field label="Desired version" htmlFor="desired-version" description={hint}>
            <Input
              id="desired-version"
              placeholder="e.g. 1.4.0"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              className="settings-mono"
            />
          </Field>
        </SettingsCard>

        <DefaultsCard defaults={defaults} builtInDefaults={builtInDefaults} />

        <Card>
          <CardHeader>
            <CardTitle as="h2">Host tools</CardTitle>
            <CardDescription>
              Software harness owners install by hand, such as Semgrep, that tasks can require.
              Harnesses get this list with their heartbeat and report where they find each tool; set
              a harness&apos;s path to one on its page.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <HostToolsCatalog hostTools={hostTools} />
          </CardContent>
        </Card>
      </main>
    </>
  );
}
