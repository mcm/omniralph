import "server-only";
import { InvalidInputLinearError } from "@linear/sdk";
import type { TrackerStateMapping } from "@omniralph/db";
import type {
  Blocker,
  IssueLabel,
  IssueSummary,
  LinearGateway,
  Viewer,
} from "@/lib/linear/gateway";
import { isTriageLabel, TRIAGE_LABEL } from "@/lib/linear/webhook";
import { readinessOf, readinessStateMatch, validateStateMapping } from "./readiness";
import {
  LIST_CANDIDATES_MAX_LIMIT,
  StateMappingError,
  WorkItemNotFoundError,
  type CreateWorkItemInput,
  type ListCandidatesInput,
  type TrackerTeam,
  type TrackerWorkflowState,
  type UpdateWorkItemInput,
  type WorkItem,
  type WorkItemBlocker,
  type WorkItemPage,
  type WorkItemRef,
  type WorkItemState,
  type WorkItemStateCategory,
  type WorkItemTracker,
} from "./tracker";

/** The Linear workflow state type of each work item state. */
export const LINEAR_STATE_TYPES: Record<WorkItemState, string> = {
  backlog: "backlog",
  todo: "unstarted",
  in_progress: "started",
  done: "completed",
  canceled: "canceled",
};

const CATEGORIES: Record<string, WorkItemStateCategory> = {
  triage: "triage",
  backlog: "backlog",
  unstarted: "todo",
  started: "in_progress",
  completed: "done",
  canceled: "canceled",
};

/** The work item state category of a Linear workflow state type (an unknown one: backlog). */
export function stateCategoryOf(type: string): WorkItemStateCategory {
  return Object.hasOwn(CATEGORIES, type) ? CATEGORIES[type]! : "backlog";
}

const CLOSED_TYPES = new Set(["completed", "canceled"]);

export interface LinearWorkItemTrackerOptions {
  gateway: LinearGateway;
  /** The Linear integration's ID. */
  integrationId: string;
  /** The integration's saved readiness state mapping. */
  stateMapping: TrackerStateMapping;
  /** Saves a validated mapping (the integration's `state_mapping`). */
  saveStateMapping: (mapping: TrackerStateMapping) => Promise<void>;
}

/** `WorkItemTracker` over a Linear workspace's `LinearGateway`. */
export class LinearWorkItemTracker implements WorkItemTracker {
  readonly kind = "linear" as const;
  readonly integrationId: string;
  private readonly gateway: LinearGateway;
  private mapping: TrackerStateMapping;
  private readonly saveStateMapping: (mapping: TrackerStateMapping) => Promise<void>;
  private viewer: Promise<Viewer> | undefined;

  constructor(options: LinearWorkItemTrackerOptions) {
    this.gateway = options.gateway;
    this.integrationId = options.integrationId;
    this.mapping = options.stateMapping;
    this.saveStateMapping = options.saveStateMapping;
  }

  /** The issue of a ref; an unknown one is `WorkItemNotFoundError`. */
  private async issue(ref: WorkItemRef): Promise<IssueSummary> {
    try {
      return await this.gateway.getIssue(ref);
    } catch (error) {
      // Linear answers an unknown ID or identifier with an invalid input error.
      if (error instanceof InvalidInputLinearError) throw new WorkItemNotFoundError(ref);
      throw error;
    }
  }

  /** The app user, read once per tracker. */
  private appUser(): Promise<Viewer> {
    this.viewer ??= this.gateway.getViewer().catch((error: unknown) => {
      this.viewer = undefined;
      throw error;
    });
    return this.viewer;
  }

  private workItem(issue: IssueSummary, blockers: Blocker[]): WorkItem {
    const blockedBy = blockers
      .filter((blocker) => !CLOSED_TYPES.has(blocker.stateType))
      .map((blocker): WorkItemBlocker => ({
        ref: blocker.id,
        identifier: blocker.identifier,
        title: blocker.title ?? blocker.identifier,
        state: {
          category: stateCategoryOf(blocker.stateType),
          name: blocker.stateName ?? blocker.stateType,
        },
      }));
    return {
      tracker: "linear",
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      state: { category: stateCategoryOf(issue.stateType), name: issue.stateName },
      team: { id: issue.teamId, key: issue.teamKey, name: issue.teamName ?? issue.teamKey },
      project: issue.projectName ? { id: issue.projectId ?? null, name: issue.projectName } : null,
      labels: [...issue.labels],
      parentId: issue.parentId ?? null,
      priority: issue.priority,
      readiness: readinessOf(this.mapping, {
        teamId: issue.teamId,
        stateId: issue.stateId,
        stateType: issue.stateType,
      }),
      blockedBy,
      blocked: blockedBy.length > 0,
    };
  }

  /** The team's label of this name (else a workspace one), created on the team when missing. */
  private async label(teamId: string, name: string): Promise<IssueLabel> {
    return (
      (await this.gateway.findLabel(teamId, name)) ?? (await this.gateway.createLabel(teamId, name))
    );
  }

  async get(ref: WorkItemRef): Promise<WorkItem> {
    const issue = await this.issue(ref);
    return this.workItem(issue, await this.gateway.getBlockers(issue.id));
  }

  async listCandidates(input: ListCandidatesInput): Promise<WorkItemPage> {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), LIST_CANDIDATES_MAX_LIMIT);
    const delegate =
      input.delegatedToOmniralph === undefined ? undefined : (await this.appUser()).id;
    const page = await this.gateway.listIssues({
      ...(input.teamId && { teamId: input.teamId }),
      ...(input.projectId && { projectId: input.projectId }),
      ...(input.labelIds?.length && { labelIds: input.labelIds }),
      ...(delegate &&
        (input.delegatedToOmniralph ? { delegateId: delegate } : { notDelegateId: delegate })),
      ...(input.states && {
        stateTypes: [...new Set(input.states.map((state) => LINEAR_STATE_TYPES[state]))],
      }),
      ...(input.readiness?.length && {
        stateMatch: readinessStateMatch(this.mapping, input.readiness),
      }),
      first: limit,
      ...(input.cursor && { after: input.cursor }),
    });
    return {
      items: page.issues.map(({ blockers, ...issue }) => this.workItem(issue, blockers)),
      nextCursor: page.endCursor,
    };
  }

  async create(input: CreateWorkItemInput): Promise<WorkItem> {
    const issue = await this.gateway.createIssue({
      teamId: input.teamId,
      title: input.title,
      description: input.description,
      ...(input.projectId && { projectId: input.projectId }),
      ...(input.parentId && { parentId: input.parentId }),
      ...(input.labels?.length && { labels: input.labels }),
      ...(input.priority !== undefined && { priority: input.priority }),
    });
    // A new issue has no relations yet.
    return this.workItem(issue, []);
  }

  async update(ref: WorkItemRef, input: UpdateWorkItemInput): Promise<void> {
    const issue = await this.issue(ref);
    await this.gateway.updateIssue(issue.id, {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.priority !== undefined && { priority: input.priority }),
    });
    if (input.addLabels?.length) {
      const labels = await Promise.all(
        input.addLabels.map((name) => this.label(issue.teamId, name)),
      );
      await this.gateway.addIssueLabels(
        issue.id,
        labels.map((label) => label.id),
      );
    }
    const carried = new Set(issue.labels.map((name) => name.toLowerCase()));
    for (const name of input.removeLabels ?? []) {
      if (!carried.has(name.toLowerCase())) continue;
      const label = await this.gateway.findLabel(issue.teamId, name);
      if (label) await this.gateway.removeIssueLabel(issue.id, label.id);
    }
  }

  async setState(ref: WorkItemRef, state: WorkItemState): Promise<void> {
    const issue = await this.issue(ref);
    await this.gateway.setIssueState(issue.id, { type: LINEAR_STATE_TYPES[state] });
  }

  async cancel(ref: WorkItemRef, options: { comment?: string } = {}): Promise<void> {
    const issue = await this.issue(ref);
    await this.gateway.setIssueState(issue.id, { type: LINEAR_STATE_TYPES.canceled });
    if (options.comment) await this.gateway.addComment(issue.id, options.comment);
  }

  async startTriage(ref: WorkItemRef): Promise<void> {
    const issue = await this.issue(ref);
    // Already labeled: the label webhook started triage when it was added.
    if (issue.labels.some(isTriageLabel)) return;
    const label = await this.label(issue.teamId, TRIAGE_LABEL);
    await this.gateway.addIssueLabels(issue.id, [label.id]);
  }

  async delegateToOmniralph(ref: WorkItemRef): Promise<void> {
    const issue = await this.issue(ref);
    await this.gateway.delegateIssue(issue.id, (await this.appUser()).id);
  }

  async listTeams(): Promise<TrackerTeam[]> {
    return (await this.gateway.listTeams()).map(({ id, key, name }) => ({ id, key, name }));
  }

  async listWorkflowStates(teamId: string): Promise<TrackerWorkflowState[]> {
    return (await this.gateway.getWorkflowStates(teamId)).map((state) => ({
      id: state.id,
      name: state.name,
      type: state.type,
      category: stateCategoryOf(state.type),
    }));
  }

  async getStateMapping(): Promise<TrackerStateMapping> {
    return structuredClone(this.mapping);
  }

  async setStateMapping(mapping: TrackerStateMapping): Promise<TrackerStateMapping> {
    const unique = (values: string[]) => [...new Set(values)];
    const normalized: TrackerStateMapping = {
      ready: { types: unique(mapping.ready.types) },
      needsRefining: { types: unique(mapping.needsRefining.types) },
      teams: Object.fromEntries(
        Object.entries(mapping.teams).map(([teamId, team]) => [
          teamId,
          { ready: unique(team.ready), needsRefining: unique(team.needsRefining) },
        ]),
      ),
    };
    const statesByTeam = new Map(
      await Promise.all(
        Object.keys(normalized.teams).map(
          async (teamId) =>
            [
              teamId,
              new Set((await this.gateway.getWorkflowStates(teamId)).map((state) => state.id)),
            ] as const,
        ),
      ),
    );
    const errors = validateStateMapping(normalized, statesByTeam);
    if (Object.keys(errors).length > 0) throw new StateMappingError(errors);
    await this.saveStateMapping(normalized);
    this.mapping = normalized;
    return structuredClone(normalized);
  }
}
