"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Empty,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@iamthemcmaster/ui";
import { IconAlertTriangle, IconHistory } from "@tabler/icons-react";
import {
  AUDIT_EVENT_LABELS,
  auditDetailSummary,
  hasRefreshReuse,
  type AuditEventName,
} from "@/lib/harnesses/display";
import { HARNESS_AUDIT_EVENT_VARIANTS } from "@/lib/state-variants";
import { EmptyValue } from "@/components/empty-value";
import { Timestamp } from "@/components/list-table";

/** Serializable `harness_audit` row. */
export interface AuditRow {
  id: string;
  event: AuditEventName;
  ip: string | null;
  detail: Record<string, unknown>;
  /** ISO timestamp. */
  createdAt: string;
}

/** Shown above everything else when the audit log contains a `refresh_reuse` event. */
export function TokenTheftAlert({ audit }: { audit: AuditRow[] }) {
  if (!hasRefreshReuse(audit)) return null;
  const reuse = audit.find((e) => e.event === "refresh_reuse")!;
  return (
    <Alert variant="danger" role="alert">
      <IconAlertTriangle size={16} />
      <AlertTitle as="h2">Possible token theft</AlertTitle>
      <AlertDescription>
        An already used refresh token for this harness was presented again on{" "}
        <Timestamp iso={reuse.createdAt} inline />
        {reuse.ip ? ` from ${reuse.ip}` : ""}. Either the harness&apos;s token file was copied, or
        the harness failed to save its rotated token. The harness was revoked automatically; check
        the host before enrolling it again.
      </AlertDescription>
    </Alert>
  );
}

/** The harness's most recent audit events, newest first. */
export function HarnessAuditLog({ audit }: { audit: AuditRow[] }) {
  if (audit.length === 0) {
    return (
      <Empty
        icon={<IconHistory size={24} />}
        title="No events yet"
        titleAs="h3"
        description="Nothing recorded."
      />
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>Event</TableHead>
          <TableHead>Details</TableHead>
          <TableHead>IP</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {audit.map((entry) => {
          const label = AUDIT_EVENT_LABELS[entry.event];
          const summary = auditDetailSummary(entry.event, entry.detail);
          return (
            <TableRow key={entry.id} data-event={entry.event}>
              <TableCell>
                <Timestamp iso={entry.createdAt} />
              </TableCell>
              <TableCell>
                <Badge variant={HARNESS_AUDIT_EVENT_VARIANTS[entry.event]}>{label}</Badge>
              </TableCell>
              <TableCell>
                {summary ? (
                  <span className="text-sm text-text-primary">{summary}</span>
                ) : (
                  <EmptyValue />
                )}
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs text-text-tertiary">
                  {entry.ip ?? <EmptyValue />}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
