import "server-only";
import {
  getActiveTriageRun,
  getRunByIssue,
  getTrackerLabels,
  latestTriageSizes,
  listIssueTriageRuns,
  listWorkItemEvents,
  listWorkItemMatches,
  unifiedRunStatus,
  workItemUrlId,
  type Database,
  type Repository,
  type TriageRun,
} from "@omniralph/db";
import { TriageRunResult } from "@omniralph/shared";
import type { WorkItemActions, WorkItemDetail, WorkItemRoute } from "@/lib/api/work-items";
import type { Role } from "@/lib/auth/roles";
import { featureStartReason } from "@/lib/ralph/feature";
import { relationsStartReason } from "@/lib/ralph/relations";
import { matchesWorkItem, specificity } from "@/lib/routing/match";
import { siblingIssueUrl } from "@/lib/tracker/adapters";
import { createRouter, type RouteOutcome } from "@/lib/routing/resolve";
import { canAnswerTriageQuestions } from "@/lib/runs/actions";
import { ACTIVITY_LIMIT, workItemActivity } from "./activity";
import { organizationBacklog } from "./backlog";
import { groupFor } from "./group";
import { workItemHolds } from "./holds";
import type { ResolvedWorkItem } from "./item";
import type { WorkItem, WorkItemRouting, WorkItemTracker } from "./tracker";

/** Run statuses during which Om is working on the item. */
const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting"]);

/** Whether a run of this unified status is in flight (queued, running or waiting). */
export const isActiveRunStatus = (status: string) => ACTIVE_RUN_STATUSES.has(status);

const repositoryRef = (repository: Pick<Repository, "id" | "provider" | "fullPath">) => ({
  id: repository.id,
  provider: repository.provider,
  fullPath: repository.fullPath,
});

/** The item's source: its project, else its team. */
export function workItemSource(item: Pick<WorkItem, "project" | "team">): WorkItemDetail["source"] {
  return item.project
    ? { kind: "project", id: item.project.id ?? item.project.name, name: item.project.name }
    : { kind: "team", id: item.team.id, name: item.team.key };
}

/**
 * How an item routes, as the detail's routes line reads it: the outcome, the repo, and what
 * decided it (`via`: a member's choice, a rule, a parent or source, or a work item match's
 * project, label or team).
 */
export async function workItemRoute(deps: {
  db: Database;
  organizationId: string;
  tracker: WorkItemTracker;
  item: WorkItem;
}): Promise<WorkItemRoute> {
  const { db, organizationId, tracker, item } = deps;
  let own: WorkItemRouting | undefined;
  const [router, matches] = await Promise.all([
    createRouter({
      db,
      organizationId,
      provider: tracker.kind,
      tracker: {
        routingIssue: async (ref) => {
          const fields = await tracker.routingFields(ref);
          if (fields.issue.id === item.id) own = fields;
          return fields;
        },
      },
    }),
    listWorkItemMatches(db, organizationId),
  ]);
  const route: RouteOutcome = await router.resolve(item.id);
  if ("ask" in route) {
    return { outcome: "ask", repository: null, via: null, by: route.by ?? null };
  }
  const repository = "repository" in route ? route.repository : route.manual;
  const outcome = "repository" in route ? "repository" : "manual";
  const base = { outcome, repository: repositoryRef(repository), by: route.by } as const;
  if (route.chosen) return { ...base, via: { kind: "choice", label: "your choice" } };
  if (route.rule !== undefined) {
    return { ...base, via: { kind: "rule", label: `rule ${route.rule}` } };
  }
  if (route.defaultRule === 2) {
    const parent = own?.parent?.identifier ?? own?.issue.parent ?? "its parent";
    return { ...base, via: { kind: "parent", label: `parent ${parent}` } };
  }
  if (route.defaultRule === 1) {
    return { ...base, via: { kind: "follow_up", label: route.by.split(" → ")[0]! } };
  }
  if (route.workItemMatch && own) {
    const fields = own.issue;
    const winner = matches
      .filter(
        (m) =>
          m.repositoryId === repository.id &&
          matchesWorkItem(m, { ...fields, tracker: item.tracker }),
      )
      .sort((a, b) => specificity(b) - specificity(a))[0];
    if (winner && winner.project !== null && !winner.withoutProject && fields.project) {
      return { ...base, via: { kind: "project", label: `${fields.project} project` } };
    }
    if (winner && winner.labels.length > 0) {
      const wanted = new Set(winner.labels.map((label) => label.toLowerCase()));
      const label = fields.labels.find((name) => wanted.has(name.toLowerCase()));
      if (label) return { ...base, via: { kind: "label", label: `label ${label}` } };
    }
    return { ...base, via: { kind: "team", label: `${fields.team ?? item.team.key} team` } };
  }
  return { ...base, via: { kind: "rule", label: route.by } };
}

/** What a member can do with the item now. */
export function workItemActions(input: {
  group: WorkItemDetail["group"];
  run: WorkItemDetail["run"];
  triageRunning: boolean;
  /** Blocked (by relations or a blocked label): it can be triaged, not started. */
  blocked: boolean;
  /** A person's job (a manual label): it can be neither started nor triaged. */
  manual: boolean;
  /** Why it can't be started whatever its state (a feature, or relations breaking the rules), if so. */
  startRefusal?: string;
}): WorkItemActions {
  const hasRun = input.run !== null;
  const working = input.run !== null && isActiveRunStatus(input.run.status);
  return {
    start:
      input.group === "ready" &&
      !input.blocked &&
      !input.manual &&
      !hasRun &&
      input.startRefusal === undefined,
    triage: !input.manual && !input.triageRunning && !hasRun,
    editPrd: !working,
    changeRepo: !hasRun,
    move: input.group === "ready" && !hasRun,
    cancel: !working,
  };
}

/**
 * Why Start epic is refused for a feature (a work item holding epics, or a task directly
 * under one), or for work whose blocks relations break the dependency rules; undefined
 * otherwise, or when the tracker can't tell (Start then refuses it).
 */
async function startRefusalFor(
  tracker: WorkItemTracker,
  item: Pick<WorkItem, "id" | "identifier">,
): Promise<string | undefined> {
  try {
    const feature = await tracker.feature(item.id);
    if (feature) return featureStartReason(feature);
    const violations = await tracker.relationViolations(item.id);
    return violations.length > 0 ? relationsStartReason(violations) : undefined;
  } catch (error) {
    console.warn(`Checking whether ${item.identifier} may start failed`, error);
    return undefined;
  }
}

/**
 * The open questions of the item's newest triage run (`triageRuns`, newest first) that a user
 * with `role` can answer: set when that run is completed and its last result left open
 * questions, else null.
 */
export function workItemTriageQuestions(
  triageRuns: readonly Pick<TriageRun, "id" | "status" | "lastResult">[],
  role: Role,
): WorkItemDetail["triageQuestions"] {
  const newest = triageRuns[0];
  if (!newest || newest.status !== "completed") return null;
  const parsed = TriageRunResult.safeParse(newest.lastResult);
  const questions = parsed.success ? (parsed.data.outcome?.openQuestions ?? []) : [];
  if (questions.length === 0 || !canAnswerTriageQuestions("needs_answers", role)) return null;
  return { runId: newest.id, questions };
}

/** The item's latest run, with its unified status, or null. */
export async function latestWorkItemRun(
  db: Database,
  organizationId: string,
  issueId: string,
): Promise<WorkItemDetail["run"]> {
  const run = await getRunByIssue(db, organizationId, issueId);
  return run ? { id: run.id, status: unifiedRunStatus(run.mode, run.status) } : null;
}

/** `GET /api/ui/work-items/{id}`: the item as the detail pane shows it. */
export async function loadWorkItemDetail(
  db: Database,
  resolved: ResolvedWorkItem,
): Promise<WorkItemDetail> {
  const { organization, tracker, item, key } = resolved;
  const organizationId = organization.id;
  const [route, stories, comments, events, triageRuns, activeTriage, run, sizes, labels] =
    await Promise.all([
      workItemRoute({ db, organizationId, tracker, item }),
      tracker.stories(item.id),
      tracker.comments(item.id),
      listWorkItemEvents(db, key, ACTIVITY_LIMIT),
      listIssueTriageRuns(db, organizationId, item.id),
      getActiveTriageRun(db, organizationId, item.id),
      latestWorkItemRun(db, organizationId, item.id),
      latestTriageSizes(db, organizationId, [item.id]),
      getTrackerLabels(db, organizationId),
    ]);

  // A blocker the Backlog lists links into it; reading the Backlog costs nothing more when cached.
  let listed = new Set<string>();
  if (item.blockedBy.length > 0) {
    try {
      const backlog = await organizationBacklog({
        db,
        organizationId,
        tracker: async () => tracker,
      });
      listed = new Set(backlog.entries.map((entry) => entry.row.id));
    } catch (error) {
      console.warn(`Reading the Backlog for ${item.identifier}'s blockers failed`, error);
    }
  }

  const group = groupFor(item);
  const triageRunning = activeTriage !== null;
  const holds = workItemHolds(item, labels);
  const startRefusal =
    group === "ready" && run === null && !holds.blocked && !holds.manual
      ? await startRefusalFor(tracker, item)
      : undefined;
  return {
    id: workItemUrlId(item.tracker, item.id),
    tracker: item.tracker,
    identifier: item.identifier,
    title: item.title,
    url: item.url,
    organization: { id: organization.id, name: organization.name, role: organization.role },
    repository: route.outcome === "repository" ? route.repository : null,
    kind: item.kind,
    size: sizes.get(item.id) ?? null,
    group,
    ...holds,
    source: workItemSource(item),
    state: item.state,
    description: item.description,
    updatedAt: item.updatedAt,
    blockedBy: item.blockedBy.map((blocker) => {
      const backlogId = workItemUrlId(item.tracker, blocker.ref);
      return {
        identifier: blocker.identifier,
        url: siblingIssueUrl(item.tracker, item.url, blocker.identifier),
        backlogId: listed.has(backlogId) ? backlogId : null,
      };
    }),
    route,
    stories: stories.map((story) => ({
      identifier: story.identifier,
      title: story.title,
      state: story.state,
      url: story.url,
      manual: story.manual,
    })),
    activity: workItemActivity({ events, triageRuns, comments }),
    triageRunning,
    run,
    triageQuestions: workItemTriageQuestions(triageRuns, organization.role),
    actions: workItemActions({
      group,
      run,
      triageRunning,
      blocked: holds.blocked,
      manual: holds.manual,
      startRefusal,
    }),
    ...(startRefusal !== undefined && { startRefusal }),
  };
}
