/**
 * Tracker-neutral issue types. Orchestration talks to issue trackers only
 * through {@link TrackerGateway}; each tracker implements it in an adapter.
 */

export type TrackerProvider = "linear";

export const TRACKER_PROVIDERS = ["linear"] as const satisfies readonly TrackerProvider[];

/** Whether `value` names a tracker provider (e.g. a provider read from stored text). */
export function isTrackerProvider(value: unknown): value is TrackerProvider {
  return (TRACKER_PROVIDERS as readonly unknown[]).includes(value);
}

/**
 * The kind of a workflow state, which orchestration decides on (a state's name
 * is the tracker's or the team's own). Adapters map their tracker's states onto
 * these.
 */
export type WorkflowStateType =
  | "triage"
  | "backlog"
  | "unstarted"
  | "started"
  | "completed"
  | "canceled";

export const WORKFLOW_STATE_TYPES = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const satisfies readonly WorkflowStateType[];

export function isWorkflowStateType(value: string): value is WorkflowStateType {
  return (WORKFLOW_STATE_TYPES as readonly string[]).includes(value);
}

/**
 * Issue priority on a common scale: 0 No priority, 1 Urgent, 2 High, 3 Medium,
 * 4 Low. Adapters map their tracker's priorities onto it.
 */
export type IssuePriority = 0 | 1 | 2 | 3 | 4;

export function isIssuePriority(value: unknown): value is IssuePriority {
  return value === 0 || value === 1 || value === 2 || value === 3 || value === 4;
}

/** A priority on the common scale; anything off it (or none) is 0, No priority. */
export function toIssuePriority(value: number | null | undefined): IssuePriority {
  return isIssuePriority(value) ? value : 0;
}

/** Someone who made something in the tracker (an issue's creator). */
export interface TrackerPerson {
  id: string;
  name: string;
  /** Their profile URL, which a comment can @mention them with. */
  url?: string;
}

/** An issue (work item) in a tracker. */
export interface IssueSummary {
  /** The tracker's stable ID. */
  id: string;
  /** The human-readable key, e.g. `ENG-12`. */
  identifier: string;
  title: string;
  /** Markdown. */
  description: string;
  url: string;
  /** The git branch name the tracker suggests for the issue, when it has one. */
  branchName?: string;
  /** The team (or tracker project, board, list) the issue belongs to. */
  teamId: string;
  /** The team's short key (`ENG`). */
  teamKey: string;
  /** The team's name (when the tracker returned it). */
  teamName?: string;
  /** The workflow state's ID (when the tracker returned it). */
  stateId?: string;
  stateType: WorkflowStateType;
  stateName: string;
  /** Label names. */
  labels: string[];
  priority: IssuePriority;
  /** Manual position among its parent's children (lower first). */
  subIssueSortOrder?: number;
  projectId?: string;
  projectName?: string;
  parentId?: string;
  assigneeId?: string;
  /**
   * The (agent) user the issue is delegated to, on trackers with the
   * delegation capability.
   */
  delegateId?: string;
  /** When the issue last changed (ISO 8601, when the tracker returned it). */
  updatedAt?: string;
  /** Who created the issue; absent when the tracker doesn't say (e.g. an integration). */
  creator?: TrackerPerson;
}

export interface IssueComment {
  /** Markdown. */
  body: string;
  /** The author's name. */
  author?: string;
  /** ISO 8601. */
  createdAt?: string;
}

/** An issue that blocks another ("X blocks this"). */
export interface Blocker {
  id: string;
  identifier: string;
  title?: string;
  stateType: WorkflowStateType;
  stateName?: string;
}

/** An issue `listIssues` returned, with the issues that block it. */
export interface IssueWithBlockers extends IssueSummary {
  /** Issues that block it, in any state. */
  blockers: Blocker[];
}

/**
 * Which issues `listIssues` returns: every condition given must hold. Paginated
 * by `after` (the previous page's `endCursor`), `first` per page.
 */
export interface ListIssuesFilter {
  teamId?: string;
  /** The team by its key (`ENG`), ignoring case. */
  teamKey?: string;
  projectId?: string;
  /** The project by its name, ignoring case. */
  projectName?: string;
  /** Only issues in no project. */
  withoutProject?: boolean;
  /** Issues carrying any of these labels. */
  labelIds?: string[];
  /** Issues carrying a label of any of these names, ignoring case. */
  labelNames?: string[];
  /** Issues delegated to this (agent) user (delegation capability). */
  delegateId?: string;
  /** Issues not delegated to this user, undelegated ones included (delegation capability). */
  notDelegateId?: string;
  /** Issues in a workflow state of one of these types. */
  stateTypes?: WorkflowStateType[];
  /**
   * Issues in a state of one of `types` (except in the `typesExceptTeamIds`
   * teams), or in one of the states `ids`.
   */
  stateMatch?: { types: WorkflowStateType[]; typesExceptTeamIds: string[]; ids: string[] };
  /** Issues with one of these identifiers (`ENG-12`, the team key ignoring case). */
  identifiers?: string[];
  first: number;
  after?: string | null;
}

/** A page of `listIssues`. */
export interface IssuePage {
  issues: IssueWithBlockers[];
  /** The `after` of the next page; null on the last one. */
  endCursor: string | null;
}

export interface WorkflowState {
  id: string;
  name: string;
  type: WorkflowStateType;
  /** Order within the team's states (lower first). */
  position: number;
}

export interface IssueLabel {
  id: string;
  name: string;
  /** The team the label belongs to; null for a workspace-wide label. */
  teamId: string | null;
}

export interface Project {
  id: string;
  name: string;
}

export interface Team {
  id: string;
  key: string;
  name: string;
}

/** The connected workspace (organization, site, tenant). */
export interface Workspace {
  id: string;
  name: string;
}

/** The user the gateway's credential acts as: for an app connection, the app user. */
export interface Viewer {
  id: string;
  name: string;
}

export interface CreateIssueInput {
  teamId: string;
  title: string;
  /** Markdown. */
  description: string;
  parentId?: string;
  priority?: IssuePriority;
  subIssueSortOrder?: number;
  /** The project by name, ignoring case (ignored when `projectId` is given). */
  projectName?: string;
  projectId?: string;
  /** Label names (ignoring case); a label the team doesn't have yet is created for it. */
  labels?: string[];
  /**
   * The (agent) user to delegate the new issue to. Needs the delegation
   * capability: a gateway without it rejects the input with a
   * {@link TrackerCapabilityError}.
   */
  delegateId?: string;
}

/** Fields `updateIssue` changes; omitted ones are left as they are. */
export interface UpdateIssueInput {
  title?: string;
  /** Markdown. */
  description?: string;
  priority?: IssuePriority;
}

/** Which workflow state `setIssueState` moves an issue to. */
export interface IssueStateTarget {
  /** The state of this ID, if given. */
  id?: string;
  /** Else the state of this name, ignoring case. */
  name?: string;
  /** Else the team's first state of this type. */
  type?: WorkflowStateType;
}

/** A tracker document (e.g. a PRD or design doc). */
export interface TrackerDocument {
  id: string;
  title: string;
  /** Markdown. */
  content: string;
  url: string;
  /** ISO 8601. */
  updatedAt: string;
  projectName?: string;
  /** The identifier of the issue the document belongs to, if any. */
  issueIdentifier?: string;
}

/** One entry in an agent session's activity stream. */
export type ActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string }
  | { type: "elicitation"; body: string };

export interface ActivityOptions {
  /** An ephemeral activity is replaced by the next one (thoughts and actions only). */
  ephemeral?: boolean;
  /** e.g. `select` with `signalMetadata: { options: [{ value }] }` renders a picker. */
  signal?: "select" | "auth" | "stop" | "continue";
  signalMetadata?: Record<string, unknown>;
}

export interface PlanStep {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

/** A file uploaded to the tracker, as `downloadUpload` fetched it. */
export interface UploadDownload {
  /** False for an error status. */
  ok: boolean;
  status: number;
  /** Without parameters, e.g. `image/png`. */
  contentType: string;
  /** From `Content-Length`, when the tracker sent one. */
  contentLength: number | null;
  /** The file (null after an error status). */
  body: ReadableStream<Uint8Array> | null;
}

/** An upload referenced in text (`findUploads`). */
export interface UploadRef {
  /** The upload's URL as `isUploadUrl` accepts it (without any expiring signature). */
  url: string;
  /** The file's name as the tracker stores it (e.g. "mockup.png"), when known. */
  title?: string;
}

/** A file to upload to the tracker (`uploadFile`). */
export interface UploadFileInput {
  filename: string;
  /** e.g. `image/png`. */
  contentType: string;
  data: Uint8Array;
}

/**
 * Agent sessions on issues: a stream of activities and a plan the tracker
 * shows on the issue. Without it, orchestration posts comments instead.
 */
export interface TrackerSessions {
  /** Opens an agent session on the issue (as the app) and returns its ID. */
  createSessionOnIssue(issueId: string): Promise<string>;
  createActivity(
    sessionId: string,
    content: ActivityContent,
    options?: ActivityOptions,
  ): Promise<void>;
  /** Replaces the session's plan. */
  updatePlan(sessionId: string, plan: PlanStep[]): Promise<void>;
  /** Links a URL (e.g. the run's page) from the session. */
  addExternalUrl(sessionId: string, label: string, url: string): Promise<void>;
}

/** Delegating issues to an (agent) user, as distinct from assigning them. */
export interface TrackerDelegation {
  /** Delegates the issue to the user (e.g. the viewer); null removes its delegate. */
  delegateIssue(issueId: string, delegateId: string | null): Promise<void>;
}

/** Documents stored in the tracker. Without it, the document tool isn't offered. */
export interface TrackerDocuments {
  /** A document by ID (or the tracker's other stable reference to it, e.g. a slug). */
  getDocument(ref: string): Promise<TrackerDocument>;
}

/** Files stored in the tracker (images and attachments in issue descriptions). */
export interface TrackerUploads {
  /** Whether the URL is one of the tracker's uploads, which `downloadUpload` fetches. */
  isUploadUrl(url: string): boolean;
  /**
   * The uploads referenced in text (an issue description, a comment) in the
   * tracker's markup, in order of first appearance and deduplicated by URL.
   */
  findUploads(text: string | undefined | null): UploadRef[];
  /**
   * Fetches an uploaded file with the workspace's credential. Rejects any URL
   * `isUploadUrl` refuses, without sending the credential.
   */
  downloadUpload(url: string, signal?: AbortSignal): Promise<UploadDownload>;
  /** Uploads a file and returns its URL, for a Markdown link or image in an issue. */
  uploadFile(input: UploadFileInput): Promise<string>;
}

/** The optional capabilities, by the gateway property that holds each. */
export interface TrackerCapabilityMap {
  sessions: TrackerSessions;
  delegation: TrackerDelegation;
  documents: TrackerDocuments;
  uploads: TrackerUploads;
}

export type TrackerCapability = keyof TrackerCapabilityMap;

export const TRACKER_CAPABILITIES = [
  "sessions",
  "delegation",
  "documents",
  "uploads",
] as const satisfies readonly TrackerCapability[];

/**
 * The slice of an issue tracker orchestration needs. The core operations are
 * required; the optional capabilities are properties an adapter leaves out
 * when its tracker has no such feature, so check them (or use
 * `hasCapability`) before use.
 */
export interface TrackerGateway extends Partial<TrackerCapabilityMap> {
  readonly provider: TrackerProvider;

  /** The connected workspace. */
  getWorkspace(): Promise<Workspace>;
  /** The user the credential acts as (the app user for an app connection). */
  getViewer(): Promise<Viewer>;
  /** Every team in the workspace (all pages). */
  listTeams(): Promise<Team[]>;
  /** Every project in the workspace (all pages). */
  listProjects(): Promise<Project[]>;

  /** An issue by ID or identifier; a {@link TrackerNotFoundError} if there's none. */
  getIssue(idOrIdentifier: string): Promise<IssueSummary>;
  /** Every child issue (all pages). */
  getChildren(issueId: string): Promise<IssueSummary[]>;
  /** Comments on an issue, oldest first. */
  getComments(issueId: string): Promise<IssueComment[]>;
  /** Issues that block the given issue ("X blocks this"). */
  getBlockers(issueId: string): Promise<Blocker[]>;
  /** Issues matching a full-text search (identifier, title, description), best match first. */
  searchIssues(query: string, options?: { first?: number }): Promise<IssueSummary[]>;
  /** A page of issues matching `filter`, oldest first, each with its blockers. */
  listIssues(filter: ListIssuesFilter): Promise<IssuePage>;

  /** The team's workflow states by position. */
  getWorkflowStates(teamId: string): Promise<WorkflowState[]>;

  /** The team's label with this name (ignoring case), else a workspace label, else null. */
  findLabel(teamId: string, name: string): Promise<IssueLabel | null>;
  /** Creates a team label; a {@link TrackerInvalidInputError} if the name is taken. */
  createLabel(teamId: string, name: string): Promise<IssueLabel>;
  /** Every label issues can carry, workspace and team labels (all pages). */
  listLabels(): Promise<IssueLabel[]>;

  createIssue(input: CreateIssueInput): Promise<IssueSummary>;
  /** Updates the given fields of an issue (a no-op when none are given). */
  updateIssue(issueId: string, input: UpdateIssueInput): Promise<void>;
  /** Moves the issue to the target state; leaves it where it is when no state matches. */
  setIssueState(issueId: string, target: IssueStateTarget): Promise<void>;
  /** Adds labels by ID, keeping the issue's other labels. */
  addIssueLabels(issueId: string, labelIds: string[]): Promise<void>;
  removeIssueLabel(issueId: string, labelId: string): Promise<void>;
  /** `blockerId` blocks `blockedId`. */
  createBlocksRelation(blockerId: string, blockedId: string): Promise<void>;

  /** Adds a Markdown comment to the issue. */
  addComment(issueId: string, body: string): Promise<void>;
  /** Links a URL (e.g. a PR/MR) to the issue; linking the same URL again updates the link. */
  linkUrl(issueId: string, url: string, title?: string): Promise<void>;
}

/** The issue, document or other entity doesn't exist (or the credential can't see it). */
export class TrackerNotFoundError extends Error {
  constructor(
    readonly entity: string,
    readonly ref: string,
    options?: { cause?: unknown },
  ) {
    super(`No ${entity} ${ref}`, options);
    this.name = "TrackerNotFoundError";
  }
}

/** The tracker refused the input (e.g. a label name that's taken). Retrying won't help. */
export class TrackerInvalidInputError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TrackerInvalidInputError";
  }
}

/** An operation needs an optional capability the gateway doesn't have. */
export class TrackerCapabilityError extends Error {
  constructor(
    readonly provider: TrackerProvider,
    readonly capability: TrackerCapability,
  ) {
    super(`The ${provider} tracker has no ${capability} capability`);
    this.name = "TrackerCapabilityError";
  }
}
