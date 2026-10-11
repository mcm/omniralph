"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Empty,
  Muted,
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
import { formatDateTime } from "@/lib/format-date";

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
    <Alert variant="destructive" role="alert">
      <IconAlertTriangle size={16} />
      <AlertTitle>Possible token theft</AlertTitle>
      <AlertDescription>
        An already used refresh token for this harness was presented again on{" "}
        {formatDateTime(reuse.createdAt)}
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
          const { label, tone } = AUDIT_EVENT_LABELS[entry.event];
          const summary = auditDetailSummary(entry.event, entry.detail);
          return (
            <TableRow key={entry.id} data-event={entry.event}>
              <TableCell>
                <span style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}>
                  {formatDateTime(entry.createdAt)}
                </span>
              </TableCell>
              <TableCell>
                <Badge variant={tone}>{label}</Badge>
              </TableCell>
              <TableCell>
                {summary ? (
                  <span style={{ fontSize: "var(--text-sm)", color: "var(--text-primary)" }}>
                    {summary}
                  </span>
                ) : (
                  <Muted>—</Muted>
                )}
              </TableCell>
              <TableCell>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                    color: "var(--text-tertiary)",
                  }}
                >
                  {entry.ip ?? "—"}
                </span>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
