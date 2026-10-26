/**
 * The Inbox on the wire: `listInboxItems` (`@omniralph/db`) derives the items, this module
 * gives each its references, a plain-language reason and the actions a person can take.
 */
import "server-only";
import {
  countInboxItems,
  getRunIndexEntries,
  listInboxItems,
  loadInboxReferences,
  loadRunListEntries,
  type Database,
  type InboxCandidate,
  type InboxReferences,
  type InboxTab,
  type RunListEntry,
  type RunRepository,
} from "@omniralph/db";
import type { InboxAction, InboxCountsResponse, InboxItem, InboxTabParam } from "@/lib/api/inbox";
import type { RunRow } from "@/lib/api/runs";
import type { ScopedOrganization } from "@/lib/api/scope";
import { AGENT_ONLINE_WINDOW_MS } from "@/lib/agents/display";
import { isRerunnable } from "@/lib/jobs/rerun-kind";
import { changeRequestWebUrl } from "@/lib/repositories/web-url";
import { describeAttempt, type AttemptLabelContext } from "@/lib/run-model/attempt-labels";
import { storyIssueUrl } from "@/lib/runs/detail";
import { runRow } from "@/lib/runs/list";
import { questionView } from "@/lib/runs/question";
import { changeRequestName, runReason, withError } from "@/lib/runs/reason";

const TAB_OF_PARAM: Record<InboxTabParam, InboxTab> = {
  "needs-you": "needs_you",
  problems: "problems",
  running: "running",
};
const PARAM_OF_TAB: Record<InboxTab, InboxTabParam> = {
  needs_you: "needs-you",
  problems: "problems",
  running: "running",
};

const ACTIONS: Record<InboxCandidate["facts"]["kind"], InboxAction[]> = {
  manual_story: ["done", "skip", "snooze"],
  blocked_epic: ["start_anyway", "done", "snooze"],
  question: ["answer", "done", "snooze"],
  stopped_epic: ["resume", "done", "snooze"],
  prd_ready: ["done", "snooze"],
  pr_waiting: ["done", "snooze"],
  failed_run: ["retry", "done", "snooze"],
  failed_system: ["retry", "done", "snooze"],
  agent_offline: ["done", "snooze"],
  agent_update_failed: ["done", "snooze"],
  run: [],
};

/** What a person can do with the item (a system attempt is retried only where it can be rerun). */
export function inboxItemActions(item: InboxCandidate): InboxAction[] {
  const { facts } = item;
  if (facts.kind === "failed_system" && !isRerunnable(facts.job)) return ["done", "snooze"];
  return ACTIONS[facts.kind];
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function pullRequestRef(
  repository: RunRepository,
  number: number,
  url: string | null,
): NonNullable<InboxItem["pullRequest"]> {
  return {
    provider: repository.provider,
    number,
    url:
      url && /^https?:\/\//i.test(url)
        ? url
        : changeRequestWebUrl(repository.provider, repository.baseUrl, repository.fullPath, number),
  };
}

const repositoryRef = (repository: RunRepository): NonNullable<InboxItem["repository"]> => ({
  id: repository.id,
  provider: repository.provider,
  fullPath: repository.fullPath,
});

interface Context {
  organization: ScopedOrganization;
  /** The run's list row and its entry, when the item is about a run. */
  row: RunRow | null;
  entry: RunListEntry | null;
  references: InboxReferences;
}

const REVIEW_STATE_REASONS = {
  none: (pr: string) => `${capitalize(pr)} is waiting for a review.`,
  review_requested: (pr: string) => `A review of ${pr} was requested.`,
  commented: (pr: string) => `${capitalize(pr)} has review comments.`,
  changes_requested: (pr: string) => `A reviewer asked for changes to ${pr}.`,
  approved: (pr: string) => `${capitalize(pr)} is approved and ready to merge.`,
} as const;

/** The item's own fields: what differs from the run's row. */
function itemFields(
  item: InboxCandidate,
  { row, entry, references }: Context,
): Pick<
  InboxItem,
  | "title"
  | "workItem"
  | "repository"
  | "pullRequest"
  | "agent"
  | "reason"
  | "actions"
  | "question"
  | "reviewState"
  | "review"
  | "size"
  | "version"
> {
  const { facts } = item;
  const base = {
    title: row?.title ?? "Run",
    workItem: row?.workItem ?? null,
    repository: row?.repository ?? null,
    pullRequest: row?.pullRequest ?? null,
    agent: row?.agent ?? null,
    actions: inboxItemActions(item),
    question: null,
    reviewState: null,
    review: null,
    size: null,
    version: null,
  };
  const prName = row?.pullRequest
    ? changeRequestName(row.pullRequest.provider, row.pullRequest.number)
    : "pull request";
  switch (facts.kind) {
    case "manual_story": {
      const { story } = facts;
      return {
        ...base,
        title: story.title,
        workItem: {
          tracker: "linear",
          identifier: story.identifier,
          url: storyIssueUrl(entry?.workItem?.url ?? null, story.identifier),
        },
        reason: runReason({
          kind: "manual_story",
          identifier: story.identifier,
          elsewhere: !!facts.elsewhere,
        }),
      };
    }
    case "blocked_epic":
      return {
        ...base,
        reason: runReason({
          kind: "blocked_epic",
          blockers: facts.blockers.map((b) => b.identifier),
        }),
      };
    case "question": {
      const { question } = facts;
      return {
        ...base,
        reason: runReason({
          kind: "question",
          question: question.kind,
          story: question.story,
          tool: question.tool,
          pullRequest: prName,
        }),
        question: questionView(
          { ...item, facts },
          { workItem: row?.workItem?.identifier ?? null, repositories: references.repositories },
        ),
      };
    }
    case "stopped_epic":
      return {
        ...base,
        reason: runReason({
          kind: "stopped",
          runKind: item.run?.kind === "epic" ? "epic" : "request",
          error: facts.error,
        }),
      };
    case "prd_ready": {
      const identifier = row?.workItem?.identifier ?? "The work item";
      return {
        ...base,
        size: facts.size,
        reason:
          facts.outcome === "prd"
            ? `Triage wrote a PRD for ${identifier}. It's ready for a person to start.`
            : `Triage reformatted the PRD of ${identifier}. It's ready for a person to start.`,
      };
    }
    case "pr_waiting": {
      const { lane, review } = facts;
      const repository = references.repositories.get(lane.repositoryId) ?? null;
      const pullRequest = repository ? pullRequestRef(repository, lane.prNumber, lane.prUrl) : null;
      const name = changeRequestName(repository?.provider, lane.prNumber);
      return {
        ...base,
        repository: repository ? repositoryRef(repository) : base.repository,
        pullRequest: pullRequest ?? base.pullRequest,
        reason: REVIEW_STATE_REASONS[lane.reviewState](name),
        reviewState: lane.reviewState,
        review: review && {
          runId: review.runId,
          status: review.status,
          openFindings: review.openFindings,
        },
      };
    }
    case "failed_run":
      return { ...base, reason: runReason({ kind: "failed", error: facts.error }) };
    case "failed_system": {
      const { job } = facts;
      const repository = job.repositoryId
        ? (references.repositories.get(job.repositoryId) ?? null)
        : null;
      const agent = job.agentId ? (references.agents.get(job.agentId) ?? null) : null;
      const payloadName = job.payload.name;
      const context: AttemptLabelContext = {
        repository: repository?.fullPath ?? null,
        provider: repository?.provider ?? null,
        workItem: entry?.workItem?.identifier ?? null,
        packageName: typeof payloadName === "string" ? payloadName : null,
        agent: agent?.name ?? null,
      };
      const label = describeAttempt({ type: job.type, status: "failed", context });
      return {
        ...base,
        title: label,
        repository: repository ? repositoryRef(repository) : base.repository,
        agent: agent ?? base.agent,
        reason: withError(`${label}.`, job.error ?? "It failed without saying why."),
      };
    }
    case "agent_offline":
      return {
        ...base,
        title: facts.agent.name,
        agent: facts.agent,
        reason: `${facts.agent.name} stopped checking in, so it can't take work.`,
      };
    case "agent_update_failed":
      return {
        ...base,
        title: facts.agent.name,
        agent: facts.agent,
        version: facts.version,
        reason: withError(`${facts.agent.name} couldn't update to ${facts.version}.`, facts.error),
      };
    case "run":
      return {
        ...base,
        reason: facts.status === "queued" ? "Waiting for an agent." : "Om is working on it.",
      };
  }
}

function inboxItem(item: InboxCandidate, context: Context): InboxItem {
  const { organization, entry } = context;
  return {
    key: item.key,
    tab: PARAM_OF_TAB[item.tab],
    kind: item.facts.kind,
    organization: { id: organization.id, name: organization.name, role: organization.role },
    run: item.run && entry && { id: item.run.id, kind: item.run.kind, status: entry.status },
    since: item.since.toISOString(),
    ...itemFields(item, context),
  };
}

export interface InboxScope {
  organizations: readonly ScopedOrganization[];
  userId: string;
}

/** The tab's items for the user, newest first, with their references. */
export async function loadInboxFeed(
  db: Database,
  scope: InboxScope,
  tab: InboxTabParam,
): Promise<InboxItem[]> {
  const items = await listInboxItems(db, {
    organizationIds: scope.organizations.map((o) => o.id),
    userId: scope.userId,
    tab: TAB_OF_PARAM[tab],
    onlineWindowMs: AGENT_ONLINE_WINDOW_MS,
  });
  const runIds = [...new Set(items.flatMap((i) => (i.run ? [i.run.id] : [])))];
  const [entries, references] = await Promise.all([
    getRunIndexEntries(db, runIds).then((found) => loadRunListEntries(db, found)),
    loadInboxReferences(db, items),
  ]);
  const organizationById = new Map(scope.organizations.map((o) => [o.id, o]));
  const entryById = new Map(entries.map((e) => [e.id, e]));
  return items.flatMap((item) => {
    const organization = organizationById.get(item.organizationId);
    if (!organization) return [];
    const entry = (item.run && entryById.get(item.run.id)) || null;
    // A run that went away between the queries: nothing to show.
    if (item.run && !entry) return [];
    const row = entry && runRow(entry, organization);
    return [inboxItem(item, { organization, row, entry, references })];
  });
}

/** Each tab's item count for the user. */
export async function loadInboxCounts(
  db: Database,
  scope: InboxScope,
): Promise<InboxCountsResponse> {
  const counts = await countInboxItems(db, {
    organizationIds: scope.organizations.map((o) => o.id),
    userId: scope.userId,
    onlineWindowMs: AGENT_ONLINE_WINDOW_MS,
  });
  return { needsYou: counts.needs_you, problems: counts.problems, running: counts.running };
}
