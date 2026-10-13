"use client";

import * as React from "react";
import {
  Button,
  Cluster,
  Empty,
  Field,
  Input,
  Muted,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconCloudDownload, IconPackage } from "@tabler/icons-react";
import type { JobStatus } from "@omniralph/db";
import { PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { MonoValue } from "@/components/mono-value";
import { useAction } from "@/components/use-action";
import { installInstallable } from "../actions";
import { JobStatusBadge } from "@/components/ralph-badges";
import { EmptyValue } from "@/components/empty-value";

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

/** The installables the harness reports, by name. */
export function InstalledInstallables({ installables }: { installables: InstallableRow[] }) {
  if (installables.length === 0) {
    return (
      <Empty
        icon={<IconPackage size={24} />}
        title="No installables"
        titleAs="h3"
        description="The harness reports none installed."
      />
    );
  }
  return (
    <Table className="list-table">
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
              <MonoValue value={installable.name} className="text-sm" />
            </TableCell>
            <TableCell>
              <MonoValue value={installable.version} className="text-sm" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The harness's recent `install` jobs, newest first. */
/** An install job's outcome: its error, the version it installed, or nothing yet. */
function InstallJobDetails({ job }: { job: InstallJobRow }) {
  if (job.error) return <span className="list-text list-text-danger">{job.error}</span>;
  if (job.installedVersion) {
    return <span className="list-text">Installed {job.installedVersion}</span>;
  }
  return <EmptyValue />;
}

export function InstallJobs({ jobs }: { jobs: InstallJobRow[] }) {
  if (jobs.length === 0) return <Muted>No installs in the last 24 hours.</Muted>;
  return (
    <Table className="list-table">
      <TableHeader>
        <TableRow>
          <TableHead className={WIDE_COLUMN}>Requested</TableHead>
          <TableHead>Package</TableHead>
          <TableHead className={WIDE_COLUMN}>Status</TableHead>
          <TableHead className={WIDE_COLUMN}>Details</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id} data-install-job={job.id}>
            <TableCell className={WIDE_COLUMN}>
              <Timestamp iso={job.createdAt} />
            </TableCell>
            <TableCell>
              <span className="font-mono text-sm">
                {job.name ?? <EmptyValue />}@{job.version ?? "latest"}
              </span>
              <PhoneMeta>
                <JobStatusBadge job={job} />
                {(job.error || job.installedVersion) && <InstallJobDetails job={job} />}
                <Timestamp iso={job.createdAt} />
              </PhoneMeta>
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <JobStatusBadge job={job} />
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <InstallJobDetails job={job} />
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
    <Stack asChild>
      <form onSubmit={submit} aria-label="Install an installable">
        <Cluster gap={4} align="stretch">
          <Field
            label="Package name"
            htmlFor="install-name"
            description="An npm package with an omniralph manifest, e.g. @omniralph/code-graph. The harness only installs packages its local installables.allow allows."
            className="harness-install-name"
          >
            <Input
              id="install-name"
              name="name"
              required
              disabled={pending}
              placeholder="@omniralph/…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="font-mono"
            />
          </Field>
          <Field
            label="Version"
            htmlFor="install-version"
            description="An exact version or a dist-tag."
            className="harness-install-version"
          >
            <Input
              id="install-version"
              name="version"
              disabled={pending}
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              className="font-mono"
            />
          </Field>
        </Cluster>
        <div>
          <Button type="submit" variant="primary" disabled={pending || !name.trim()}>
            <IconCloudDownload size={14} />
            {pending ? "Installing…" : "Install"}
          </Button>
        </div>
      </form>
    </Stack>
  );
}
