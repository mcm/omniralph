"use client";

import * as React from "react";
import {
  Badge,
  Button,
  Empty,
  Field,
  Input,
  Muted,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconCloudDownload, IconPackage } from "@tabler/icons-react";
import type { JobStatus } from "@omniralph/db";
import { useAction } from "@/components/use-action";
import { formatDateTime } from "@/lib/format-date";
import { installInstallable } from "../actions";
import { STATUS_BADGES } from "../../jobs/jobs-view";

/** An installable the harness reported in its last heartbeat. */
export interface InstallableRow {
  name: string;
  version: string;
}

/** Serializable `install` job targeted at the harness. */
export interface InstallJobRow {
  id: string;
  status: JobStatus;
  name: string | null;
  /** The requested version; null: `latest`. */
  version: string | null;
  installedVersion: string | null;
  error: string | null;
  /** ISO timestamp. */
  createdAt: string;
}

const mono = { fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" } as const;
const cellText = { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } as const;
const stack = { display: "flex", flexDirection: "column", gap: "var(--space-4)" } as const;

/** The installables the harness reports, by name. */
export function InstalledInstallables({ installables }: { installables: InstallableRow[] }) {
  if (installables.length === 0) {
    return (
      <Empty
        icon={<IconPackage size={24} />}
        title="No installables"
        description="The harness reports none installed."
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Package</TableHead>
          <TableHead>Version</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {installables.map((installable) => (
          <TableRow key={installable.name} data-installable={installable.name}>
            <TableCell>
              <span style={mono}>{installable.name}</span>
            </TableCell>
            <TableCell>
              <span style={mono}>{installable.version}</span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The harness's recent `install` jobs, newest first. */
export function InstallJobs({ jobs }: { jobs: InstallJobRow[] }) {
  if (jobs.length === 0) return <Muted>No installs in the last 24 hours.</Muted>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Requested</TableHead>
          <TableHead>Package</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Details</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id} data-install-job={job.id}>
            <TableCell>
              <span style={cellText}>{formatDateTime(job.createdAt)}</span>
            </TableCell>
            <TableCell>
              <span style={mono}>
                {job.name ?? "—"}@{job.version ?? "latest"}
              </span>
            </TableCell>
            <TableCell>
              <Badge variant={STATUS_BADGES[job.status]}>{job.status}</Badge>
            </TableCell>
            <TableCell>
              {job.error ? (
                <span style={{ ...cellText, color: "var(--text-danger)" }}>{job.error}</span>
              ) : job.installedVersion ? (
                <span style={cellText}>Installed {job.installedVersion}</span>
              ) : (
                <Muted>—</Muted>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** Enqueues an `install` job targeted at the harness. */
export function InstallForm({ harnessId }: { harnessId: string }) {
  const { pending, run } = useAction();
  const [name, setName] = React.useState("");
  const [version, setVersion] = React.useState("latest");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const requested = version.trim() || "latest";
    run(
      () => installInstallable(harnessId, { name, version: requested }),
      `Installing ${name.trim()}@${requested}; the harness picks it up with its next claim.`,
      () => {
        setName("");
        setVersion("latest");
      },
    );
  };

  return (
    <form onSubmit={submit} style={stack} aria-label="Install an installable">
      <div style={{ display: "flex", gap: "var(--space-4)", flexWrap: "wrap" }}>
        <Field
          label="Package name"
          htmlFor="install-name"
          hint="An npm package with an omniralph manifest, e.g. @omniralph/code-graph. The harness only installs packages its local installables.allow allows."
          style={{ flex: 2, minWidth: "16rem" }}
        >
          <Input
            id="install-name"
            name="name"
            required
            disabled={pending}
            placeholder="@omniralph/…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ fontFamily: "var(--font-mono)" }}
          />
        </Field>
        <Field
          label="Version"
          htmlFor="install-version"
          hint="An exact version or a dist-tag."
          style={{ flex: 1, minWidth: "10rem" }}
        >
          <Input
            id="install-version"
            name="version"
            disabled={pending}
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            style={{ fontFamily: "var(--font-mono)" }}
          />
        </Field>
      </div>
      <div>
        <Button type="submit" variant="primary" disabled={pending || !name.trim()}>
          <IconCloudDownload size={14} />
          {pending ? "Installing…" : "Install"}
        </Button>
      </div>
    </form>
  );
}
