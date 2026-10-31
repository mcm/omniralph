"use client";

import { AgentBadge, BranchBadge, ChangeBadge, MetaBadge, RepoBadge, Tooltip } from "@omniralph/ui";
import { IconCoin, IconRepeat } from "@tabler/icons-react";
import type { RunDetail } from "@/lib/api/runs";
import { COST_NOTE, formatUsd } from "@/lib/cost/format";
import { agentHref } from "@/lib/runs/hrefs";
import { attemptsText, formatTokens } from "./details";
import "./run-details.css";

/** Whether the run works in more than one repo (a multi-repo epic): `RunLanes` lists them. */
export function isMultiRepo(run: Pick<RunDetail, "details">): boolean {
  return run.details.lanes.length > 1;
}

/**
 * The run's facts as header badges, after its identity (Design rules 1 and 13): its branch
 * (a multi-repo epic's are in `RunLanes`), its agent (linking to its Fleet page), tokens in
 * and tokens out (two badges, none before any were spent), its list price (when every token-bearing attempt is priced,
 * with what it means as its tooltip) and how many attempts it took (none before the first).
 * How its repo was routed is in its Activity.
 */
export function RunFactBadges({ run }: { run: RunDetail }) {
  const { details } = run;
  const branch = details.branch ?? run.branch;
  return (
    <>
      {branch && !isMultiRepo(run) ? <BranchBadge name={branch} /> : null}
      {details.agent ? (
        <AgentBadge name={details.agent.name} href={agentHref(details.agent.id)} />
      ) : null}
      {details.tokens.in > 0 || details.tokens.out > 0 ? (
        <>
          <MetaBadge text={`${formatTokens(details.tokens.in)} in`} mono />
          <MetaBadge text={`${formatTokens(details.tokens.out)} out`} mono />
        </>
      ) : null}
      {typeof details.costUsd === "number" ? (
        <Tooltip content={COST_NOTE}>
          <span className="or-run-facts__cost" title={COST_NOTE} tabIndex={0}>
            <MetaBadge icon={IconCoin} text={formatUsd(details.costUsd)} mono />
          </span>
        </Tooltip>
      ) : null}
      {details.attemptCount > 0 ? (
        <MetaBadge icon={IconRepeat} text={attemptsText(details.attemptCount)} />
      ) : null}
    </>
  );
}

/** A multi-repo epic's lanes, one line each: its repo, branch and PR/MR. Nothing otherwise. */
export function RunLanes({ run }: { run: RunDetail }) {
  if (!isMultiRepo(run)) return null;
  return (
    <ul className="or-run-lanes" aria-label="Repos">
      {run.details.lanes.map((lane) => (
        <li key={lane.id} className="or-run-lanes__lane">
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
  );
}
