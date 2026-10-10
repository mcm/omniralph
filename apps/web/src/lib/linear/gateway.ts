import "server-only";
import { LinearClient } from "@linear/sdk";
import { isUploadUrl } from "@omniralph/ralph";

/**
 * The slice of Linear the ralph loop needs, behind an interface so the
 * orchestrator can be tested without the network (ported from cyralph).
 * `SdkLinearGateway` implements it with `@linear/sdk`.
 */

export interface IssueSummary {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  branchName: string;
  teamId: string;
  teamKey: string;
  stateType: string;
  stateName: string;
  labels: string[];
  /** Linear priority: 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low. */
  priority: number;
  /** Manual position among its parent's sub-issues. */
  subIssueSortOrder?: number;
  projectName?: string;
  parentId?: string;
  assigneeId?: string;
}

export interface IssueComment {
  body: string;
  author?: string;
  createdAt?: string;
}

export interface Blocker {
  id: string;
  identifier: string;
  stateType: string;
}

export interface WorkflowState {
  id: string;
  name: string;
  /** `triage`, `backlog`, `unstarted`, `started`, `completed` or `canceled`. */
  type: string;
  position: number;
}

export interface IssueLabel {
  id: string;
  name: string;
  /** Null for a workspace label. */
  teamId: string | null;
}

export interface CreateIssueInput {
  teamId: string;
  title: string;
  description: string;
  parentId?: string;
  priority?: number;
  subIssueSortOrder?: number;
  projectName?: string;
  /** Label names (case-insensitive); a label the team doesn't have yet is created for it. */
  labels?: string[];
}

/** Fields `updateIssue` changes; omitted ones are left as they are. */
export interface UpdateIssueInput {
  title?: string;
  description?: string;
  /** Linear priority: 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low. */
  priority?: number;
}

export type ActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string }
  | { type: "elicitation"; body: string };

export interface ActivityOptions {
  /** Ephemeral activities are replaced by the next activity (thoughts/actions only). */
  ephemeral?: boolean;
  /** e.g. `select` with `signalMetadata: { options: [{ value }] }` renders a picker in Linear. */
  signal?: "select" | "auth" | "stop" | "continue";
  signalMetadata?: Record<string, unknown>;
}

export interface PlanStep {
  content: string;
  status: "pending" | "inProgress" | "completed" | "canceled";
}

/** A file uploaded to Linear, as `downloadUpload` fetched it. */
export interface UploadDownload {
  /** False for an error status. */
  ok: boolean;
  status: number;
  /** Without parameters, e.g. `image/png`. */
  contentType: string;
  /** From `Content-Length`, when Linear sent one. */
  contentLength: number | null;
  /** The file (null after an error status). */
  body: ReadableStream<Uint8Array> | null;
}

export interface LinearGateway {
  /** The installing workspace. */
  getOrganization(): Promise<{ id: string; name: string }>;
  getIssue(idOrIdentifier: string): Promise<IssueSummary>;
  /** Every sub-issue (all pages). */
  getChildren(issueId: string): Promise<IssueSummary[]>;
  /** Comments on an issue, oldest first. */
  getComments(issueId: string): Promise<IssueComment[]>;
  /** Issues that block the given issue ("X blocks this"). */
  getBlockers(issueId: string): Promise<Blocker[]>;
  /** The team's workflow states by position (cached per team for the gateway's lifetime). */
  getWorkflowStates(teamId: string): Promise<WorkflowState[]>;
  /** The team's label with this name (case-insensitive), else a workspace label, else null. */
  findLabel(teamId: string, name: string): Promise<IssueLabel | null>;
  createLabel(teamId: string, name: string): Promise<IssueLabel>;
  createIssue(input: CreateIssueInput): Promise<IssueSummary>;
  /** `blockerId` blocks `blockedId`. */
  createBlocksRelation(blockerId: string, blockedId: string): Promise<void>;
  /** Moves the issue to the named state, else the team's first state of this type. */
  setIssueState(issueId: string, target: { type?: string; name?: string }): Promise<void>;
  /** Updates the given fields of an existing issue (a no-op when none are given). */
  updateIssue(issueId: string, input: UpdateIssueInput): Promise<void>;
  /** Adds labels by ID, keeping the issue's other labels. */
  addIssueLabels(issueId: string, labelIds: string[]): Promise<void>;
  removeIssueLabel(issueId: string, labelId: string): Promise<void>;
  addComment(issueId: string, body: string): Promise<void>;
  /** Opens an agent session on the issue (as the app) and returns its ID. */
  createAgentSessionOnIssue(issueId: string): Promise<string>;
  createActivity(
    sessionId: string,
    content: ActivityContent,
    opts?: ActivityOptions,
  ): Promise<void>;
  updateSessionPlan(sessionId: string, plan: PlanStep[]): Promise<void>;
  addSessionExternalUrl(sessionId: string, label: string, url: string): Promise<void>;
  /**
   * Fetches a file uploaded to Linear (`https://uploads.linear.app/...`) with
   * the workspace's token. Rejects any other URL without sending the token.
   */
  downloadUpload(url: string, signal?: AbortSignal): Promise<UploadDownload>;
}

const PAGE_SIZE = 100;

const ISSUE_FIELDS = /* GraphQL */ `
  fragment IssueFields on Issue {
    id
    identifier
    title
    description
    url
    branchName
    priority
    subIssueSortOrder
    parent {
      id
    }
    assignee {
      id
    }
    team {
      id
      key
    }
    state {
      name
      type
    }
    labels(first: 50) {
      nodes {
        name
      }
    }
    project {
      name
    }
  }
`;

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  branchName: string;
  priority?: number | null;
  subIssueSortOrder?: number | null;
  parent?: { id: string } | null;
  assignee?: { id: string } | null;
  team?: { id: string; key: string } | null;
  state?: { name: string; type: string } | null;
  labels?: { nodes: Array<{ name: string }> } | null;
  project?: { name: string } | null;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor?: string | null;
}

interface Connection<T> {
  nodes: T[];
  pageInfo: PageInfo;
}

function summarize(issue: IssueNode): IssueSummary {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    url: issue.url,
    branchName: issue.branchName,
    teamId: issue.team?.id ?? "",
    teamKey: issue.team?.key ?? "",
    stateType: issue.state?.type ?? "unstarted",
    stateName: issue.state?.name ?? "",
    labels: issue.labels?.nodes.map((l) => l.name) ?? [],
    priority: issue.priority ?? 0,
    subIssueSortOrder: issue.subIssueSortOrder ?? undefined,
    projectName: issue.project?.name ?? undefined,
    parentId: issue.parent?.id ?? undefined,
    assigneeId: issue.assignee?.id ?? undefined,
  };
}

/** Thrown when Linear answers a mutation with `success: false` or without the created entity. */
export class LinearMutationError extends Error {
  constructor(operation: string) {
    super(`Linear ${operation} did not succeed`);
    this.name = "LinearMutationError";
  }
}

/**
 * `LinearGateway` over `@linear/sdk`. Each call is one named GraphQL document
 * (the SDK's lazy model getters would cost a request per relation), sent
 * through the SDK client so auth, errors and rate limits are the SDK's.
 */
export class SdkLinearGateway implements LinearGateway {
  private readonly client: LinearClient;
  private readonly statesByTeam = new Map<string, Promise<WorkflowState[]>>();

  constructor(
    private readonly accessToken: string,
    options: { apiUrl?: string } = {},
  ) {
    this.client = new LinearClient({
      accessToken,
      ...(options.apiUrl && { apiUrl: options.apiUrl }),
    });
  }

  private async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const response = await this.client.client.rawRequest<T, Record<string, unknown>>(
      query,
      variables,
    );
    if (!response.data) throw new Error("Linear returned no data");
    return response.data;
  }

  private async mutate<K extends string, T extends { success: boolean }>(
    name: K,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const data = await this.request<Record<K, T>>(query, variables);
    if (!data[name]?.success) throw new LinearMutationError(name);
    return data[name];
  }

  /** Follows `endCursor` until the last page. */
  private async paginate<T>(
    fetchPage: (after: string | null) => Promise<Connection<T>>,
  ): Promise<T[]> {
    const nodes: T[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await fetchPage(after);
      nodes.push(...page.nodes);
      if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) return nodes;
      after = page.pageInfo.endCursor;
    }
  }

  async getOrganization(): Promise<{ id: string; name: string }> {
    const data = await this.request<{ organization: { id: string; name: string } }>(/* GraphQL */ `
      query Organization {
        organization {
          id
          name
        }
      }
    `);
    return { id: data.organization.id, name: data.organization.name };
  }

  async getIssue(idOrIdentifier: string): Promise<IssueSummary> {
    const data = await this.request<{ issue: IssueNode }>(
      /* GraphQL */ `
        query Issue($id: String!) {
          issue(id: $id) {
            ...IssueFields
          }
        }
        ${ISSUE_FIELDS}
      `,
      { id: idOrIdentifier },
    );
    return summarize(data.issue);
  }

  async getChildren(issueId: string): Promise<IssueSummary[]> {
    const nodes = await this.paginate(async (after) => {
      const data = await this.request<{ issue: { children: Connection<IssueNode> } }>(
        /* GraphQL */ `
          query IssueChildren($id: String!, $first: Int!, $after: String) {
            issue(id: $id) {
              children(first: $first, after: $after) {
                nodes {
                  ...IssueFields
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
          ${ISSUE_FIELDS}
        `,
        { id: issueId, first: PAGE_SIZE, after },
      );
      return data.issue.children;
    });
    const unique = [...new Map(nodes.map((n) => [n.id, n])).values()];
    return unique.map(summarize);
  }

  async getComments(issueId: string): Promise<IssueComment[]> {
    type CommentNode = { body: string; createdAt: string; user?: { name: string } | null };
    const nodes = await this.paginate(async (after) => {
      const data = await this.request<{ issue: { comments: Connection<CommentNode> } }>(
        /* GraphQL */ `
          query IssueComments($id: String!, $first: Int!, $after: String) {
            issue(id: $id) {
              comments(first: $first, after: $after) {
                nodes {
                  body
                  createdAt
                  user {
                    name
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        `,
        { id: issueId, first: PAGE_SIZE, after },
      );
      return data.issue.comments;
    });
    return nodes
      .map((c) => ({ body: c.body, author: c.user?.name ?? undefined, createdAt: c.createdAt }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getBlockers(issueId: string): Promise<Blocker[]> {
    type RelationNode = {
      type: string;
      issue?: { id: string; identifier: string; state?: { type: string } | null } | null;
    };
    const nodes = await this.paginate(async (after) => {
      const data = await this.request<{ issue: { inverseRelations: Connection<RelationNode> } }>(
        /* GraphQL */ `
          query IssueBlockers($id: String!, $first: Int!, $after: String) {
            issue(id: $id) {
              inverseRelations(first: $first, after: $after) {
                nodes {
                  type
                  issue {
                    id
                    identifier
                    state {
                      type
                    }
                  }
                }
                pageInfo {
                  hasNextPage
                  endCursor
                }
              }
            }
          }
        `,
        { id: issueId, first: PAGE_SIZE, after },
      );
      return data.issue.inverseRelations;
    });
    return nodes.flatMap((rel) =>
      rel.type === "blocks" && rel.issue
        ? [
            {
              id: rel.issue.id,
              identifier: rel.issue.identifier,
              stateType: rel.issue.state?.type ?? "unstarted",
            },
          ]
        : [],
    );
  }

  getWorkflowStates(teamId: string): Promise<WorkflowState[]> {
    let states = this.statesByTeam.get(teamId);
    if (!states) {
      states = this.request<{ workflowStates: { nodes: WorkflowState[] } }>(
        /* GraphQL */ `
          query TeamWorkflowStates($teamId: ID!) {
            workflowStates(filter: { team: { id: { eq: $teamId } } }, first: 100) {
              nodes {
                id
                name
                type
                position
              }
            }
          }
        `,
        { teamId },
      ).then((data) => [...data.workflowStates.nodes].sort((a, b) => a.position - b.position));
      // A failed lookup isn't cached.
      states.catch(() => this.statesByTeam.delete(teamId));
      this.statesByTeam.set(teamId, states);
    }
    return states;
  }

  async findLabel(teamId: string, name: string): Promise<IssueLabel | null> {
    type LabelNode = { id: string; name: string; team?: { id: string } | null };
    const data = await this.request<{ issueLabels: { nodes: LabelNode[] } }>(
      /* GraphQL */ `
        query IssueLabelsByName($name: String!) {
          issueLabels(filter: { name: { eqIgnoreCase: $name } }, first: 50) {
            nodes {
              id
              name
              team {
                id
              }
            }
          }
        }
      `,
      { name },
    );
    const labels = data.issueLabels.nodes.map((l) => ({
      id: l.id,
      name: l.name,
      teamId: l.team?.id ?? null,
    }));
    return labels.find((l) => l.teamId === teamId) ?? labels.find((l) => !l.teamId) ?? null;
  }

  async createLabel(teamId: string, name: string): Promise<IssueLabel> {
    const result = await this.mutate<
      "issueLabelCreate",
      { success: boolean; issueLabel?: { id: string; name: string } | null }
    >(
      "issueLabelCreate",
      /* GraphQL */ `
        mutation CreateIssueLabel($input: IssueLabelCreateInput!) {
          issueLabelCreate(input: $input) {
            success
            issueLabel {
              id
              name
            }
          }
        }
      `,
      { input: { name, teamId } },
    );
    if (!result.issueLabel) throw new LinearMutationError("issueLabelCreate");
    return { id: result.issueLabel.id, name: result.issueLabel.name, teamId };
  }

  private async projectId(name: string): Promise<string | undefined> {
    const data = await this.request<{ projects: { nodes: Array<{ id: string }> } }>(
      /* GraphQL */ `
        query ProjectByName($name: String!) {
          projects(filter: { name: { eq: $name } }, first: 1) {
            nodes {
              id
            }
          }
        }
      `,
      { name },
    );
    return data.projects.nodes[0]?.id;
  }

  async createIssue(input: CreateIssueInput): Promise<IssueSummary> {
    const projectId = input.projectName ? await this.projectId(input.projectName) : undefined;
    const labelIds = input.labels?.length
      ? await Promise.all(
          input.labels.map(
            async (name) =>
              (
                (await this.findLabel(input.teamId, name)) ??
                (await this.createLabel(input.teamId, name))
              ).id,
          ),
        )
      : undefined;
    const result = await this.mutate<"issueCreate", { success: boolean; issue?: IssueNode | null }>(
      "issueCreate",
      /* GraphQL */ `
        mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              ...IssueFields
            }
          }
        }
        ${ISSUE_FIELDS}
      `,
      {
        input: {
          teamId: input.teamId,
          title: input.title,
          description: input.description,
          ...(input.parentId !== undefined && { parentId: input.parentId }),
          ...(input.priority !== undefined && { priority: input.priority }),
          ...(input.subIssueSortOrder !== undefined && {
            subIssueSortOrder: input.subIssueSortOrder,
          }),
          ...(projectId && { projectId }),
          ...(labelIds && { labelIds }),
        },
      },
    );
    if (!result.issue) throw new LinearMutationError("issueCreate");
    return summarize(result.issue);
  }

  async createBlocksRelation(blockerId: string, blockedId: string): Promise<void> {
    await this.mutate(
      "issueRelationCreate",
      /* GraphQL */ `
        mutation CreateIssueRelation($input: IssueRelationCreateInput!) {
          issueRelationCreate(input: $input) {
            success
          }
        }
      `,
      { input: { issueId: blockerId, relatedIssueId: blockedId, type: "blocks" } },
    );
  }

  async setIssueState(issueId: string, target: { type?: string; name?: string }): Promise<void> {
    const data = await this.request<{
      issue: { team?: { id: string } | null; state?: { id: string } | null };
    }>(
      /* GraphQL */ `
        query IssueTeamState($id: String!) {
          issue(id: $id) {
            team {
              id
            }
            state {
              id
            }
          }
        }
      `,
      { id: issueId },
    );
    const teamId = data.issue.team?.id;
    if (!teamId) return;
    const states = await this.getWorkflowStates(teamId);
    const name = target.name?.toLowerCase();
    const state =
      (name && states.find((s) => s.name.toLowerCase() === name)) ||
      (target.type && states.find((s) => s.type === target.type));
    if (!state || state.id === data.issue.state?.id) return;
    await this.mutate(
      "issueUpdate",
      /* GraphQL */ `
        mutation UpdateIssueState($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
          }
        }
      `,
      { id: issueId, input: { stateId: state.id } },
    );
  }

  private async issueUpdate(issueId: string, input: Record<string, unknown>): Promise<void> {
    await this.mutate(
      "issueUpdate",
      /* GraphQL */ `
        mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
          }
        }
      `,
      { id: issueId, input },
    );
  }

  async updateIssue(issueId: string, input: UpdateIssueInput): Promise<void> {
    const fields = {
      ...(input.title !== undefined && { title: input.title }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.priority !== undefined && { priority: input.priority }),
    };
    if (Object.keys(fields).length === 0) return;
    await this.issueUpdate(issueId, fields);
  }

  async addIssueLabels(issueId: string, labelIds: string[]): Promise<void> {
    if (labelIds.length === 0) return;
    await this.issueUpdate(issueId, { addedLabelIds: labelIds });
  }

  async removeIssueLabel(issueId: string, labelId: string): Promise<void> {
    await this.issueUpdate(issueId, { removedLabelIds: [labelId] });
  }

  async addComment(issueId: string, body: string): Promise<void> {
    await this.mutate(
      "commentCreate",
      /* GraphQL */ `
        mutation CreateComment($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
          }
        }
      `,
      { input: { issueId, body } },
    );
  }

  async createAgentSessionOnIssue(issueId: string): Promise<string> {
    const result = await this.mutate<
      "agentSessionCreateOnIssue",
      { success: boolean; agentSession?: { id: string } | null }
    >(
      "agentSessionCreateOnIssue",
      /* GraphQL */ `
        mutation CreateAgentSessionOnIssue($input: AgentSessionCreateOnIssue!) {
          agentSessionCreateOnIssue(input: $input) {
            success
            agentSession {
              id
            }
          }
        }
      `,
      { input: { issueId } },
    );
    if (!result.agentSession) throw new LinearMutationError("agentSessionCreateOnIssue");
    return result.agentSession.id;
  }

  async createActivity(
    sessionId: string,
    content: ActivityContent,
    opts?: ActivityOptions,
  ): Promise<void> {
    await this.mutate(
      "agentActivityCreate",
      /* GraphQL */ `
        mutation CreateAgentActivity($input: AgentActivityCreateInput!) {
          agentActivityCreate(input: $input) {
            success
          }
        }
      `,
      {
        input: {
          agentSessionId: sessionId,
          content,
          ...(opts?.ephemeral !== undefined && { ephemeral: opts.ephemeral }),
          ...(opts?.signal && { signal: opts.signal }),
          ...(opts?.signalMetadata && { signalMetadata: opts.signalMetadata }),
        },
      },
    );
  }

  private async updateSession(sessionId: string, input: Record<string, unknown>): Promise<void> {
    await this.mutate(
      "agentSessionUpdate",
      /* GraphQL */ `
        mutation UpdateAgentSession($id: String!, $input: AgentSessionUpdateInput!) {
          agentSessionUpdate(id: $id, input: $input) {
            success
          }
        }
      `,
      { id: sessionId, input },
    );
  }

  updateSessionPlan(sessionId: string, plan: PlanStep[]): Promise<void> {
    return this.updateSession(sessionId, { plan });
  }

  addSessionExternalUrl(sessionId: string, label: string, url: string): Promise<void> {
    return this.updateSession(sessionId, { addedExternalUrls: [{ label, url }] });
  }

  async downloadUpload(url: string, signal?: AbortSignal): Promise<UploadDownload> {
    if (!isUploadUrl(url)) throw new Error("not a Linear upload URL");
    // Redirects (e.g. to a signed storage URL) are followed; fetch drops the token on a cross-origin one.
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${this.accessToken}` },
      redirect: "follow",
      ...(signal && { signal }),
    });
    const length = Number(res.headers.get("content-length"));
    return {
      ok: res.ok,
      status: res.status,
      contentType:
        (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "",
      contentLength: res.headers.has("content-length") && Number.isFinite(length) ? length : null,
      body: res.ok ? res.body : null,
    };
  }
}
