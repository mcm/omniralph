/**
 * The tracker-neutral work item interface: everything that creates, updates, triages or
 * cancels a work item goes through a `WorkItemTracker`, never a tracker's SDK directly.
 * `GatewayWorkItemTracker` (`./gateway-tracker.ts`) implements it over any tracker's
 * gateway; `getWorkItemTracker` (`./get-tracker.ts`) returns an organization's.
 */
import type { TrackerStateMapping } from "@omniralph/db";
import type { DependencyViolation, WorkItemKind } from "@omniralph/planning";
import type { TrackerProvider } from "@omniralph/tracker";
import type { FeatureFound } from "@/lib/ralph/feature";

/** The trackers an adapter exists for. */
export type TrackerKind = TrackerProvider;

/** A work item's state, the same in every tracker. */
export const WORK_ITEM_STATES = ["backlog", "todo", "in_progress", "done", "canceled"] as const;
export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

/**
 * The category of a work item's state: a `WorkItemState`, or `triage` for an item a tracker
 * holds in triage (the tracker's triage state). Nothing sets an item to `triage`.
 */
export type WorkItemStateCategory = WorkItemState | "triage";

/** Whether a work item is ready to start, still needs refining, or neither (the mapping). */
export const WORK_ITEM_READINESS = ["ready", "needs_refining"] as const;
export type WorkItemReadiness = (typeof WORK_ITEM_READINESS)[number] | "other";

/**
 * A state chosen by the readiness state mapping instead of by kind: the team's first
 * override state of that readiness, else its first state of the mapping's types.
 */
export interface ReadinessStateTarget {
  readiness: (typeof WORK_ITEM_READINESS)[number];
}

/** An open work item that blocks another. */
export interface WorkItemBlocker {
  /** Its ID, a `ref` for the tracker's methods. */
  ref: string;
  identifier: string;
  title: string;
  state: { category: WorkItemStateCategory; name: string };
}

export interface WorkItem {
  tracker: TrackerKind;
  id: string;
  /** The human-readable key, e.g. `SOC-1719`. */
  identifier: string;
  title: string;
  /** Markdown. */
  description: string;
  url: string;
  state: { category: WorkItemStateCategory; name: string };
  team: { id: string; key: string; name: string };
  project: { id: string | null; name: string } | null;
  /** Label names. */
  labels: string[];
  /** A Fix when it carries one of the integration's fix labels, else a Story. */
  kind: WorkItemKind;
  parentId: string | null;
  /** 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low. */
  priority: number;
  /** From the tracker's state mapping: the team's override first, then the state's type. */
  readiness: WorkItemReadiness;
  /** The open work items blocking it (done and canceled blockers left out). */
  blockedBy: WorkItemBlocker[];
  /** True when `blockedBy` isn't empty. */
  blocked: boolean;
  /** When the item last changed in the tracker (ISO 8601): `update`'s `ifUpdatedAt`. */
  updatedAt: string;
  /** The agent the item is delegated to, if any, and whether that's Omniralph. */
  delegate: { id: string; isOmniralph: boolean } | null;
  /**
   * The item's routing field values and its parent's, present only on `listCandidates`
   * items asked `withRoutingFields` (read in the same request).
   */
  routingFields?: WorkItemRouting;
}

/**
 * A work item's values of the routing fields, as the router reads them (the same shape as
 * the tracker's neutral `RoutingIssueFields`): the team by key, the cycle and people by ID,
 * the parent by identifier, the rest by name. Null where the item has none.
 */
export interface WorkItemRoutingFields {
  id: string;
  identifier: string;
  title: string;
  description: string;
  team: string | null;
  project: string | null;
  projectMilestone: string | null;
  cycle: string | null;
  state: string | null;
  stateType: string | null;
  /** 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low. */
  priority: number;
  assignee: string | null;
  creator: string | null;
  /** The parent's identifier. */
  parent: string | null;
  /** The parent's ID. */
  parentId: string | null;
  labels: string[];
  estimate: number | null;
  /** `YYYY-MM-DD`. */
  dueDate: string | null;
  teamId: string | null;
  projectId: string | null;
  projectMilestoneId: string | null;
}

/** A work item's routing fields and its parent's (null for a top-level item). */
export interface WorkItemRouting {
  issue: WorkItemRoutingFields;
  parent: WorkItemRoutingFields | null;
}

/**
 * One of a work item's stories: a sub-issue (with its identifier, `ref` and state) or, for
 * an item without sub-issues, a story its PRD lists (`identifier`, `ref` and `state` null).
 */
export interface WorkItemStory {
  /** The sub-issue's ID, a `ref` for the tracker's methods; null for a PRD story. */
  ref: string | null;
  identifier: string | null;
  title: string;
  /** The sub-issue's state; null for a PRD story. */
  state: { category: WorkItemStateCategory; name: string } | null;
  url: string | null;
  /** A step for a person: the sub-issue carries a manual label, or the PRD story says so. */
  manual: boolean;
}

/** A comment on a work item. */
export interface WorkItemComment {
  /** The author's name; null when the tracker doesn't say (e.g. an integration). */
  author: string | null;
  /** Markdown. */
  body: string;
  /** ISO 8601. */
  createdAt: string;
}

/** An ID or an identifier such as `SOC-1719`. */
export type WorkItemRef = string;

export const LIST_CANDIDATES_MAX_LIMIT = 50;

export interface ListCandidatesInput {
  teamId?: string;
  /** The team by its key (`ENG`), ignoring case. */
  teamKey?: string;
  projectId?: string;
  /** The project by its name, ignoring case. */
  projectName?: string;
  /** Items carrying any of these labels (by ID). */
  labelIds?: string[];
  /** Items carrying a label of any of these names, ignoring case. */
  labelNames?: string[];
  /** True: only items delegated to Omniralph; false: only items that aren't. */
  delegatedToOmniralph?: boolean;
  /** Items in one of these states. */
  states?: WorkItemState[];
  /** Items of one of these readiness values (from the state mapping). */
  readiness?: Array<(typeof WORK_ITEM_READINESS)[number]>;
  /** The previous page's `nextCursor`. */
  cursor?: string;
  /** Only items in no project. */
  withoutProject?: boolean;
  /** Each item also carries its `routingFields` (read in the same request). */
  withRoutingFields?: boolean;
  /** Items per page, 1 to `LIST_CANDIDATES_MAX_LIMIT`. */
  limit: number;
}

export interface WorkItemPage {
  items: WorkItem[];
  /** The next page's `cursor`; null on the last page. */
  nextCursor: string | null;
}

/** An image to embed in a new work item (e.g. a screenshot), uploaded to the tracker. */
export interface WorkItemImage {
  filename: string;
  /** e.g. `image/png`. */
  contentType: string;
  data: Uint8Array;
}

export interface CreateWorkItemInput {
  /** The team's ID. One of `teamId` and `team` is required (`teamId` wins). */
  teamId?: string;
  /**
   * The team by its key, name or ID, ignoring case (instead of a work item match's team).
   * Throws `WorkItemTeamNotFoundError`, creating nothing, when the tracker has no such team.
   */
  team?: string;
  projectId?: string;
  /**
   * The project by its ID or name, ignoring case (`projectId` wins when both are given).
   * Throws `WorkItemProjectNotFoundError`, creating nothing, when the tracker has none.
   */
  project?: string;
  /**
   * The project by its name, ignoring case (`projectId` wins when both are given). Throws
   * `WorkItemProjectNotFoundError`, creating nothing, when the tracker has no such project.
   */
  projectName?: string;
  parentId?: string;
  title: string;
  description: string;
  /** Label names; a label the team doesn't have yet is created. */
  labels?: string[];
  /** 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low. */
  priority?: number;
  /**
   * Images uploaded to the tracker and embedded at the end of the description, under a
   * "Screenshots" heading. One that fails to upload is left out, and named in the created
   * item's `failedImages`.
   */
  images?: WorkItemImage[];
}

/** A created work item, with the names of the `images` that couldn't be embedded. */
export type CreatedWorkItem = WorkItem & { failedImages?: string[] };

export interface UpdateWorkItemInput {
  title?: string;
  description?: string;
  priority?: number;
  /** Label names to add; a label the team doesn't have yet is created. */
  addLabels?: string[];
  /** Label names to remove; one the item doesn't carry is ignored. */
  removeLabels?: string[];
}

export interface UpdateWorkItemOptions {
  /**
   * The `updatedAt` the change is based on: when the item has changed since, `update`
   * throws `WorkItemConflictError` and writes nothing.
   */
  ifUpdatedAt?: string;
}

/** A team of the tracker. */
export interface TrackerTeam {
  id: string;
  key: string;
  name: string;
}

/** One of a team's workflow states. */
export interface TrackerWorkflowState {
  id: string;
  name: string;
  /** The tracker's state type (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`). */
  type: string;
  category: WorkItemStateCategory;
}

export interface WorkItemTracker {
  readonly kind: TrackerKind;
  /** The tracker's integration (connection) ID. */
  readonly integrationId: string;
  /** Throws `WorkItemNotFoundError` for an unknown ref. */
  get(ref: WorkItemRef): Promise<WorkItem>;
  /**
   * The work items with these identifiers (`ENG-12`, ignoring case), in no particular order:
   * one lookup for the whole list. Identifiers the tracker doesn't know are left out.
   */
  findByIdentifiers(identifiers: readonly string[]): Promise<WorkItem[]>;
  /** A page of work items matching every given condition. */
  listCandidates(input: ListCandidatesInput): Promise<WorkItemPage>;
  /**
   * Creates a work item in the team (`teamId`, or `team` by key, name or ID). Throws
   * `WorkItemTeamNotFoundError` or `WorkItemProjectNotFoundError`, creating nothing, for a
   * team or project the tracker doesn't have.
   */
  create(input: CreateWorkItemInput): Promise<CreatedWorkItem>;
  /** Throws `WorkItemConflictError`, writing nothing, when `ifUpdatedAt` is stale. */
  update(
    ref: WorkItemRef,
    input: UpdateWorkItemInput,
    options?: UpdateWorkItemOptions,
  ): Promise<void>;
  /**
   * Moves the item to its team's first workflow state of that kind or, for a readiness, to
   * the mapping's first state of that readiness (an item that already has that readiness
   * stays where it is).
   */
  setState(ref: WorkItemRef, state: WorkItemState | ReadinessStateTarget): Promise<void>;
  /** Sets the item `canceled`, with a comment when given. */
  cancel(ref: WorkItemRef, options?: { comment?: string }): Promise<void>;
  /** Starts Omniralph's triage of the item. */
  startTriage(ref: WorkItemRef): Promise<void>;
  /**
   * Hands the item to Omniralph, which starts working on it. An item already delegated to
   * Omniralph, with no active run, gets a new agent session instead, so the delegation is
   * handled again.
   */
  delegateToOmniralph(ref: WorkItemRef): Promise<void>;
  /**
   * The item's sub-issues in their order, else the stories its PRD (description) lists,
   * else none.
   */
  stories(ref: WorkItemRef): Promise<WorkItemStory[]>;
  /**
   * The feature (a work item holding epics) a run of the item would build: the item itself,
   * or the parent of a task directly under one. Null when it would build an epic or a task.
   */
  feature(ref: WorkItemRef): Promise<FeatureFound | null>;
  /**
   * The blocks relations of the work a run of the item would build (its epic and the epic's
   * open tasks, or the standalone task) that break the dependency rules; empty when none do.
   */
  relationViolations(ref: WorkItemRef): Promise<DependencyViolation[]>;
  /** The item's comments, oldest first. */
  comments(ref: WorkItemRef): Promise<WorkItemComment[]>;
  /**
   * The item's routing fields and its parent's, as `listCandidates` carries them
   * `withRoutingFields` (for an item no page carried, e.g. a follow-up's source).
   * Throws `WorkItemNotFoundError` for an unknown ref.
   */
  routingFields(ref: WorkItemRef): Promise<WorkItemRouting>;
  /** Every team of the tracker. */
  teams(): Promise<TrackerTeam[]>;
  /** A team's workflow states, in order. */
  listWorkflowStates(teamId: string): Promise<TrackerWorkflowState[]>;
  /** Which states mean "Ready to start" and "Needs refining". */
  getStateMapping(): Promise<TrackerStateMapping>;
  /** Validates and saves the mapping; throws `StateMappingError` with field errors. */
  setStateMapping(mapping: TrackerStateMapping): Promise<TrackerStateMapping>;
  /** The labels that mark a work item as a Fix (matched ignoring case). */
  getFixLabels(): Promise<string[]>;
  /**
   * Saves the fix labels, trimmed and without duplicates (ignoring case); throws
   * `FixLabelsError` for a blank label or an empty list.
   */
  setFixLabels(labels: readonly string[]): Promise<string[]>;
}

export class WorkItemNotFoundError extends Error {
  constructor(readonly ref: string) {
    super(`This work item doesn't exist or isn't visible to Omniralph: ${ref}.`);
    this.name = "WorkItemNotFoundError";
  }
}

/** An `update` refused because the item changed since `ifUpdatedAt`. */
export class WorkItemConflictError extends Error {
  constructor(
    readonly ref: string,
    /** The item's current `updatedAt`. */
    readonly updatedAt: string,
  ) {
    super(`This work item changed since it was read: ${ref}.`);
    this.name = "WorkItemConflictError";
  }
}

/** A `create` refused because the tracker has no project of that name. */
export class WorkItemProjectNotFoundError extends Error {
  constructor(readonly projectName: string) {
    super(`The tracker has no project named ${projectName}.`);
    this.name = "WorkItemProjectNotFoundError";
  }
}

/** A `create` refused because the tracker has no team of that key, name or ID. */
export class WorkItemTeamNotFoundError extends Error {
  constructor(readonly team: string) {
    super(`The tracker has no team ${team}.`);
    this.name = "WorkItemTeamNotFoundError";
  }
}

/** The team `ref` names (its key, name or ID, ignoring case), or undefined. */
export function findTeam<T extends TrackerTeam>(teams: readonly T[], ref: string): T | undefined {
  const wanted = ref.trim().toLowerCase();
  return teams.find(
    (t) => t.key.toLowerCase() === wanted || t.name.toLowerCase() === wanted || t.id === ref.trim(),
  );
}

export { TrackerNotConnectedError } from "@/lib/tracker/errors";

/** A state mapping `setStateMapping` refused, with a message per field path. */
export class StateMappingError extends Error {
  constructor(readonly fieldErrors: Record<string, string>) {
    super(Object.values(fieldErrors)[0] ?? "This state mapping is invalid.");
    this.name = "StateMappingError";
  }
}

/** Fix labels `setFixLabels` refused, with a message per field path. */
export class FixLabelsError extends Error {
  constructor(readonly fieldErrors: Record<string, string>) {
    super(Object.values(fieldErrors)[0] ?? "These fix labels are invalid.");
    this.name = "FixLabelsError";
  }
}
