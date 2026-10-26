"use client";

import {
  Badge,
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
import { IconTool } from "@tabler/icons-react";
import { PhoneMeta, WIDE_COLUMN } from "@/components/list-table";
import { MonoValue } from "@/components/mono-value";
import type { HostToolRow } from "@/lib/api/agents";
import { HOST_TOOL_PATH_VARIANTS } from "@/lib/state-variants";

export type { HostToolRow };

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

/**
 * Below 768px, where the status and path columns are hidden: what the agent reported,
 * each fact named, since a bare path or "Not configured" says nothing on its own.
 */
function HostToolPhoneFacts({ tool }: { tool: HostToolRow }) {
  return (
    <dl className="host-tool-facts">
      <dt>Configured path</dt>
      <dd>
        <ConfiguredPathStatus tool={tool} />
      </dd>
      <dt>Discovered</dt>
      <dd>
        <DiscoveredPath tool={tool} />
      </dd>
      <dt>Runs from</dt>
      <dd>
        <EffectivePath tool={tool} />
      </dd>
    </dl>
  );
}

/**
 * Every host tool of the organization's catalog on this agent: the configured path (editable
 * unless the agent is revoked, saved by the section around the table), what the agent last
 * reported and the path it runs it from.
 */
export function AgentHostTools({
  revoked,
  hostTools,
  paths,
  onPathChange,
}: {
  revoked: boolean;
  hostTools: HostToolRow[];
  /** The configured path drafts, by host tool id; blank discovers the tool on `PATH`. */
  paths: Readonly<Record<string, string>>;
  onPathChange: (hostToolId: string, path: string) => void;
}) {
  if (hostTools.length === 0) {
    return (
      <Empty
        icon={<IconTool size={24} />}
        title="No host tools"
        titleAs="h3"
        description="Add the tools agent owners install by hand in Settings › Agent defaults."
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
                <HostToolPhoneFacts tool={tool} />
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
                <Input
                  id={`host-tool-path-${tool.hostToolId}`}
                  aria-label={`Configured path of ${tool.name}`}
                  placeholder="Discover on PATH"
                  value={paths[tool.hostToolId] ?? ""}
                  onChange={(e) => onPathChange(tool.hostToolId, e.target.value)}
                  className="agent-path-input font-mono"
                />
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
