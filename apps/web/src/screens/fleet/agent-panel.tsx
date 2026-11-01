"use client";

import {
  Button,
  EmptyState,
  IssueBadge,
  MetaBadge,
  OrgBadge,
  RepoBadge,
  StatusIndicator,
  TextLink,
  Tooltip,
} from "@omniralph/ui";
import { IconHeartbeat } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { formatDuration } from "@/components/runs/progress";
import { ApiError } from "@/lib/api/client";
import type { AgentDetail, FleetAgentRow, RecentAttempt } from "@/lib/api/agents";
import {
  agentStatusLine,
  heartbeatAgo,
  lastSeenText,
  latestHeartbeat,
  shortDate,
  tokenHealth,
} from "@/lib/fleet/status";
import { runHref } from "@/lib/runs/hrefs";
import { useClock } from "../clock";
import { AgentActions } from "./agent-actions";
import { LAST_SEEN_POLL_MS, useAgentDetail, useAgentLastSeen } from "./queries";

/** `/fleet/{id}` for an agent that isn't there (or not in the user's organizations). */
export const AGENT_NOT_FOUND = "This agent doesn't exist.";

/** Finished attempts that didn't succeed: shown in the fail tone (Design rule 15). */
const FAILED_STATUSES: ReadonlySet<RecentAttempt["status"]> = new Set([
  "failed",
  "canceled",
  "expired",
]);

/** "Coder workspace" (the workspace in its tooltip) or the hostname; none before a report. */
function HostBadge({ host }: { host: FleetAgentRow["host"] }) {
  if (!host) return null;
  if (!host.coder) return host.hostname ? <MetaBadge text={host.hostname} mono /> : null;
  return (
    <Tooltip content={`${host.coder.owner}/${host.coder.workspace}`}>
      <span className="or-fleet-agent__host" tabIndex={0}>
        <MetaBadge text="Coder workspace" />
      </span>
    </Tooltip>
  );
}

/**
 * "About 2 min ago": the agent's last heartbeat, the later of the one polled from Redis every
 * 10 s and the detail's, with its clock ticking as often. None for an agent that has never
 * connected (its status says so).
 */
function HeartbeatBadge({ agent }: { agent: AgentDetail["agent"] }) {
  const lastSeen = useAgentLastSeen(agent.id);
  const now = useClock(LAST_SEEN_POLL_MS);
  const heartbeat = latestHeartbeat(agent.lastHeartbeatAt, lastSeen.data?.lastHeartbeatAt);
  if (heartbeat === null) return null;
  const text = heartbeatAgo(heartbeat, new Date(now));
  return (
    <span className="or-fleet-agent__heartbeat" title="Last heartbeat">
      <span className="or-sr-only">Last heartbeat: </span>
      <MetaBadge icon={IconHeartbeat} text={text} />
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `agent-section-${title.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section className="or-fleet-agent__section" aria-labelledby={id}>
      <h3 id={id} className="or-fleet-agent__heading">
        {title}
      </h3>
      {children}
    </section>
  );
}

function None({ children }: { children: ReactNode }) {
  return <p className="or-fleet-agent__none">{children}</p>;
}

function RunningNow({ attempts }: { attempts: AgentDetail["runningNow"] }) {
  if (attempts.length === 0) return null;
  return (
    <Section title="Running now">
      <ul className="or-fleet-agent__list">
        {attempts.map((attempt) => (
          <li key={attempt.id} className="or-fleet-agent__running">
            {attempt.run ? (
              <TextLink href={runHref(attempt.run.id)}>{attempt.run.title}</TextLink>
            ) : (
              <span>{attempt.label}</span>
            )}
            <span className="or-fleet-agent__badges">
              {attempt.repository ? (
                <RepoBadge host={attempt.repository.provider} name={attempt.repository.fullPath} />
              ) : null}
              {attempt.workItem ? (
                <IssueBadge tracker={attempt.workItem.tracker} id={attempt.workItem.identifier} />
              ) : null}
              {attempt.step ? <MetaBadge text={attempt.step} /> : null}
            </span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function RecentWork({ attempts }: { attempts: AgentDetail["recentWork"] }) {
  return (
    <Section title="Recent work">
      {attempts.length === 0 ? (
        <None>No recent work</None>
      ) : (
        <ul className="or-fleet-agent__list">
          {attempts.map((attempt) => {
            const failed = FAILED_STATUSES.has(attempt.status);
            return (
              <li
                key={attempt.id}
                className={
                  failed
                    ? "or-fleet-agent__work or-fleet-agent__work--fail"
                    : "or-fleet-agent__work"
                }
                data-tone={failed ? "fail" : "neutral"}
              >
                {attempt.run ? (
                  <TextLink href={runHref(attempt.run.id)}>{attempt.label}</TextLink>
                ) : (
                  <span>{attempt.label}</span>
                )}
                {attempt.durationMs !== null ? (
                  <span className="or-fleet-agent__duration or-mono">
                    {formatDuration(attempt.durationMs)}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** A line in the fail tone (Design rule 15). */
function FailLine({ children }: { children: ReactNode }) {
  return (
    <p className="or-fleet-agent__line or-fleet-agent__line--fail" data-tone="fail">
      {children}
    </p>
  );
}

/** "Claude isn't signed in" when the agent reports it signed out; nothing otherwise. */
function Models({
  models,
  claude,
}: {
  models: AgentDetail["models"];
  claude: AgentDetail["claude"];
}) {
  return (
    <Section title="Models reported">
      {claude?.status === "signed_out" ? <FailLine>Claude isn&apos;t signed in</FailLine> : null}
      {models.length === 0 ? (
        <None>None reported</None>
      ) : (
        <div className="or-fleet-agent__badges">
          {models.map((model) => (
            <MetaBadge key={model.value} text={model.displayName} />
          ))}
        </div>
      )}
    </Section>
  );
}

function Packages({ detail }: { detail: AgentDetail }) {
  return (
    <Section title="Packages">
      {detail.installables.length === 0 ? (
        <None>None installed</None>
      ) : (
        <div className="or-fleet-agent__badges">
          {detail.installables.map((pkg) => (
            <MetaBadge key={pkg.name} text={`${pkg.name}@${pkg.version}`} mono />
          ))}
        </div>
      )}
      {detail.installs.length > 0 ? (
        <ul className="or-fleet-agent__list">
          {detail.installs.map((install) => {
            const name = install.name ?? "a package";
            return install.state === "installing" ? (
              <li key={install.id} className="or-fleet-agent__install">
                Installing {name}…
              </li>
            ) : (
              <li
                key={install.id}
                className="or-fleet-agent__install or-fleet-agent__install--fail"
                data-tone="fail"
              >
                Couldn&apos;t install {name}
                {install.error ? `: ${install.error}` : ""}
              </li>
            );
          })}
        </ul>
      ) : null}
    </Section>
  );
}

/**
 * The agent's token health (`tokenHealth`): nothing while it can authenticate, else a
 * Security section with the problem (fail tone) and, while refreshes fail, its last error.
 */
function Security({ detail, now }: { detail: AgentDetail; now: number }) {
  const { agent, security } = detail;
  const health = tokenHealth(
    {
      revoked: agent.revoked,
      online: agent.online,
      lastHeartbeatAt: agent.lastHeartbeatAt,
      ...security,
    },
    new Date(now),
  );
  if (!health) return null;
  return (
    <Section title="Security">
      <FailLine>{health.label}</FailLine>
      {health.detail ? (
        <p className="or-fleet-agent__line or-fleet-agent__line--muted">{health.detail}</p>
      ) : null}
    </Section>
  );
}

/**
 * The open agent (Design board Fleet): its organization (under All organizations) and ⋯
 * menu, status line, mono name, host and enrollment badges, the host tools its playbooks
 * require that it lacks, then Running now (only while something runs), Recent work, Models
 * reported, Packages and Security. Read-only: slots, accepted kinds, host tools, the pin and
 * the allow-list are set on the agent's own page and only shown here as it reports them.
 */
export function AgentPanelContent({
  detail,
  showOrganization,
}: {
  detail: AgentDetail;
  showOrganization: boolean;
}) {
  const { agent } = detail;
  const status = agentStatusLine(agent);
  const now = useClock();
  return (
    <article className="or-fleet-agent" aria-labelledby={`agent-${agent.id}`}>
      <div className="or-fleet-agent__top">
        {showOrganization ? <OrgBadge name={agent.organization.name} /> : <span />}
        <AgentActions detail={detail} />
      </div>
      <StatusIndicator
        tone={status.tone}
        label={status.label}
        tooltip={lastSeenText(agent, new Date(now))}
      />
      <h2 id={`agent-${agent.id}`} className="or-fleet-agent__name or-mono">
        {agent.name}
      </h2>
      <div className="or-fleet-agent__badges">
        <HostBadge host={agent.host} />
        <MetaBadge text={`Enrolled ${shortDate(agent.createdAt)}`} />
        <HeartbeatBadge agent={agent} />
      </div>
      {detail.missingRequiredHostTools.length > 0 ? (
        <FailLine>Missing host tools: {detail.missingRequiredHostTools.join(", ")}</FailLine>
      ) : null}
      <RunningNow attempts={detail.runningNow} />
      <RecentWork attempts={detail.recentWork} />
      <Models models={detail.models} claude={detail.claude} />
      <Packages detail={detail} />
      <Security detail={detail} now={now} />
    </article>
  );
}

/** The agent's panel from its live detail query; "This agent doesn't exist." on a 404. */
export function AgentPanel({
  agentId,
  showOrganization,
}: {
  agentId: string;
  showOrganization: boolean;
}) {
  const detail = useAgentDetail(agentId);
  if (detail.isPending) return <div className="or-fleet-agent" aria-busy="true" />;
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return <EmptyState title={AGENT_NOT_FOUND} />;
    }
    return (
      <EmptyState
        title="Couldn't load this agent"
        description={detail.error.message}
        action={
          <Button variant="outline" onClick={() => void detail.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  return <AgentPanelContent detail={detail.data} showOrganization={showOrganization} />;
}
