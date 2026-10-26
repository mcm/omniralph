"use client";

import {
  AgentBadge,
  ChangeBadge,
  IssueBadge,
  MetaBadge,
  OrgBadge,
  RepoBadge,
  SizeBadge,
} from "@omniralph/ui";
import { IconEye, IconPlayerPlay } from "@tabler/icons-react";
import type { InboxItem } from "@/lib/api/inbox";
import { agentHref } from "@/lib/runs/hrefs";
import { openFindingsCount, RUN_KIND_LABELS } from "./labels";

/**
 * A row's badges, in order (Design rules 1, 8 and 13): the organization (only under "All
 * organizations"), the work item, the PR/MR, the repo, the agent, then the size of a ready
 * PRD and the open findings of a PR/MR ready for review. Plain badges: the row link covers the row.
 */
export function InboxRowBadges({
  item,
  showOrganization,
}: {
  item: InboxItem;
  showOrganization: boolean;
}) {
  const findings = item.kind === "pr_waiting" ? openFindingsCount(item) : 0;
  return (
    <>
      {showOrganization ? <OrgBadge name={item.organization.name} /> : null}
      {item.workItem ? <IssueBadge tracker="linear" id={item.workItem.identifier} /> : null}
      {item.pullRequest ? (
        <ChangeBadge host={item.pullRequest.provider} number={item.pullRequest.number} />
      ) : null}
      {item.repository ? (
        <RepoBadge host={item.repository.provider} name={item.repository.fullPath} />
      ) : null}
      {item.agent ? <AgentBadge name={item.agent.name} /> : null}
      {item.size ? <SizeBadge size={item.size} /> : null}
      {findings > 0 ? (
        <MetaBadge icon={IconEye} text={`${findings} ${findings === 1 ? "finding" : "findings"}`} />
      ) : null}
    </>
  );
}

/**
 * The detail header's badges: the organization first (only under "All organizations"),
 * then the run kind, the work item, the repo, the PR/MR, the agent (linked to Fleet) and a
 * ready PRD's size, linked where they have a page.
 */
export function InboxHeaderBadges({
  item,
  showOrganization,
}: {
  item: InboxItem;
  showOrganization: boolean;
}) {
  return (
    <>
      {showOrganization ? <OrgBadge name={item.organization.name} /> : null}
      {item.run ? <MetaBadge icon={IconPlayerPlay} text={RUN_KIND_LABELS[item.run.kind]} /> : null}
      {item.workItem ? (
        <IssueBadge
          tracker="linear"
          id={item.workItem.identifier}
          href={item.workItem.url ?? undefined}
        />
      ) : null}
      {item.repository ? (
        <RepoBadge host={item.repository.provider} name={item.repository.fullPath} />
      ) : null}
      {item.pullRequest ? (
        <ChangeBadge
          host={item.pullRequest.provider}
          number={item.pullRequest.number}
          href={item.pullRequest.url ?? undefined}
        />
      ) : null}
      {item.agent ? <AgentBadge name={item.agent.name} href={agentHref(item.agent.id)} /> : null}
      {item.size ? <SizeBadge size={item.size} /> : null}
    </>
  );
}
