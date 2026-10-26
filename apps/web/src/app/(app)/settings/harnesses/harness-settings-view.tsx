"use client";

import { Button, Field, InlineCode, Input, Skeleton, Stack } from "@iamthemcmaster/ui";
import { IconCloudDownload } from "@tabler/icons-react";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { PageHeader } from "@/components/page-header";
import { QueryBoundary } from "@/components/query-boundary";
import { SettingsPanel, SettingsSection, SettingsSubsection } from "@/components/settings-section";
import {
  formatSettingValue,
  settingChanges,
  withDefault,
  type SettingSpec,
  type SettingValue,
} from "@/lib/settings/changes";
import { useApiAction } from "@/components/use-api-action";
import { useSeededDraft } from "@/components/use-seeded-draft";
import { api } from "@/lib/api/client";
import type {
  HarnessDefaults,
  HarnessDefaultsSave,
  OrganizationDefaults,
} from "@/lib/api/harness-defaults";
import { mutationResultSchema } from "@/lib/api/schemas";
import { ACCESS_DENIED_PATH } from "@/lib/auth/routes";
import { typedNumber } from "@/lib/settings/forms";
import { formatDateTime } from "@/lib/format-date";
import {
  harnessDefaultsChanged,
  useHarnessDefaults,
  useHostToolCatalog,
} from "./harness-defaults-queries";
import {
  HARNESS_SETTINGS_TAB_LABELS,
  HarnessSettingsNav,
  type HarnessSettingsTab,
} from "./harness-settings-nav";
import { HostToolsCatalog } from "./host-tools-catalog";

export type { OrganizationDefaults };

const DEFAULTS_SPECS: SettingSpec[] = [
  { key: "maxConcurrency", label: "Max concurrency" },
  { key: "version", label: "Desired version", format: formatSettingValue },
];

interface DefaultsDraft {
  maxConcurrency: string;
  /** A version, `latest`, or blank to not manage versions. */
  version: string;
}

function defaultsDraft(defaults: OrganizationDefaults, version: string | null): DefaultsDraft {
  return {
    maxConcurrency: String(defaults.maxConcurrency),
    version: version ?? "",
  };
}

/** The draft as compared and saved. */
function defaultsValues(draft: DefaultsDraft): Record<string, SettingValue> {
  return {
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

/**
 * The organization's harness defaults, saved together: the max concurrency harnesses use
 * unless they set their own, and the version harnesses run.
 */
export function DefaultsSection({
  desiredVersion,
  updatedAt,
  latest,
  packageName,
  defaults,
  builtInDefaults,
}: HarnessDefaults) {
  const apiAction = useApiAction();
  const saved = defaultsDraft(defaults, desiredVersion);
  // Follows a change saved elsewhere while the section isn't being edited.
  const [draft, setDraft] = useSeededDraft(saved);
  const values = defaultsValues(draft);
  const changes = settingChanges(DEFAULTS_SPECS, defaultsValues(saved), values);

  const prepare = () => {
    const changed = new Set(changes.map((change) => change.key));
    const save: HarnessDefaultsSave = {
      ...(changed.has("maxConcurrency")
        ? { defaults: { maxConcurrency: Number(draft.maxConcurrency) } }
        : {}),
      ...(changed.has("version") ? { version: draft.version } : {}),
    };
    return {
      action: () =>
        apiAction(
          ({ organizationId }) =>
            api.put("/api/ui/harness-defaults", mutationResultSchema, {
              body: save,
              organizationId,
            }),
          harnessDefaultsChanged,
        ),
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
      description="What every harness of this organization uses unless it sets its own on its page. A harness's own setting always wins, on or off."
      changes={changes}
      prepare={prepare}
      onDiscard={() => setDraft(saved)}
      confirm={{
        consequence:
          "Every harness without its own setting uses these with its next heartbeat, and harnesses without their own version override update to the desired version. Running jobs aren't cancelled.",
      }}
    >
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

function DefaultsSkeleton() {
  return (
    <Stack gap={6}>
      {[1, 2].map((rows, i) => (
        <Stack key={i} gap={3}>
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-2/3" />
          {Array.from({ length: rows }, (_, row) => (
            <Skeleton key={row} className="h-9 w-full" />
          ))}
        </Stack>
      ))}
    </Stack>
  );
}

function HostToolsSkeleton() {
  return (
    <Stack gap={3}>
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-9 w-full" />
      ))}
    </Stack>
  );
}

function DefaultsTab() {
  const query = useHarnessDefaults();
  return (
    <QueryBoundary query={query} skeleton={<DefaultsSkeleton />} what="the harness defaults">
      {(data) => <DefaultsSection {...data} />}
    </QueryBoundary>
  );
}

function HostToolsTab() {
  const query = useHostToolCatalog();
  return (
    <SettingsPanel
      id="host-tools"
      title="Host tools"
      showTitle={false}
      description={
        <>
          Software harness owners install by hand, such as Semgrep, that tasks can require.
          Harnesses get this list with their heartbeat and report where they find each tool; set a
          harness&apos;s path to one on its Host tools tab.
        </>
      }
    >
      <QueryBoundary query={query} skeleton={<HostToolsSkeleton />} what="the host tools">
        {({ hostTools }) => <HostToolsCatalog hostTools={hostTools} />}
      </QueryBoundary>
    </SettingsPanel>
  );
}

/**
 * Settings › Harness defaults (admins), live: a tab (Defaults or the Host tools catalog);
 * changes saved in another tab show without a reload.
 */
export function HarnessSettingsView({ tab }: { tab: HarnessSettingsTab }) {
  const { role } = useCurrentUser();
  if (role !== "admin") redirect(`${ACCESS_DENIED_PATH}?reason=forbidden`);
  return (
    <>
      <AppHeader
        breadcrumbs={[
          { label: "Harness defaults", href: "/settings/harnesses" },
          { label: HARNESS_SETTINGS_TAB_LABELS[tab] },
        ]}
      />
      <div className="detail-main">
        <PageHeader
          title="Harness defaults"
          description="Settings every harness of this organization gets with its heartbeat."
        />
        <HarnessSettingsNav current={tab} />

        <div className="settings-sections">
          {tab === "defaults" && <DefaultsTab />}
          {tab === "host-tools" && <HostToolsTab />}
        </div>
      </div>
    </>
  );
}
