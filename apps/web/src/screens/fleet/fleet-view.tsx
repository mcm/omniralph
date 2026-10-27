"use client";

import {
  Button,
  DataTable,
  EmptyState,
  MetaBadge,
  OrgBadge,
  RepoBadge,
  SplitView,
  StatusText,
  SummaryCells,
  useSplitWide,
  type DataTableColumn,
  type SummaryCell,
} from "@omniralph/ui";
import { IconPlus } from "@tabler/icons-react";
import { useRef, useState, type ReactNode } from "react";
import { ChangeHistoryPopover } from "@/components/change-history-popover";
import { useCurrentUser } from "@/components/current-user";
import type { FleetAgentRow, FleetSummary } from "@/lib/api/agents";
import type { SettingsHistoryEntry } from "@/lib/api/settings-history";
import {
  acceptedKindsSummary,
  pinBadges,
  versionPolicyLabel,
  versionSummary,
} from "@/lib/fleet/status";
import { agentHref } from "@/lib/runs/hrefs";
import { AgentPanel } from "./agent-panel";
import { EnrollSheet } from "./enroll-sheet";
import { useFleet } from "./queries";
import { VersionPolicySheet } from "./version-policy-sheet";
import "./fleet.css";

/** Fleet's list. */
export const FLEET_PATH = "/fleet";

/** The side panel's width: the table fills the rest. */
const PANEL_WIDTH = { wide: 420, narrow: 360 };

/** Revoked agents last, the rest by name. */
export function sortFleet(agents: readonly FleetAgentRow[]): FleetAgentRow[] {
  return [...agents].sort(
    (a, b) => Number(a.revoked) - Number(b.revoked) || a.name.localeCompare(b.name),
  );
}

/** "6 of 7 online · 1 offline" (the offline part coral, absent at zero). */
function HealthValue({ summary }: { summary: FleetSummary }) {
  return (
    <>
      {summary.online} of {summary.total} online
      {summary.offline > 0 ? (
        <>
          {" · "}
          <span className="or-fleet__fail">{summary.offline} offline</span>
        </>
      ) : null}
    </>
  );
}

/** "All agents on 2.0.3", "2 agents behind" or "1 update failed" (coral). */
function VersionDetail({ summary }: { summary: FleetSummary }) {
  const detail = versionSummary(summary.versionPolicy, summary.versions);
  if (detail.kind === "update_failed")
    return <span className="or-fleet__fail">{detail.label}</span>;
  if (detail.kind === "behind") return <>{detail.label}</>;
  return (
    <span className="or-fleet__on">
      {detail.label}
      {detail.version ? <MetaBadge text={detail.version} mono /> : null}
    </span>
  );
}

export interface FleetSummaryOptions {
  /** The version policy's latest change, for the cell's ⓘ; undefined: no ⓘ (all organizations). */
  versionHistory?: SettingsHistoryEntry | null;
  /** Opens the version policy sheet; undefined: no "Edit" (members, all organizations). */
  onEditVersion?: () => void;
}

/**
 * Health, Version policy and Org defaults (Design board Fleet). Only the Version policy cell
 * has an ⓘ and an "Edit": accepted kinds and concurrency are each agent's own (Epic 11).
 */
export function fleetSummaryCells(
  summary: FleetSummary,
  { versionHistory, onEditVersion }: FleetSummaryOptions = {},
): SummaryCell[] {
  return [
    {
      id: "health",
      label: "Health",
      value: <HealthValue summary={summary} />,
      detail: `${summary.busy} busy`,
    },
    {
      id: "version",
      label: "Version policy",
      value: versionPolicyLabel(summary.versionPolicy),
      detail: (
        <span className="or-fleet__version">
          <VersionDetail summary={summary} />
          {onEditVersion ? (
            <button type="button" className="or-link or-fleet__edit" onClick={onEditVersion}>
              Edit
            </button>
          ) : null}
        </span>
      ),
      ...(versionHistory !== undefined
        ? {
            info: <ChangeHistoryPopover section="agent_defaults" latest={versionHistory} />,
          }
        : {}),
    },
    {
      id: "defaults",
      label: "Org defaults",
      value: acceptedKindsSummary(summary.acceptedKinds),
    },
  ];
}

function AgentStatus({ agent }: { agent: FleetAgentRow }) {
  return <StatusText tone={agent.status.tone}>{agent.status.label}</StatusText>;
}

/** One or two repo badges, or the first and "+N". */
function PinnedRepos({ agent }: { agent: FleetAgentRow }) {
  const { shown, more } = pinBadges(agent.pinnedRepositories);
  if (shown.length === 0) return <span className="or-fleet__none">None</span>;
  return (
    <span className="or-fleet__pins">
      {shown.map((repo) => (
        <RepoBadge key={repo.id} host={repo.provider} name={repo.fullPath} />
      ))}
      {more > 0 ? <MetaBadge text={`+${more}`} mono /> : null}
    </span>
  );
}

/** The table's columns; Org only under "All organizations" (Design rule 13). */
export function fleetColumns(showOrganization: boolean): DataTableColumn<FleetAgentRow>[] {
  return [
    {
      id: "agent",
      header: "Agent",
      cell: (agent) => agent.name,
      card: "title",
      mono: true,
    },
    {
      id: "status",
      header: "Status",
      cell: (agent) => <AgentStatus agent={agent} />,
      card: "status",
    },
    {
      id: "pins",
      header: "Pinned repos",
      cell: (agent) => <PinnedRepos agent={agent} />,
    },
    ...(showOrganization
      ? [
          {
            id: "organization",
            header: "Org",
            cell: (agent: FleetAgentRow) => <OrgBadge name={agent.organization.name} />,
          },
        ]
      : []),
  ];
}

export interface FleetViewProps {
  /** The open agent (`/fleet/{id}`), whose row is current; none on `/fleet`. */
  agentId?: string | null;
  /** The detail beside the table; `AgentPanel` by default. */
  renderDetail?: (agentId: string, showOrganization: boolean) => ReactNode;
}

const defaultDetail = (agentId: string, showOrganization: boolean) => (
  <AgentPanel key={agentId} agentId={agentId} showOrganization={showOrganization} />
);

/**
 * Fleet (Design board Fleet): "Fleet" with Enroll (admins), the summary card and the agents
 * of the user's scope, a table beside the open agent's panel (on `/fleet`, the first
 * agent's, when both fit). Below 880 px only one pane shows: the table on `/fleet`, the
 * agent with "‹ Fleet" on `/fleet/{id}`; at 768 px and narrower the rows are cards. The list
 * is a live query; online and offline come from the server.
 */
export function FleetView({ agentId = null, renderDetail = defaultDetail }: FleetViewProps) {
  const user = useCurrentUser();
  const showOrganization = user.scope === "all";
  const admin = user.role === "admin";
  const fleet = useFleet();
  const agents = fleet.data ? sortFleet(fleet.data.agents) : undefined;
  const splitRef = useRef<HTMLDivElement>(null);
  const wide = useSplitWide(splitRef);
  const [enrolling, setEnrolling] = useState(false);
  const [editingVersion, setEditingVersion] = useState(false);
  // The version policy is one organization's: its ⓘ and Edit show only with one selected.
  const versionPolicy = showOrganization ? null : (fleet.data?.summary.versionPolicy ?? null);
  // Without an agent in the URL, a wide container shows the first agent beside the table.
  const shownId = agentId ?? (wide ? (agents?.[0]?.id ?? null) : null);

  const enroll = (
    <Button variant="outline" size="sm" icon={IconPlus} onClick={() => setEnrolling(true)}>
      Enroll
    </Button>
  );

  const list = (
    <div className="or-fleet__list">
      <div className="or-fleet__head">
        <h1 className="or-fleet__title">Fleet</h1>
        {admin ? enroll : null}
      </div>
      <div className="or-fleet__body">
        {fleet.isError && !agents ? (
          <EmptyState
            title="Couldn't load agents"
            description={fleet.error.message}
            action={
              <Button variant="outline" onClick={() => void fleet.refetch()}>
                Try again
              </Button>
            }
          />
        ) : agents === undefined ? null : agents.length === 0 ? (
          <EmptyState
            title="No agents yet"
            action={
              admin ? (
                <Button variant="outline" icon={IconPlus} onClick={() => setEnrolling(true)}>
                  Enroll
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <SummaryCells
              aria-label="Summary"
              cells={fleetSummaryCells(fleet.data!.summary, {
                versionHistory: showOrganization ? undefined : fleet.data!.versionHistory,
                onEditVersion: admin && versionPolicy ? () => setEditingVersion(true) : undefined,
              })}
            />
            <DataTable
              className="or-fleet__table"
              caption="Agents"
              rows={agents}
              getRowId={(agent) => agent.id}
              getRowHref={(agent) => agentHref(agent.id)}
              selectedId={shownId ?? undefined}
              columns={fleetColumns(showOrganization)}
            />
          </>
        )}
      </div>
    </div>
  );

  return (
    <>
      <SplitView
        ref={splitRef}
        className="or-fleet"
        list={list}
        detail={shownId ? renderDetail(shownId, showOrganization) : null}
        view={agentId ? "detail" : "list"}
        backLink={{ label: "Fleet", href: FLEET_PATH }}
        listLabel="Fleet"
        detailLabel="Agent"
        fixedPane="detail"
        listWidth={PANEL_WIDTH}
      />
      {admin ? <EnrollSheet open={enrolling} onOpenChange={setEnrolling} /> : null}
      {admin && versionPolicy ? (
        <VersionPolicySheet
          open={editingVersion}
          onOpenChange={setEditingVersion}
          policy={versionPolicy}
        />
      ) : null}
    </>
  );
}
