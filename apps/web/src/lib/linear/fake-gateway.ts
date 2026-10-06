/**
 * An in-memory `LinearGateway` for tests (ported from cyralph's `FakeLinear`):
 * issues, blocks relations, comments, activities, plans and session URLs are
 * plain fields to arrange and assert on.
 */
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
  async getIssue(idOrIdentifier: string) {
    this.fail("getIssue");
    return { ...this.find(idOrIdentifier) };
  }
  async getChildren(issueId: string) {
    return [...this.issues.values()].filter((i) => i.parentId === issueId).map((i) => ({ ...i }));
  }
  async getComments(_issueId: string): Promise<IssueComment[]> {
    return [];
  }
  async getBlockers(issueId: string): Promise<Blocker[]> {
    return (this.blocks.get(issueId) ?? []).map((id) => {
      const blocker = this.find(id);
      return { id: blocker.id, identifier: blocker.identifier, stateType: blocker.stateType };
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
    return {
      ...this.add({
        title: input.title,
        description: input.description,
        parentId: input.parentId,
        teamId: input.teamId,
        priority: input.priority ?? 0,
        subIssueSortOrder: input.subIssueSortOrder,
        labels: input.labels ?? [],
        projectName: input.projectName,
      }),
    };
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
