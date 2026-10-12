"use client";

import * as React from "react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  InlineCode,
  Input,
} from "@iamthemcmaster/ui";
import { IconCloudDownload } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { PageHeader } from "@/components/page-header";
import { SettingsCard } from "@/components/settings-card";
import { useAction } from "@/components/use-action";
import { formatSettingValue, settingChanges, type SettingSpec } from "@/lib/settings/changes";
import { formatDateTime } from "@/lib/format-date";
import { setGlobalHarnessVersion, trackLatestHarnessVersion } from "./actions";
import { HostToolsCatalog, type HostToolCatalogRow } from "./host-tools-catalog";

const VERSION_SPECS: SettingSpec[] = [
  {
    key: "version",
    label: "Desired version",
    format: (value) => (value === "" ? "Not set" : formatSettingValue(value)),
  },
];

export function HarnessSettingsView({
  desiredVersion,
  updatedAt,
  latest,
  packageName,
  hostTools,
}: {
  /** A version, `latest` or null. */
  desiredVersion: string | null;
  /** ISO timestamp of the last change. */
  updatedAt: string | null;
  /** Tracking `latest`: the version last read from npm (`checkedAt` is ISO), or why reading failed. */
  latest: { version: string | null; error: string | null; checkedAt: string | null } | null;
  packageName: string;
  /** The organization's host tools, by name. */
  hostTools: HostToolCatalogRow[];
}) {
  const { pending, run } = useAction();
  const [version, setVersion] = React.useState(desiredVersion ?? "");

  const changed = updatedAt ? ` Last changed ${formatDateTime(updatedAt)}.` : "";
  let hint = `Semver, e.g. 1.4.0, or latest to follow the latest on npm. Leave blank to not manage versions. Default: blank.${changed}`;
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
              placeholder="Not set"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              className="settings-mono"
            />
          </Field>
        </SettingsCard>

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
