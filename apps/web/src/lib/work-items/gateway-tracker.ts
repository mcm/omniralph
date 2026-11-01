import "server-only";
import type { TrackerStateMapping } from "@omniralph/db";
import { DEFAULT_MANUAL_LABELS, isManualIssue, parsePrd } from "@omniralph/ralph";
import {
  hasCapability,
  isTriageLabel,
  parseIssueIdentifier,
  requireCapability,
  toIssuePriority,
  TRIAGE_LABEL,
  TRIAGE_LABEL_NAMES,
  TrackerNotFoundError,
  type Blocker,
  type IssueLabel,
  type IssueSummary,
  type IssueWithRouting,
  type ListIssuesFilter,
  type RoutingIssue,
  type TrackerGateway,
  type Viewer,
  type WorkflowStateType,
} from "@omniralph/tracker";
import { trackerExtras, trackerName } from "@/lib/tracker/adapters";
import { readRoutingIssue } from "@/lib/tracker/routing-issue";
import {
  readinessOf,
  readinessStateMatch,
  readinessTargetState,
  validateStateMapping,
} from "./readiness";
import {
  LIST_CANDIDATES_MAX_LIMIT,
  StateMappingError,
  WorkItemConflictError,
  WorkItemNotFoundError,
  WorkItemProjectNotFoundError,
  WorkItemTeamNotFoundError,
  findTeam,
  type CreatedWorkItem,
  type CreateWorkItemInput,
  type ListCandidatesInput,
  type ReadinessStateTarget,
  type TrackerTeam,
  type TrackerWorkflowState,
  type UpdateWorkItemInput,
  type UpdateWorkItemOptions,
  type WorkItem,
  type WorkItemBlocker,
  type WorkItemComment,
  type WorkItemImage,
  type WorkItemRouting,
  type WorkItemStory,
  type WorkItemPage,
  type WorkItemRef,
  type WorkItemState,
  type WorkItemStateCategory,
  type WorkItemTracker,
} from "./tracker";

/** The workflow state type of each work item state. */
export const WORK_ITEM_STATE_TYPES: Record<WorkItemState, WorkflowStateType> = {
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

/** The work item state category of a workflow state type (an unknown one: backlog). */
export function stateCategoryOf(type: string): WorkItemStateCategory {
  return Object.hasOwn(CATEGORIES, type) ? CATEGORIES[type]! : "backlog";
}

const CLOSED_TYPES = new Set(["completed", "canceled"]);

// The tracker's routing fields are the gateway's, so the router reads either.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const routingFieldsMatch: Same<WorkItemRouting, RoutingIssue> = true;
void routingFieldsMatch;

export interface GatewayWorkItemTrackerOptions {
  gateway: TrackerGateway;
  /** The tracker integration's ID. */
  integrationId: string;
  /** The integration's saved readiness state mapping. */
  stateMapping: TrackerStateMapping;
  /** Saves a validated mapping (the integration's `state_mapping`). */
  saveStateMapping: (mapping: TrackerStateMapping) => Promise<void>;
  /**
   * Whether Omniralph is working on the issue right now (a ralph or triage run that isn't
   * over): `delegateToOmniralph` then opens no new session. Default: never.
   */
  hasActiveRun?: (issueId: string) => Promise<boolean>;
  /** The labels marking a sub-issue as a manual story. Default: `manual`. */
  manualLabels?: () => Promise<string[]>;
}

const READINESS_LABELS = { ready: "Ready to start", needs_refining: "Needs refining" } as const;

/**
 * `WorkItemTracker` over any tracker's `TrackerGateway`. Without the optional capabilities
 * it degrades: no uploads leaves images out (reported as failed), no delegation answers no
 * delegated items and refuses `delegateToOmniralph` with a `TrackerCapabilityError`.
 */
export class GatewayWorkItemTracker implements WorkItemTracker {
  readonly kind: WorkItemTracker["kind"];
  readonly integrationId: string;
  private readonly gateway: TrackerGateway;
  private mapping: TrackerStateMapping;
  private readonly saveStateMapping: (mapping: TrackerStateMapping) => Promise<void>;
  private readonly hasActiveRun: (issueId: string) => Promise<boolean>;
  private readonly manualLabels: () => Promise<string[]>;
  private viewer: Promise<Viewer> | undefined;

  constructor(options: GatewayWorkItemTrackerOptions) {
    this.gateway = options.gateway;
    this.kind = options.gateway.provider;
    this.integrationId = options.integrationId;
    this.mapping = options.stateMapping;
    this.saveStateMapping = options.saveStateMapping;
    this.hasActiveRun = options.hasActiveRun ?? (async () => false);
    this.manualLabels = options.manualLabels ?? (async () => [...DEFAULT_MANUAL_LABELS]);
  }

  /** The issue of a ref; an unknown one is `WorkItemNotFoundError`. */
  private async issue(ref: WorkItemRef): Promise<IssueSummary> {
    try {
      return await this.gateway.getIssue(ref);
    } catch (error) {
      if (error instanceof TrackerNotFoundError) throw new WorkItemNotFoundError(ref);
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

  /**
   * The app user's ID when one of the issues is delegated (to tell Omniralph from another
   * agent), else null without asking the tracker.
   */
  private async appUserIdFor(issues: IssueSummary[]): Promise<string | null> {
    return issues.some((issue) => issue.delegateId) ? (await this.appUser()).id : null;
  }

  private workItem(
    issue: IssueSummary,
    blockers: Blocker[],
    appUserId: string | null,
    routing?: RoutingIssue,
  ): WorkItem {
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
      tracker: this.kind,
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
      updatedAt: issue.updatedAt ?? "",
      delegate: issue.delegateId
        ? { id: issue.delegateId, isOmniralph: issue.delegateId === appUserId }
        : null,
      ...(routing && { routingFields: routing }),
    };
  }

  /** The team's label of this name (else a workspace one), created on the team when missing. */
  private async label(teamId: string, name: string): Promise<IssueLabel> {
    return (
      (await this.gateway.findLabel(teamId, name)) ?? (await this.gateway.createLabel(teamId, name))
    );
  }

  /**
   * The triage label the team can use: its own or the workspace's, under either
   * name (Linear, for one, won't create a team label a workspace label already
   * has the name of). Created on the team as `coding:triage` when there is none.
   */
  private async triageLabel(teamId: string): Promise<IssueLabel> {
    for (const name of TRIAGE_LABEL_NAMES) {
      const label = await this.gateway.findLabel(teamId, name);
      if (label) return label;
    }
    return this.gateway.createLabel(teamId, TRIAGE_LABEL);
  }

  /** The ID of the workspace's project of this name (or, `byId`, this ID), ignoring case. */
  private async projectId(ref: string, byId = false): Promise<string> {
    const wanted = ref.trim().toLowerCase();
    const project = (await this.gateway.listProjects()).find(
      (candidate) =>
        candidate.name.toLowerCase() === wanted || (byId && candidate.id === ref.trim()),
    );
    if (!project) throw new WorkItemProjectNotFoundError(ref);
    return project.id;
  }

  /** The ID of the team `ref` names (key, name or ID, ignoring case). */
  private async teamId(ref: string): Promise<string> {
    const team = findTeam(await this.gateway.listTeams(), ref);
    if (!team) throw new WorkItemTeamNotFoundError(ref);
    return team.id;
  }

  /**
   * Uploads the images to the tracker: the Markdown that embeds them at the end of a description,
   * and the names of those that failed to upload.
   */
  private async embedImages(
    images: readonly WorkItemImage[],
  ): Promise<{ markdown: string; failed: string[] }> {
    const embedded: string[] = [];
    const failed: string[] = [];
    if (!hasCapability(this.gateway, "uploads")) {
      // The tracker takes no files: none is attached.
      return { markdown: "", failed: images.map((image) => image.filename) };
    }
    for (const image of images) {
      try {
        const url = await this.gateway.uploads.uploadFile(image);
        embedded.push(`![${image.filename}](${url})`);
      } catch (error) {
        console.warn(`Couldn't upload ${image.filename} to ${trackerName(this.kind)}`, error);
        failed.push(image.filename);
      }
    }
    return {
      markdown: embedded.length > 0 ? `\n\n## Screenshots\n\n${embedded.join("\n\n")}` : "",
      failed,
    };
  }

  async get(ref: WorkItemRef): Promise<WorkItem> {
    const issue = await this.issue(ref);
    const [blockers, appUserId] = await Promise.all([
      this.gateway.getBlockers(issue.id),
      this.appUserIdFor([issue]),
    ]);
    return this.workItem(issue, blockers, appUserId);
  }

  async findByIdentifiers(identifiers: readonly string[]): Promise<WorkItem[]> {
    const wanted = [
      ...new Set(
        identifiers.flatMap((identifier) => {
          const parsed = parseIssueIdentifier(identifier);
          return parsed ? [`${parsed.teamKey}-${parsed.number}`] : [];
        }),
      ),
    ];
    const items: WorkItem[] = [];
    // One request per page of identifiers (a message names a handful).
    for (let i = 0; i < wanted.length; i += LIST_CANDIDATES_MAX_LIMIT) {
      const chunk = wanted.slice(i, i + LIST_CANDIDATES_MAX_LIMIT);
      const page = await this.gateway.listIssues({ identifiers: chunk, first: chunk.length });
      const appUserId = await this.appUserIdFor(page.issues);
      items.push(...page.issues.map((issue) => this.workItem(issue, issue.blockers, appUserId)));
    }
    return items;
  }

  async listCandidates(input: ListCandidatesInput): Promise<WorkItemPage> {
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), LIST_CANDIDATES_MAX_LIMIT);
    const delegates = hasCapability(this.gateway, "delegation");
    // Nothing is delegated on a tracker without delegation.
    if (input.delegatedToOmniralph && !delegates) return { items: [], nextCursor: null };
    const delegate =
      input.delegatedToOmniralph === undefined || !delegates
        ? undefined
        : (await this.appUser()).id;
    const filter: ListIssuesFilter = {
      ...(input.teamId && { teamId: input.teamId }),
      ...(input.teamKey && { teamKey: input.teamKey }),
      ...(input.projectId && { projectId: input.projectId }),
      ...(input.projectName && { projectName: input.projectName }),
      ...(input.labelNames?.length && { labelNames: input.labelNames }),
      ...(input.withoutProject && { withoutProject: true }),
      ...(input.labelIds?.length && { labelIds: input.labelIds }),
      ...(delegate &&
        (input.delegatedToOmniralph ? { delegateId: delegate } : { notDelegateId: delegate })),
      ...(input.states && {
        stateTypes: [...new Set(input.states.map((state) => WORK_ITEM_STATE_TYPES[state]))],
      }),
      ...(input.readiness?.length && {
        stateMatch: readinessStateMatch(this.mapping, input.readiness),
      }),
      first: limit,
      ...(input.cursor && { after: input.cursor }),
    };
    // Where the tracker reads routing fields with the page; elsewhere `routingFields` reads them.
    const extras = input.withRoutingFields ? trackerExtras(this.gateway) : null;
    const page: { issues: IssueWithRouting[]; endCursor: string | null } = extras
      ? await extras.listIssuesWithRouting(filter)
      : await this.gateway.listIssues(filter);
    const appUserId = delegate ?? (await this.appUserIdFor(page.issues));
    return {
      items: page.issues.map(({ blockers, routing, ...issue }) =>
        this.workItem(issue, blockers, appUserId, routing),
      ),
      nextCursor: page.endCursor,
    };
  }

  async create(input: CreateWorkItemInput): Promise<CreatedWorkItem> {
    const teamId = input.teamId ?? (input.team !== undefined && (await this.teamId(input.team)));
    if (!teamId) throw new Error("A work item needs a team (teamId or team).");
    const projectId =
      input.projectId ??
      (input.project && (await this.projectId(input.project, true))) ??
      (input.projectName && (await this.projectId(input.projectName)));
    const images = input.images?.length ? await this.embedImages(input.images) : null;
    const issue = await this.gateway.createIssue({
      teamId,
      title: input.title,
      description: `${input.description}${images?.markdown ?? ""}`,
      ...(projectId && { projectId }),
      ...(input.parentId && { parentId: input.parentId }),
      ...(input.labels?.length && { labels: input.labels }),
      ...(input.priority !== undefined && { priority: toIssuePriority(input.priority) }),
    });
    // A new issue has no relations yet, and isn't delegated.
    return {
      ...this.workItem(issue, [], null),
      ...(images && { failedImages: images.failed }),
    };
  }

  async update(
    ref: WorkItemRef,
    input: UpdateWorkItemInput,
    options: UpdateWorkItemOptions = {},
  ): Promise<void> {
    const issue = await this.issue(ref);
    if (options.ifUpdatedAt !== undefined && issue.updatedAt !== options.ifUpdatedAt) {
      throw new WorkItemConflictError(ref, issue.updatedAt ?? "");
    }
    await this.gateway.updateIssue(issue.id, {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.priority !== undefined && { priority: toIssuePriority(input.priority) }),
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

  async setState(ref: WorkItemRef, state: WorkItemState | ReadinessStateTarget): Promise<void> {
    const issue = await this.issue(ref);
    if (typeof state === "string") {
      await this.gateway.setIssueState(issue.id, { type: WORK_ITEM_STATE_TYPES[state] });
      return;
    }
    const current = readinessOf(this.mapping, {
      teamId: issue.teamId,
      stateId: issue.stateId,
      stateType: issue.stateType,
    });
    if (current === state.readiness) return;
    const target = readinessTargetState(
      this.mapping,
      issue.teamId,
      state.readiness,
      await this.gateway.getWorkflowStates(issue.teamId),
    );
    if (!target) {
      throw new Error(
        `${issue.identifier}'s team has no ${READINESS_LABELS[state.readiness]} state (Settings › Connections › ${trackerName(this.kind)}).`,
      );
    }
    await this.gateway.setIssueState(issue.id, { id: target.id });
  }

  async cancel(ref: WorkItemRef, options: { comment?: string } = {}): Promise<void> {
    const issue = await this.issue(ref);
    await this.gateway.setIssueState(issue.id, { type: WORK_ITEM_STATE_TYPES.canceled });
    if (options.comment) await this.gateway.addComment(issue.id, options.comment);
  }

  async startTriage(ref: WorkItemRef): Promise<void> {
    const issue = await this.issue(ref);
    // Already labeled: the label webhook started triage when it was added.
    if (issue.labels.some(isTriageLabel)) return;
    const label = await this.triageLabel(issue.teamId);
    await this.gateway.addIssueLabels(issue.id, [label.id]);
  }

  async delegateToOmniralph(ref: WorkItemRef): Promise<void> {
    const delegation = requireCapability(this.gateway, "delegation");
    const issue = await this.issue(ref);
    const appUser = await this.appUser();
    if (issue.delegateId !== appUser.id) {
      await delegation.delegateIssue(issue.id, appUser.id);
      return;
    }
    // Delegating it again changes nothing in the tracker, so no session would start: open one.
    if (hasCapability(this.gateway, "sessions") && !(await this.hasActiveRun(issue.id))) {
      await this.gateway.sessions.createSessionOnIssue(issue.id);
    }
  }

  async stories(ref: WorkItemRef): Promise<WorkItemStory[]> {
    const issue = await this.issue(ref);
    const children = await this.gateway.getChildren(issue.id);
    if (children.length === 0) {
      return (parsePrd(issue.description)?.stories ?? []).map((story) => ({
        ref: null,
        identifier: null,
        title: story.title,
        state: null,
        url: null,
        manual: story.manual === true,
      }));
    }
    const manualLabels = await this.manualLabels();
    return children
      .map((child, index) => ({ child, index }))
      .sort(
        (a, b) =>
          (a.child.subIssueSortOrder ?? Number.POSITIVE_INFINITY) -
            (b.child.subIssueSortOrder ?? Number.POSITIVE_INFINITY) || a.index - b.index,
      )
      .map(({ child }) => ({
        ref: child.id,
        identifier: child.identifier,
        title: child.title,
        state: {
          category: stateCategoryOf(child.stateType),
          name: child.stateName || child.stateType,
        },
        url: child.url,
        manual: isManualIssue(child, manualLabels.length ? manualLabels : DEFAULT_MANUAL_LABELS),
      }));
  }

  async comments(ref: WorkItemRef): Promise<WorkItemComment[]> {
    const issue = await this.issue(ref);
    return (await this.gateway.getComments(issue.id))
      .map((comment) => ({
        author: comment.author ?? null,
        body: comment.body,
        createdAt: comment.createdAt ?? "",
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async routingFields(ref: WorkItemRef): Promise<WorkItemRouting> {
    try {
      return await readRoutingIssue(this.gateway, ref);
    } catch (error) {
      if (error instanceof TrackerNotFoundError) throw new WorkItemNotFoundError(ref);
      throw error;
    }
  }

  async teams(): Promise<TrackerTeam[]> {
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
