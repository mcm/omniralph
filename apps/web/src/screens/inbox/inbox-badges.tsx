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
import { RUN_KIND_ICONS, RUN_KIND_LABELS } from "@/components/runs/run-kind";
import type { InboxItem } from "@/lib/api/inbox";
import { agentHref } from "@/lib/runs/hrefs";

/** The kinds whose title is their agent's name: their row doesn't repeat it as a badge. */
const AGENT_TITLED: readonly InboxItem["kind"][] = ["agent_offline", "agent_update_failed"];

/**
 * A row's badges, in order (Design rules 1, 8 and 13): the organization (only under "All
 * organizations"), the work item, the PR/MR, the repo, the agent (unless the row's title
 * names it), then the size of a ready PRD. No counts (rule 8: they live in the detail).
 * Plain badges: the row link covers the row.
 */
export function InboxRowBadges({
  item,
  showOrganization,
}: {
  item: InboxItem;
  showOrganization: boolean;
}) {
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
      {item.agent && !AGENT_TITLED.includes(item.kind) ? (
        <AgentBadge name={item.agent.name} />
      ) : null}
      {item.size ? <SizeBadge size={item.size} /> : null}
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
      {item.run ? (
        <MetaBadge icon={RUN_KIND_ICONS[item.run.kind]} text={RUN_KIND_LABELS[item.run.kind]} />
      ) : null}
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
