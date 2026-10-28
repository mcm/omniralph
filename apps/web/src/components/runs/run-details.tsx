"use client";

import {
  AgentBadge,
  BranchBadge,
  ChangeBadge,
  DetailsSection,
  MetaBadge,
  RepoBadge,
} from "@omniralph/ui";
import { IconFolder, IconTag, IconUsers } from "@tabler/icons-react";
import type { ReactNode } from "react";
import type { RunDetail } from "@/lib/api/runs";
import { agentHref } from "@/lib/runs/hrefs";
import { CostFigure } from "./cost-figure";
import { routedByParts, tokensText } from "./details";
import "./run-details.css";

const ROUTE_ICONS = { team: IconUsers, project: IconFolder, label: IconTag } as const;

/** "Routed by" with the teams, projects and labels it names as badges. */
function RoutedBy({ routedBy }: { routedBy: string }) {
  return (
    <>
      {routedByParts(routedBy).map((part, index) =>
        part.kind === "text" ? (
          <span key={index}>{part.text}</span>
        ) : (
          <MetaBadge
            key={index}
            icon={ROUTE_ICONS[part.kind]}
            text={part.name}
            mono={part.kind !== "project"}
          />
        ),
      )}
    </>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="or-run-details__row">
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * The run detail's Details section (collapsed, Design rule 16): Repo, Branch, Routed by,
 * Agent (linking to its Fleet page), Tokens, Cost (when every token-bearing attempt is
 * priced) and Attempts. A multi-repo epic lists each
 * lane's repo, branch and PR/MR instead of one repo and branch.
 */
export function RunDetails({ run }: { run: RunDetail }) {
  const { details } = run;
  const repository = details.repository ?? run.repository;
  const branch = details.branch ?? run.branch;
  const multiRepo = details.lanes.length > 1;
  return (
    <DetailsSection className="or-run-details">
      <dl className="or-run-details__list">
        {multiRepo ? (
          <Row term="Repos">
            <ul className="or-run-details__lanes" aria-label="Repos">
              {details.lanes.map((lane) => (
                <li key={lane.id} className="or-run-details__lane">
                  <RepoBadge host={lane.repository.provider} name={lane.repository.fullPath} />
                  <BranchBadge name={lane.branch} />
                  {lane.pullRequest ? (
                    <ChangeBadge
                      host={lane.pullRequest.provider}
                      number={lane.pullRequest.number}
                      href={lane.pullRequest.url ?? undefined}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </Row>
        ) : (
          <>
            {repository ? (
              <Row term="Repo">
                <RepoBadge host={repository.provider} name={repository.fullPath} />
              </Row>
            ) : null}
            {branch ? (
              <Row term="Branch">
                <BranchBadge name={branch} />
              </Row>
            ) : null}
          </>
        )}
        {details.routedBy ? (
          <Row term="Routed by">
            <RoutedBy routedBy={details.routedBy} />
          </Row>
        ) : null}
        {details.agent ? (
          <Row term="Agent">
            <AgentBadge name={details.agent.name} href={agentHref(details.agent.id)} />
          </Row>
        ) : null}
        <Row term="Tokens">{tokensText(details.tokens)}</Row>
        {typeof details.costUsd === "number" ? (
          <Row term="Cost">
            <CostFigure usd={details.costUsd} />
          </Row>
        ) : null}
        <Row term="Attempts">{String(details.attemptCount)}</Row>
      </dl>
    </DetailsSection>
  );
}
