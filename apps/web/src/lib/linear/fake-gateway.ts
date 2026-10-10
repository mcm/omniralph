/**
 * An in-memory `LinearGateway` for tests (ported from cyralph's `FakeLinear`):
 * issues, blocks relations, comments, activities, plans and session URLs are
 * plain fields to arrange and assert on.
 */
import { isLinearRun, type LinearRun } from "@omniralph/db";
import type {
  ActivityContent,
  ActivityOptions,
  Blocker,
  CreateIssueInput,
  IssueComment,
  IssueLabel,
  IssueSummary,
  LinearGateway,
  PlanStep,
  Team,
  UpdateIssueInput,
  UploadDownload,
  Viewer,
  WorkflowState,
} from "./gateway";

export interface FakeActivity {
  sessionId: string;
  content: ActivityContent;
  options?: ActivityOptions;
}

export class FakeLinearGateway implements LinearGateway {
  private seq = 0;
  issues = new Map<string, IssueSummary>();
  /** Blocked issue ID -> blocker issue IDs. */
  blocks = new Map<string, string[]>();
  comments: Array<{ issueId: string; body: string }> = [];
  activities: FakeActivity[] = [];
  /** Agent session ID -> every plan posted, in order. */
  plans = new Map<string, PlanStep[][]>();
  urls: Array<{ sessionId: string; label: string; url: string }> = [];
  labels: IssueLabel[] = [];
  /** What `listTeams` returns. */
  teams: Team[] = [{ id: "team-1", key: "ENG", name: "Engineering" }];
  /** What `getViewer` returns: the app user. */
  viewer: Viewer = { id: "app-user", name: "Omniralph" };
  /** Every delegation, by `delegateIssue` or `createIssue` with `delegateId`, in order. */
  delegations: Array<{ issueId: string; delegateId: string }> = [];
  /** Every team's workflow states, in position order. */
  workflowStates: WorkflowState[] = [
    "backlog",
    "unstarted",
    "started",
    "completed",
    "canceled",
  ].map((type, position) => ({ id: `state-${type}`, name: type, type, position }));
  /** Every `setIssueState` call, in order. */
  stateChanges: Array<{ issueId: string; target: { type?: string; name?: string } }> = [];
  /** Every `updateIssue` call, in order. */
  issueUpdates: Array<{ issueId: string; input: UpdateIssueInput }> = [];
  /** Every `addIssueLabels` / `removeIssueLabel` call, in order. */
  labelChanges: Array<{ issueId: string; added?: string[]; removed?: string[] }> = [];
  /** Every agent session `createAgentSessionOnIssue` opened, in order. */
  sessionsCreated: Array<{ issueId: string; sessionId: string }> = [];
  /** Issue ID -> its comments, oldest first. */
  commentsByIssue = new Map<string, IssueComment[]>();
  /** Upload URL -> the file `downloadUpload` returns (any other URL: 404). */
  uploads = new Map<
    string,
    { contentType: string; body: string | Uint8Array<ArrayBuffer>; status?: number }
  >();
  /** Every `downloadUpload` URL, in order. */
  downloads: string[] = [];
  /** Calls by method name, e.g. to fail one: `failures.set("getIssue", new Error())`. */
  failures = new Map<string, Error>();

  add(partial: Partial<IssueSummary> & { title: string }): IssueSummary {
    this.seq += 1;
    const id = partial.id ?? `issue-${this.seq}`;
    const issue: IssueSummary = {
      id,
      identifier: partial.identifier ?? `ENG-${this.seq}`,
      description: "",
      url: `https://linear.app/acme/issue/${partial.identifier ?? `ENG-${this.seq}`}`,
      branchName: `eng-${this.seq}-branch`,
      teamId: "team-1",
      teamKey: "ENG",
      stateType: "unstarted",
      stateName: "Todo",
      labels: [],
      priority: 0,
      ...partial,
    };
    this.issues.set(id, issue);
    return issue;
  }

  private fail(method: string): void {
    const error = this.failures.get(method);
    if (error) throw error;
  }

  private find(idOrIdentifier: string): IssueSummary {
    const issue =
      this.issues.get(idOrIdentifier) ??
      [...this.issues.values()].find((i) => i.identifier === idOrIdentifier);
    if (!issue) throw new Error(`no issue ${idOrIdentifier}`);
    return issue;
  }

  async getOrganization() {
    return { id: "org-1", name: "Acme" };
  }
  async listTeams(): Promise<Team[]> {
    this.fail("listTeams");
    return this.teams.map((t) => ({ ...t }));
  }
  async getViewer(): Promise<Viewer> {
    this.fail("getViewer");
    return { ...this.viewer };
  }
  async getIssue(idOrIdentifier: string) {
    this.fail("getIssue");
    return { ...this.find(idOrIdentifier) };
  }
  async getChildren(issueId: string) {
    return [...this.issues.values()].filter((i) => i.parentId === issueId).map((i) => ({ ...i }));
  }
  async getComments(issueId: string): Promise<IssueComment[]> {
    this.fail("getComments");
    return (this.commentsByIssue.get(issueId) ?? []).map((c) => ({ ...c }));
  }
  async getBlockers(issueId: string): Promise<Blocker[]> {
    return (this.blocks.get(issueId) ?? []).map((id) => {
      const blocker = this.find(id);
      return {
        id: blocker.id,
        identifier: blocker.identifier,
        title: blocker.title,
        stateType: blocker.stateType,
      };
    });
  }
  async getWorkflowStates(_teamId: string): Promise<WorkflowState[]> {
    return this.workflowStates.map((s) => ({ ...s }));
  }
  async findLabel(teamId: string, name: string) {
    return this.labels.find((l) => l.name.toLowerCase() === name.toLowerCase()) ?? null;
  }
  async createLabel(teamId: string, name: string) {
    const label = { id: `label-${this.labels.length + 1}`, name, teamId };
    this.labels.push(label);
    return label;
  }
  async createIssue(input: CreateIssueInput) {
    this.fail("createIssue");
    const issue = this.add({
      title: input.title,
      description: input.description,
      parentId: input.parentId,
      teamId: input.teamId,
      priority: input.priority ?? 0,
      subIssueSortOrder: input.subIssueSortOrder,
      labels: input.labels ?? [],
      projectName: input.projectName,
    });
    if (input.delegateId !== undefined) {
      this.delegations.push({ issueId: issue.id, delegateId: input.delegateId });
    }
    return { ...issue };
  }
  async createBlocksRelation(blockerId: string, blockedId: string) {
    this.blocks.set(blockedId, [...(this.blocks.get(blockedId) ?? []), blockerId]);
  }
  /** Like Linear's: a state with `target.name` (ignoring case), else the first of `target.type`. */
  async setIssueState(issueId: string, target: { type?: string; name?: string }) {
    this.fail("setIssueState");
    this.stateChanges.push({ issueId, target });
    const issue = this.find(issueId);
    const name = target.name?.toLowerCase();
    const state =
      (name && this.workflowStates.find((s) => s.name.toLowerCase() === name)) ||
      (target.type && this.workflowStates.find((s) => s.type === target.type));
    if (!state) return;
    issue.stateType = state.type;
    issue.stateName = state.name;
  }
  async updateIssue(issueId: string, input: UpdateIssueInput) {
    this.fail("updateIssue");
    this.issueUpdates.push({ issueId, input: { ...input } });
    const issue = this.find(issueId);
    if (input.title !== undefined) issue.title = input.title;
    if (input.description !== undefined) issue.description = input.description;
    if (input.priority !== undefined) issue.priority = input.priority;
  }
  /** A label's name in `labels`, else its ID (issues hold label names). */
  private labelName(labelId: string): string {
    return this.labels.find((l) => l.id === labelId)?.name ?? labelId;
  }
  async addIssueLabels(issueId: string, labelIds: string[]) {
    this.fail("addIssueLabels");
    this.labelChanges.push({ issueId, added: [...labelIds] });
    const issue = this.find(issueId);
    const have = new Set(issue.labels.map((l) => l.toLowerCase()));
    for (const name of labelIds.map((id) => this.labelName(id))) {
      if (!have.has(name.toLowerCase())) issue.labels = [...issue.labels, name];
      have.add(name.toLowerCase());
    }
  }
  async removeIssueLabel(issueId: string, labelId: string) {
    this.fail("removeIssueLabel");
    this.labelChanges.push({ issueId, removed: [labelId] });
    const issue = this.find(issueId);
    const name = this.labelName(labelId).toLowerCase();
    issue.labels = issue.labels.filter((l) => l.toLowerCase() !== name);
  }
  async delegateIssue(issueId: string, delegateId: string) {
    this.fail("delegateIssue");
    this.delegations.push({ issueId: this.find(issueId).id, delegateId });
  }
  async createAgentSessionOnIssue(issueId: string) {
    this.fail("createAgentSessionOnIssue");
    const issue = this.find(issueId);
    const sessionId = `session-${this.sessionsCreated.length + 1}`;
    this.sessionsCreated.push({ issueId: issue.id, sessionId });
    return sessionId;
  }
  async addComment(issueId: string, body: string) {
    this.comments.push({ issueId, body });
  }
  async createActivity(sessionId: string, content: ActivityContent, options?: ActivityOptions) {
    this.activities.push({ sessionId, content, ...(options && { options }) });
  }
  async updateSessionPlan(sessionId: string, plan: PlanStep[]) {
    this.plans.set(sessionId, [...(this.plans.get(sessionId) ?? []), plan]);
  }
  async addSessionExternalUrl(sessionId: string, label: string, url: string) {
    this.urls.push({ sessionId, label, url });
  }

  async downloadUpload(url: string): Promise<UploadDownload> {
    this.fail("downloadUpload");
    this.downloads.push(url);
    const upload = this.uploads.get(url);
    if (!upload)
      return { ok: false, status: 404, contentType: "", contentLength: null, body: null };
    const bytes =
      typeof upload.body === "string" ? new TextEncoder().encode(upload.body) : upload.body;
    const status = upload.status ?? 200;
    const ok = status >= 200 && status < 300;
    return {
      ok,
      status,
      contentType: upload.contentType,
      contentLength: bytes.byteLength,
      body: ok ? new Response(bytes).body : null,
    };
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
}

/** A run a test expects to have come from Linear, with its issue and session; throws otherwise. */
export function linearRun<T extends Parameters<typeof isLinearRun>[0]>(run: T): LinearRun<T> {
  if (!isLinearRun(run)) throw new Error("Expected a run from Linear");
  return run;
}
