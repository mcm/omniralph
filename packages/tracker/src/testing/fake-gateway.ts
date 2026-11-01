/**
 * An in-memory `TrackerGateway` for tests: issues, blocks relations, comments,
 * activities, plans and delegations are plain fields to arrange and assert on.
 * Each optional capability can be switched off, to test how callers cope with
 * a tracker that lacks it.
 */
import {
  TRACKER_CAPABILITIES,
  TrackerCapabilityError,
  TrackerInvalidInputError,
  TrackerNotFoundError,
  type ActivityContent,
  type ActivityOptions,
  type Blocker,
  type CreateIssueInput,
  type IssueComment,
  type IssueLabel,
  type IssuePage,
  type IssueStateTarget,
  type IssueSummary,
  type IssueWithBlockers,
  type ListIssuesFilter,
  type PlanStep,
  type Project,
  type Team,
  type TrackerCapability,
  type TrackerDelegation,
  type TrackerDocument,
  type TrackerDocuments,
  type TrackerGateway,
  type TrackerProvider,
  type TrackerSessions,
  type TrackerUploads,
  type UpdateIssueInput,
  type UploadDownload,
  type UploadFileInput,
  type Viewer,
  type WorkflowState,
  type WorkflowStateType,
  type Workspace,
} from "../types.js";

export interface FakeActivity {
  sessionId: string;
  content: ActivityContent;
  options?: ActivityOptions;
}

export interface FakeTrackerGatewayOptions {
  /** Defaults to `linear`. */
  provider?: TrackerProvider;
  /** Which optional capabilities the fake has; each one left out is on. */
  capabilities?: Partial<Record<TrackerCapability, boolean>>;
  /** Where `uploadFile` puts files and which URLs `isUploadUrl` accepts. */
  uploadBaseUrl?: string;
}

/** Every optional capability switched off. */
export const NO_CAPABILITIES: Record<TrackerCapability, false> = Object.fromEntries(
  TRACKER_CAPABILITIES.map((capability) => [capability, false]),
) as Record<TrackerCapability, false>;

const DEFAULT_STATE_TYPES: WorkflowStateType[] = [
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
];

export class FakeTrackerGateway implements TrackerGateway {
  readonly provider: TrackerProvider;
  readonly sessions?: TrackerSessions;
  readonly delegation?: TrackerDelegation;
  readonly documents?: TrackerDocuments;
  readonly uploads?: TrackerUploads;

  private seq = 0;
  /** The fake's clock for `updatedAt`: each change moves it on a second. */
  private clock = Date.parse("2026-01-01T00:00:00.000Z");
  private readonly uploadBaseUrl: string;

  /** What `getWorkspace` returns. */
  workspace: Workspace = { id: "workspace-1", name: "Acme" };
  /** What `getViewer` returns: the app user. */
  viewer: Viewer = { id: "app-user", name: "Omniralph" };
  /** What `listTeams` returns; `add` puts issues in the first. */
  teams: Team[] = [{ id: "team-1", key: "ENG", name: "Engineering" }];
  /** What `listProjects` returns. */
  projects: Project[] = [];
  labels: IssueLabel[] = [];
  issues = new Map<string, IssueSummary>();
  /** Blocked issue ID -> blocker issue IDs. */
  blocks = new Map<string, string[]>();
  /** Issue ID -> its comments, oldest first (`addComment` appends). */
  commentsByIssue = new Map<string, IssueComment[]>();
  /** Every `addComment` call, in order. */
  comments: Array<{ issueId: string; body: string }> = [];
  /** Every team's workflow states, in position order. */
  workflowStates: WorkflowState[] = DEFAULT_STATE_TYPES.map((type, position) => ({
    id: `state-${type}`,
    name: type,
    type,
    position,
  }));
  /** Workflow states of particular teams, in position order (others have `workflowStates`). */
  workflowStatesByTeam = new Map<string, WorkflowState[]>();
  /** Every `createIssue` input, in order. */
  created: CreateIssueInput[] = [];
  /** Every `updateIssue` call, in order. */
  issueUpdates: Array<{ issueId: string; input: UpdateIssueInput }> = [];
  /** Every `setIssueState` call, in order. */
  stateChanges: Array<{ issueId: string; target: IssueStateTarget }> = [];
  /** Every `addIssueLabels` / `removeIssueLabel` call, in order. */
  labelChanges: Array<{ issueId: string; added?: string[]; removed?: string[] }> = [];
  /** Every `linkUrl` call, in order. */
  links: Array<{ issueId: string; url: string; title?: string }> = [];
  /** Every `searchIssues` call, in order. */
  searches: Array<{ query: string; first?: number }> = [];
  /** Every `listIssues` filter, in order. */
  issueLists: ListIssuesFilter[] = [];
  /** Every session `sessions.createSessionOnIssue` opened, in order. */
  sessionsCreated: Array<{ issueId: string; sessionId: string }> = [];
  activities: FakeActivity[] = [];
  /** Session ID -> every plan posted, in order. */
  plans = new Map<string, PlanStep[][]>();
  /** Every `sessions.addExternalUrl` call, in order. */
  urls: Array<{ sessionId: string; label: string; url: string }> = [];
  /** Every delegation (`delegation.delegateIssue`, `createIssue` with `delegateId`), in order. */
  delegations: Array<{ issueId: string; delegateId: string | null }> = [];
  /** Documents `documents.getDocument` finds, by ID. */
  documentsById = new Map<string, TrackerDocument>();
  /** Upload URL -> the file `uploads.downloadUpload` returns (any other URL: 404). */
  files = new Map<string, { contentType: string; body: string | Uint8Array; status?: number }>();
  /** Every file `uploads.uploadFile` uploaded, in order. */
  uploaded: Array<{ filename: string; contentType: string; size: number; url: string }> = [];
  /** Every `uploads.downloadUpload` URL, in order. */
  downloads: string[] = [];
  /** Calls to fail, by method name: `failures.set("getIssue", new Error())`. */
  failures = new Map<string, Error>();

  constructor(options: FakeTrackerGatewayOptions = {}) {
    this.provider = options.provider ?? "linear";
    this.uploadBaseUrl = options.uploadBaseUrl ?? "https://uploads.tracker.test/";
    const on = (capability: TrackerCapability) => options.capabilities?.[capability] !== false;
    if (on("sessions")) this.sessions = this.sessionOperations();
    if (on("delegation")) {
      this.delegation = { delegateIssue: (id, delegateId) => this.delegate(id, delegateId) };
    }
    if (on("documents")) this.documents = { getDocument: (ref) => this.getDocument(ref) };
    if (on("uploads")) this.uploads = this.uploadOperations();
  }

  /** Adds an issue, filling in what the partial leaves out. */
  add(partial: Partial<IssueSummary> & { title: string }): IssueSummary {
    this.seq += 1;
    const team = this.teams[0] ?? { id: "team-1", key: "ENG", name: "Engineering" };
    const teamKey = partial.teamKey ?? team.key;
    const identifier = partial.identifier ?? `${teamKey}-${this.seq}`;
    const issue: IssueSummary = {
      id: partial.id ?? `issue-${this.seq}`,
      identifier,
      description: "",
      url: `https://tracker.test/issue/${identifier}`,
      teamId: team.id,
      teamKey,
      stateType: "unstarted",
      stateName: "Todo",
      labels: [],
      priority: 0,
      updatedAt: this.tick(),
      ...partial,
    };
    this.issues.set(issue.id, issue);
    return { ...issue };
  }

  /** Marks the issue changed (a later `updatedAt`), as a change in the tracker does. */
  touch(idOrIdentifier: string): void {
    this.find(idOrIdentifier).updatedAt = this.tick();
  }

  /** Who the issue is delegated to: its latest delegation. */
  delegateOf(issueId: string): string | undefined {
    return this.delegations.findLast((d) => d.issueId === issueId)?.delegateId ?? undefined;
  }

  /** Bodies of the session's activities of one type, in order. */
  bodies(sessionId: string, type: ActivityContent["type"]): string[] {
    return this.activities
      .filter((a) => a.sessionId === sessionId && a.content.type === type)
      .map((a) => ("body" in a.content ? a.content.body : ""));
  }

  /** The session's latest plan. */
  plan(sessionId: string): PlanStep[] | undefined {
    return this.plans.get(sessionId)?.at(-1);
  }

  async getWorkspace(): Promise<Workspace> {
    this.fail("getWorkspace");
    return { ...this.workspace };
  }

  async getViewer(): Promise<Viewer> {
    this.fail("getViewer");
    return { ...this.viewer };
  }

  async listTeams(): Promise<Team[]> {
    this.fail("listTeams");
    return this.teams.map((t) => ({ ...t }));
  }

  async listProjects(): Promise<Project[]> {
    this.fail("listProjects");
    return this.projects.map((p) => ({ ...p }));
  }

  async getIssue(idOrIdentifier: string): Promise<IssueSummary> {
    this.fail("getIssue");
    return this.summaryOf(this.find(idOrIdentifier));
  }

  async getChildren(issueId: string): Promise<IssueSummary[]> {
    this.fail("getChildren");
    return [...this.issues.values()]
      .filter((i) => i.parentId === issueId)
      .map((i) => this.summaryOf(i));
  }

  async getComments(issueId: string): Promise<IssueComment[]> {
    this.fail("getComments");
    return (this.commentsByIssue.get(issueId) ?? []).map((c) => ({ ...c }));
  }

  async getBlockers(issueId: string): Promise<Blocker[]> {
    this.fail("getBlockers");
    return this.blockersOf(issueId);
  }

  /** Issues whose identifier, title or description contains the query (ignoring case). */
  async searchIssues(query: string, options: { first?: number } = {}): Promise<IssueSummary[]> {
    this.fail("searchIssues");
    this.searches.push({ query, ...(options.first !== undefined && { first: options.first }) });
    const term = query.toLowerCase();
    return [...this.issues.values()]
      .filter((i) =>
        [i.identifier, i.title, i.description].some((text) => text.toLowerCase().includes(term)),
      )
      .slice(0, options.first ?? 10)
      .map((i) => this.summaryOf(i));
  }

  /** Issues matching every condition, in creation order, `first` per page. */
  async listIssues(filter: ListIssuesFilter): Promise<IssuePage> {
    this.fail("listIssues");
    if (filter.delegateId !== undefined || filter.notDelegateId !== undefined) {
      this.requireDelegation();
    }
    this.issueLists.push(structuredClone(filter));
    const same = (a: string | undefined, b: string) => a?.toLowerCase() === b.toLowerCase();
    const labelNames = [
      ...(filter.labelNames ?? []),
      ...(filter.labelIds ?? []).map((id) => this.labelName(id)),
    ];
    const matches = [...this.issues.values()].filter((issue) => {
      const projectId = this.projectIdOf(issue);
      if (filter.teamId && issue.teamId !== filter.teamId) return false;
      if (filter.teamKey && !same(issue.teamKey, filter.teamKey)) return false;
      if (filter.projectId && projectId !== filter.projectId) return false;
      if (filter.projectName && !same(issue.projectName, filter.projectName)) return false;
      if (filter.withoutProject && (projectId || issue.projectName)) return false;
      if (labelNames.length > 0 && !issue.labels.some((l) => labelNames.some((n) => same(l, n)))) {
        return false;
      }
      const delegate = this.delegateOf(issue.id) ?? issue.delegateId;
      if (filter.delegateId && delegate !== filter.delegateId) return false;
      if (filter.notDelegateId && delegate === filter.notDelegateId) return false;
      if (filter.stateTypes && !filter.stateTypes.includes(issue.stateType)) return false;
      if (
        filter.identifiers &&
        !filter.identifiers.some((id) => same(id.trim(), issue.identifier))
      ) {
        return false;
      }
      if (filter.stateMatch) {
        const { types, typesExceptTeamIds, ids } = filter.stateMatch;
        const stateId = this.stateIdOf(issue);
        const byType =
          types.includes(issue.stateType) && !typesExceptTeamIds.includes(issue.teamId);
        if (!byType && !(stateId && ids.includes(stateId))) return false;
      }
      return true;
    });
    const offset = filter.after ? Number(filter.after) : 0;
    const page = matches.slice(offset, offset + filter.first);
    const next = offset + page.length;
    return {
      issues: page.map((issue): IssueWithBlockers => ({
        ...this.summaryOf(issue),
        blockers: this.blockersOf(issue.id),
      })),
      endCursor: next < matches.length ? String(next) : null,
    };
  }

  async getWorkflowStates(teamId: string): Promise<WorkflowState[]> {
    this.fail("getWorkflowStates");
    return this.statesOf(teamId).map((s) => ({ ...s }));
  }

  /** The team's label of this name, else the workspace's. */
  async findLabel(teamId: string, name: string): Promise<IssueLabel | null> {
    this.fail("findLabel");
    const named = this.labels.filter((l) => l.name.toLowerCase() === name.toLowerCase());
    const label = named.find((l) => l.teamId === teamId) ?? named.find((l) => !l.teamId);
    return label ? { ...label } : null;
  }

  /** Refuses a name the team or the workspace has a label of already. */
  async createLabel(teamId: string, name: string): Promise<IssueLabel> {
    this.fail("createLabel");
    const taken = this.labels.some(
      (l) => l.name.toLowerCase() === name.toLowerCase() && (!l.teamId || l.teamId === teamId),
    );
    if (taken) throw new TrackerInvalidInputError(`A label named ${name} already exists`);
    const label: IssueLabel = { id: `label-${this.labels.length + 1}`, name, teamId };
    this.labels.push(label);
    return { ...label };
  }

  async listLabels(): Promise<IssueLabel[]> {
    this.fail("listLabels");
    return this.labels.map((l) => ({ ...l }));
  }

  async createIssue(input: CreateIssueInput): Promise<IssueSummary> {
    this.fail("createIssue");
    if (input.delegateId !== undefined) this.requireDelegation();
    const team = this.teams.find((t) => t.id === input.teamId);
    if (!team) throw new TrackerNotFoundError("team", input.teamId);
    const project = input.projectId
      ? this.projects.find((p) => p.id === input.projectId)
      : input.projectName
        ? this.projects.find((p) => p.name.toLowerCase() === input.projectName!.toLowerCase())
        : undefined;
    if ((input.projectId || input.projectName) && !project) {
      throw new TrackerNotFoundError("project", input.projectId ?? input.projectName!);
    }
    for (const name of input.labels ?? []) {
      if (!(await this.findLabel(input.teamId, name))) await this.createLabel(input.teamId, name);
    }
    const issue = this.add({
      title: input.title,
      description: input.description,
      teamId: team.id,
      teamKey: team.key,
      teamName: team.name,
      priority: input.priority ?? 0,
      labels: [...(input.labels ?? [])],
      ...(input.parentId !== undefined && { parentId: input.parentId }),
      ...(input.subIssueSortOrder !== undefined && { subIssueSortOrder: input.subIssueSortOrder }),
      ...(project && { projectId: project.id, projectName: project.name }),
    });
    this.created.push({ ...input });
    if (input.delegateId !== undefined) {
      this.delegations.push({ issueId: issue.id, delegateId: input.delegateId });
    }
    return this.summaryOf(this.find(issue.id));
  }

  async updateIssue(issueId: string, input: UpdateIssueInput): Promise<void> {
    this.fail("updateIssue");
    this.issueUpdates.push({ issueId, input: { ...input } });
    const issue = this.find(issueId);
    if (Object.values(input).some((value) => value !== undefined)) issue.updatedAt = this.tick();
    if (input.title !== undefined) issue.title = input.title;
    if (input.description !== undefined) issue.description = input.description;
    if (input.priority !== undefined) issue.priority = input.priority;
  }

  async setIssueState(issueId: string, target: IssueStateTarget): Promise<void> {
    this.fail("setIssueState");
    this.stateChanges.push({ issueId, target: { ...target } });
    const issue = this.find(issueId);
    const states = this.statesOf(issue.teamId);
    const name = target.name?.toLowerCase();
    const state =
      (target.id && states.find((s) => s.id === target.id)) ||
      (name && states.find((s) => s.name.toLowerCase() === name)) ||
      (target.type && states.find((s) => s.type === target.type));
    if (!state) return;
    issue.updatedAt = this.tick();
    issue.stateId = state.id;
    issue.stateType = state.type;
    issue.stateName = state.name;
  }

  async addIssueLabels(issueId: string, labelIds: string[]): Promise<void> {
    this.fail("addIssueLabels");
    this.labelChanges.push({ issueId, added: [...labelIds] });
    const issue = this.find(issueId);
    const have = new Set(issue.labels.map((l) => l.toLowerCase()));
    for (const name of labelIds.map((id) => this.labelName(id))) {
      if (have.has(name.toLowerCase())) continue;
      have.add(name.toLowerCase());
      issue.labels = [...issue.labels, name];
      issue.updatedAt = this.tick();
    }
  }

  async removeIssueLabel(issueId: string, labelId: string): Promise<void> {
    this.fail("removeIssueLabel");
    this.labelChanges.push({ issueId, removed: [labelId] });
    const issue = this.find(issueId);
    const name = this.labelName(labelId).toLowerCase();
    const labels = issue.labels.filter((l) => l.toLowerCase() !== name);
    if (labels.length !== issue.labels.length) issue.updatedAt = this.tick();
    issue.labels = labels;
  }

  async createBlocksRelation(blockerId: string, blockedId: string): Promise<void> {
    this.fail("createBlocksRelation");
    const blocker = this.find(blockerId);
    const blocked = this.find(blockedId);
    const existing = this.blocks.get(blocked.id) ?? [];
    if (!existing.includes(blocker.id)) this.blocks.set(blocked.id, [...existing, blocker.id]);
  }

  async addComment(issueId: string, body: string): Promise<void> {
    this.fail("addComment");
    const issue = this.find(issueId);
    this.comments.push({ issueId: issue.id, body });
    const comment: IssueComment = { body, author: this.viewer.name, createdAt: this.tick() };
    this.commentsByIssue.set(issue.id, [...(this.commentsByIssue.get(issue.id) ?? []), comment]);
  }

  async linkUrl(issueId: string, url: string, title?: string): Promise<void> {
    this.fail("linkUrl");
    const issue = this.find(issueId);
    const link = { issueId: issue.id, url, ...(title !== undefined && { title }) };
    const index = this.links.findIndex((l) => l.issueId === issue.id && l.url === url);
    if (index >= 0) this.links[index] = link;
    else this.links.push(link);
  }

  private sessionOperations(): TrackerSessions {
    return {
      createSessionOnIssue: async (issueId) => {
        this.fail("createSessionOnIssue");
        const issue = this.find(issueId);
        const sessionId = `session-${this.sessionsCreated.length + 1}`;
        this.sessionsCreated.push({ issueId: issue.id, sessionId });
        return sessionId;
      },
      createActivity: async (sessionId, content, options) => {
        this.fail("createActivity");
        this.findSession(sessionId);
        this.activities.push({ sessionId, content, ...(options && { options }) });
      },
      updatePlan: async (sessionId, plan) => {
        this.fail("updatePlan");
        this.findSession(sessionId);
        this.plans.set(sessionId, [
          ...(this.plans.get(sessionId) ?? []),
          plan.map((s) => ({ ...s })),
        ]);
      },
      addExternalUrl: async (sessionId, label, url) => {
        this.fail("addExternalUrl");
        this.findSession(sessionId);
        this.urls.push({ sessionId, label, url });
      },
    };
  }

  private async delegate(issueId: string, delegateId: string | null): Promise<void> {
    this.fail("delegateIssue");
    const issue = this.find(issueId);
    issue.updatedAt = this.tick();
    this.delegations.push({ issueId: issue.id, delegateId });
  }

  private async getDocument(ref: string): Promise<TrackerDocument> {
    this.fail("getDocument");
    const document =
      this.documentsById.get(ref) ??
      [...this.documentsById.values()].find((d) => d.url.endsWith(`-${ref}`));
    if (!document) throw new TrackerNotFoundError("document", ref);
    return { ...document };
  }

  private uploadOperations(): TrackerUploads {
    const isUploadUrl = (url: string) => url.startsWith(this.uploadBaseUrl);
    return {
      isUploadUrl,
      downloadUpload: async (url): Promise<UploadDownload> => {
        this.fail("downloadUpload");
        if (!isUploadUrl(url)) throw new TrackerInvalidInputError(`Not an upload URL: ${url}`);
        this.downloads.push(url);
        const file = this.files.get(url);
        if (!file)
          return { ok: false, status: 404, contentType: "", contentLength: null, body: null };
        const bytes =
          typeof file.body === "string" ? new TextEncoder().encode(file.body) : file.body;
        const status = file.status ?? 200;
        const ok = status >= 200 && status < 300;
        return {
          ok,
          status,
          contentType: file.contentType,
          contentLength: bytes.byteLength,
          body: ok ? new Blob([new Uint8Array(bytes)]).stream() : null,
        };
      },
      uploadFile: async (input: UploadFileInput) => {
        this.fail("uploadFile");
        const url = `${this.uploadBaseUrl}${this.uploaded.length + 1}/${encodeURIComponent(input.filename)}`;
        this.files.set(url, { contentType: input.contentType, body: new Uint8Array(input.data) });
        this.uploaded.push({
          filename: input.filename,
          contentType: input.contentType,
          size: input.data.byteLength,
          url,
        });
        return url;
      },
    };
  }

  private requireDelegation(): void {
    if (!this.delegation) throw new TrackerCapabilityError(this.provider, "delegation");
  }

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private fail(method: string): void {
    const error = this.failures.get(method);
    if (error) throw error;
  }

  private find(idOrIdentifier: string): IssueSummary {
    const issue =
      this.issues.get(idOrIdentifier) ??
      [...this.issues.values()].find(
        (i) => i.identifier.toLowerCase() === idOrIdentifier.toLowerCase(),
      );
    if (!issue) throw new TrackerNotFoundError("issue", idOrIdentifier);
    return issue;
  }

  private findSession(sessionId: string): void {
    if (!this.sessionsCreated.some((s) => s.sessionId === sessionId)) {
      throw new TrackerNotFoundError("session", sessionId);
    }
  }

  private statesOf(teamId: string): WorkflowState[] {
    return this.workflowStatesByTeam.get(teamId) ?? this.workflowStates;
  }

  /** The issue's workflow state: its `stateId`, else its team's state of its name and type. */
  private stateIdOf(issue: IssueSummary): string | undefined {
    if (issue.stateId) return issue.stateId;
    const states = this.statesOf(issue.teamId);
    return (
      states.find((s) => s.type === issue.stateType && s.name === issue.stateName) ??
      states.find((s) => s.type === issue.stateType)
    )?.id;
  }

  private projectIdOf(issue: IssueSummary): string | undefined {
    return (
      issue.projectId ??
      (issue.projectName ? this.projects.find((p) => p.name === issue.projectName)?.id : undefined)
    );
  }

  private labelName(labelId: string): string {
    return this.labels.find((l) => l.id === labelId)?.name ?? labelId;
  }

  private blockersOf(issueId: string): Blocker[] {
    return (this.blocks.get(issueId) ?? []).map((id) => {
      const blocker = this.find(id);
      return {
        id: blocker.id,
        identifier: blocker.identifier,
        title: blocker.title,
        stateType: blocker.stateType,
        stateName: blocker.stateName,
      };
    });
  }

  /** A copy of the issue with what a tracker also returns: state ID, team name, project ID, delegate. */
  private summaryOf(issue: IssueSummary): IssueSummary {
    const stateId = this.stateIdOf(issue);
    const teamName = issue.teamName ?? this.teams.find((t) => t.id === issue.teamId)?.name;
    const projectId = this.projectIdOf(issue);
    const delegated = this.delegations.some((d) => d.issueId === issue.id);
    const delegateId = delegated ? this.delegateOf(issue.id) : issue.delegateId;
    const summary: IssueSummary = {
      ...issue,
      labels: [...issue.labels],
      ...(stateId && { stateId }),
      ...(teamName && { teamName }),
      ...(projectId && { projectId }),
    };
    delete summary.delegateId;
    if (delegateId) summary.delegateId = delegateId;
    return summary;
  }
}
