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
  Muted,
} from "@iamthemcmaster/ui";
import { IconCloudDownload, IconDeviceFloppy } from "@tabler/icons-react";
import { AppHeader } from "@/components/app-header";
import { useAction } from "@/components/use-action";
import { formatDateTime } from "@/lib/format-date";
import { setGlobalHarnessVersion, trackLatestHarnessVersion } from "./actions";

export function AgentSettingsView({
  desiredVersion,
  updatedAt,
  latest,
  packageName,
}: {
  /** A version, `latest` or null. */
  desiredVersion: string | null;
  /** ISO timestamp of the last change. */
  updatedAt: string | null;
  /** Tracking `latest`: the version last read from npm (`checkedAt` is ISO), or why reading failed. */
  latest: { version: string | null; error: string | null; checkedAt: string | null } | null;
  packageName: string;
}) {
  const { pending, run } = useAction();
  const [version, setVersion] = React.useState(desiredVersion ?? "");

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = version.trim();
    run(
      () => setGlobalHarnessVersion(version),
      trimmed.toLowerCase() === "latest"
        ? "Agents will follow the latest version on npm."
        : trimmed
          ? `Agents will update to ${trimmed} with their next heartbeat.`
          : "Cleared. Agents keep the version they run.",
    );
  };

  const changed = updatedAt ? ` Last changed ${formatDateTime(updatedAt)}.` : "";
  let hint = `Semver, e.g. 1.4.0, or latest to follow the latest on npm. Leave blank to not manage versions.${changed}`;
  if (latest) {
    const read = latest.checkedAt ? ` (read ${formatDateTime(latest.checkedAt)})` : "";
    hint = latest.error
      ? `Following the latest on npm, but reading it failed: ${latest.error}.${latest.version ? ` Agents stay on ${latest.version} meanwhile.` : ""}${changed}`
      : `Following the latest on npm: ${latest.version ?? "not read yet"}${read}. npm is read again every few minutes.${changed}`;
  }

  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Settings" }, { label: "Agents" }]} />
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
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: "var(--text-2xl)",
              fontWeight: "var(--font-weight-semibold)",
            }}
          >
            Agent settings
          </h1>
          <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
            Settings every agent of this organization gets with its heartbeat.
          </Muted>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Agent version</CardTitle>
            <CardDescription>
              The version of <InlineCode>{packageName}</InlineCode> agents should run, or{" "}
              <InlineCode>latest</InlineCode> to update them with each release. Agents under pm2
              stop taking jobs, let running ones finish (up to 2 hours), install it and restart; a
              version that doesn&apos;t stay up is rolled back and not tried again on that agent
              unless you use &quot;Update now&quot; on its page. Other agents show &quot;Update
              manually&quot;. An agent&apos;s own override (on its page) wins over this one.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={save}
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)" }}
            >
              <Field label="Desired version" htmlFor="desired-version" hint={hint}>
                <Input
                  id="desired-version"
                  placeholder="Not set"
                  disabled={pending}
                  value={version}
                  onChange={(e) => setVersion(e.target.value)}
                  style={{ fontFamily: "var(--font-mono)" }}
                />
              </Field>
              <div style={{ display: "flex", gap: "var(--space-2)" }}>
                <Button type="submit" variant="primary" disabled={pending}>
                  <IconDeviceFloppy size={14} />
                  {pending ? "Saving…" : "Save"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const result = await trackLatestHarnessVersion();
                      if (result.ok) setVersion("latest");
                      return result;
                    }, "Agents will follow the latest version on npm.")
                  }
                >
                  <IconCloudDownload size={14} />
                  Track latest on npm
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </main>
    </>
  );
}
