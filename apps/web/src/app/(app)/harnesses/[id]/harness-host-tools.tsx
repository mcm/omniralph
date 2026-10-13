"use client";

import * as React from "react";
import {
  Badge,
  Button,
  Empty,
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
import { IconDeviceFloppy, IconTool } from "@tabler/icons-react";
import { PhoneMeta, WIDE_COLUMN } from "@/components/list-table";
import { MonoValue } from "@/components/mono-value";
import { useAction } from "@/components/use-action";
import { HOST_TOOL_PATH_VARIANTS } from "@/lib/state-variants";
import { setHostToolPath } from "../actions";

/** Serializable catalog host tool on the harness (`HarnessHostTool` of `@omniralph/db`). */
export interface HostToolRow {
  hostToolId: string;
  name: string;
  description: string | null;
  configuredPath: string | null;
  /** Whether the configured path exists, as last reported; null: not reported on it yet. */
  configuredPathExists: boolean | null;
  discoveredPath: string | null;
  /** ISO timestamp of the harness's last report on the tool; null: never. */
  reportedAt: string | null;
  /** `effectiveHostToolPath()`: the path the harness runs the tool from; null: unavailable. */
  effectivePath: string | null;
}

function ConfiguredPathStatus({ tool }: { tool: HostToolRow }) {
  if (tool.configuredPath === null) return <Muted>Not configured</Muted>;
  if (tool.configuredPathExists === null) {
    return <Badge variant={HOST_TOOL_PATH_VARIANTS.unchecked}>Not checked yet</Badge>;
  }
  return tool.configuredPathExists ? (
    <Badge variant={HOST_TOOL_PATH_VARIANTS.exists}>Exists</Badge>
  ) : (
    <Badge variant={HOST_TOOL_PATH_VARIANTS.missing}>Missing</Badge>
  );
}

function DiscoveredPath({ tool }: { tool: HostToolRow }) {
  if (tool.discoveredPath) return <MonoValue value={tool.discoveredPath} className="text-sm" />;
  return <Muted>{tool.reportedAt ? "Not found on PATH" : "Not reported yet"}</Muted>;
}

function EffectivePath({ tool }: { tool: HostToolRow }) {
  if (tool.effectivePath) return <MonoValue value={tool.effectivePath} className="text-sm" />;
  return <Badge variant={HOST_TOOL_PATH_VARIANTS.unavailable}>Unavailable</Badge>;
}

/** Sets or (blank) clears the tool's configured path on the harness. */
function ConfiguredPathForm({ harnessId, tool }: { harnessId: string; tool: HostToolRow }) {
  const { pending, run } = useAction();
  const [path, setPath] = React.useState(tool.configuredPath ?? "");

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = path.trim();
    run(
      () => setHostToolPath(harnessId, tool.hostToolId, path),
      trimmed
        ? `${tool.name} will run from ${trimmed} once the harness finds it there.`
        : `Cleared. The harness uses the ${tool.name} it finds on its PATH.`,
    );
  };

  return (
    <form onSubmit={save} className="harness-inline-form">
      <Input
        id={`host-tool-path-${tool.hostToolId}`}
        aria-label={`Configured path of ${tool.name}`}
        name="path"
        placeholder="Discover on PATH"
        disabled={pending}
        value={path}
        onChange={(e) => setPath(e.target.value)}
        className="harness-path-input font-mono"
      />
      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        <IconDeviceFloppy size={14} />
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

/**
 * Every host tool of the organization's catalog on this harness: the configured path (editable
 * unless the harness is revoked), what the harness last reported and the path it runs it from.
 */
export function HarnessHostTools({
  harnessId,
  revoked,
  hostTools,
}: {
  harnessId: string;
  revoked: boolean;
  hostTools: HostToolRow[];
}) {
  if (hostTools.length === 0) {
    return (
      <Empty
        icon={<IconTool size={24} />}
        title="No host tools"
        titleAs="h3"
        description="Add the tools harness owners install by hand in Settings › Harness defaults."
      />
    );
  }
  return (
    <Table className="list-table host-tools-table">
      <TableHeader>
        <TableRow>
          <TableHead>Tool</TableHead>
          <TableHead>Configured path</TableHead>
          <TableHead className={WIDE_COLUMN}>Configured path exists</TableHead>
          <TableHead className={WIDE_COLUMN}>Discovered path</TableHead>
          <TableHead className={WIDE_COLUMN}>Effective path</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {hostTools.map((tool) => (
          <TableRow key={tool.hostToolId} data-host-tool={tool.name}>
            <TableCell>
              <Stack gap={1}>
                <MonoValue value={tool.name} className="text-sm" />
                {tool.description && <Muted>{tool.description}</Muted>}
              </Stack>
              <PhoneMeta>
                <ConfiguredPathStatus tool={tool} />
                <EffectivePath tool={tool} />
              </PhoneMeta>
            </TableCell>
            <TableCell>
              {revoked ? (
                tool.configuredPath ? (
                  <MonoValue value={tool.configuredPath} className="text-sm" />
                ) : (
                  <Muted>Not configured</Muted>
                )
              ) : (
                <ConfiguredPathForm harnessId={harnessId} tool={tool} />
              )}
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <ConfiguredPathStatus tool={tool} />
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <DiscoveredPath tool={tool} />
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <EffectivePath tool={tool} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
