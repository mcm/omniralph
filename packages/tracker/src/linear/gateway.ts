import { InvalidInputLinearError, LinearClient } from "@linear/sdk";
import type { GatewayWith } from "../capabilities.js";
import {
  isWorkflowStateType,
  toIssuePriority,
  TrackerInvalidInputError,
  TrackerNotFoundError,
  type ActivityContent,
  type ActivityOptions,
  type Blocker,
  type CreateIssueInput,
  type IssueComment,
  type IssueLabel,
  type IssueSummary,
  type ListIssuesFilter,
  type PlanStep,
  type Project,
  type Team,
  type TrackerCapability,
  type TrackerDocument,
  type TrackerDocuments,
  type TrackerDelegation,
  type TrackerSessions,
  type TrackerUploads,
  type UpdateIssueInput,
  type UploadDownload,
  type UploadFileInput,
  type Viewer,
  type WorkflowState,
  type WorkflowStateType,
  type Workspace,
  type IssueStateTarget,
} from "../types.js";
import {
  parseIssueIdentifier,
  type IssueWithRouting,
  type RoutingIssue,
  type RoutingIssueFields,
} from "../routing.js";
import { findLinearUploads, isLinearUploadUrl } from "./uploads.js";

export { parseIssueIdentifier };
export type { RoutingIssue, RoutingIssueFields };

/**
 * The Linear adapter of the tracker gateway (ported from cyralph):
 * `SdkLinearGateway` implements {@link LinearGateway} with `@linear/sdk`, with
 * every optional capability (agent sessions, delegation, documents, uploads).
 */

export interface ProjectMilestone {
  id: string;
  name: string;
  /** The project's name. */
  projectName: string;
}

export interface Cycle {
  id: string;
  number: number;
  /** Null when the cycle has no name of its own ("Cycle 12"). */
  name: string | null;
  teamKey: string;
}

/** A workspace member (not a deactivated one). */
export interface User {
  id: string;
  name: string;
}

/** `ListIssuesFilter` with Linear's extras. */
export interface LinearListIssuesFilter extends ListIssuesFilter {
  /** Each issue also carries its `routing` fields (selected in the same query). */
  withRoutingFields?: boolean;
}

/** An issue `listIssues` returned, with its blockers and (when asked) its routing fields. */
export interface LinearIssueWithBlockers extends IssueWithRouting {
  /** Its routing fields and its parent's, when the filter asked `withRoutingFields`. */
  routing?: RoutingIssue;
}

/** A page of `listIssues`. */
export interface LinearIssuePage {
  issues: LinearIssueWithBlockers[];
  /** The `after` of the next page; null on the last one. */
  endCursor: string | null;
}

/** `CreateIssueInput` with Linear's extras. */
export interface LinearCreateIssueInput extends CreateIssueInput {
  projectMilestoneId?: string;
  cycleId?: string;
}

/**
 * The tracker gateway over Linear: the core operations, every optional
 * capability, and the Linear-only reads routing uses (milestones, cycles,
 * users and an issue's routing fields).
 */
export interface LinearGateway extends GatewayWith<TrackerCapability> {
  readonly provider: "linear";
  listIssues(filter: LinearListIssuesFilter): Promise<LinearIssuePage>;
  createIssue(input: LinearCreateIssueInput): Promise<IssueSummary>;
  /** An issue's routing field values and its parent's, in one query. */
  getRoutingFields(idOrIdentifier: string): Promise<RoutingIssue>;
  /** Every project's milestones (every page). */
  listProjectMilestones(): Promise<ProjectMilestone[]>;
  /** Every team's current and upcoming cycles (every page). */
  listCycles(): Promise<Cycle[]>;
  /** The workspace's active users (every page). */
  listUsers(): Promise<User[]>;
}

/** A Linear workflow state type as the neutral one (Linear's are the same six). */
export function toWorkflowStateType(type: string | null | undefined): WorkflowStateType {
  return type && isWorkflowStateType(type) ? type : "unstarted";
}

const PAGE_SIZE = 100;

/** The fields of an issue (`summarize`), selected on `Issue` and on `IssueSearchResult`. */
const ISSUE_SELECTION = /* GraphQL */ `
    id
    identifier
    title
    description
    url
    branchName
    priority
    subIssueSortOrder
    updatedAt
    parent {
      id
    }
    assignee {
      id
    }
    delegate {
      id
    }
    creator {
      id
      name
      url
    }
    team {
      id
      key
      name
    }
    state {
      id
      name
      type
    }
    labels(first: 50) {
      nodes {
        name
      }
    }
    project {
      id
      name
    }
  `;

const ISSUE_FIELDS = /* GraphQL */ `
  fragment IssueFields on Issue {
    ${ISSUE_SELECTION}
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
  updatedAt?: string | null;
  parent?: { id: string } | null;
  assignee?: { id: string } | null;
  delegate?: { id: string } | null;
  creator?: { id: string; name: string; url?: string | null } | null;
  team?: { id: string; key: string; name?: string | null } | null;
  state?: { id?: string | null; name: string; type: string } | null;
  labels?: { nodes: Array<{ name: string }> } | null;
  project?: { id?: string | null; name: string } | null;
}

/** The routing fields of an issue (`routingFieldsOf`), with up to `labels` labels. */
const routingSelection = (labels: number) => /* GraphQL */ `
    id
    identifier
    title
    description
    priority
    estimate
    dueDate
    parent {
      id
      identifier
    }
    assignee {
      id
    }
    creator {
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
    labels(first: ${labels}) {
      nodes {
        name
      }
    }
    project {
      id
      name
    }
    projectMilestone {
      id
      name
    }
    cycle {
      id
    }
  `;

interface RoutingNode {
  id: string;
  identifier: string;
  title: string;
  description?: string | null;
  priority?: number | null;
  estimate?: number | null;
  dueDate?: string | null;
  parent?: { id: string; identifier: string } | null;
  assignee?: { id: string } | null;
  creator?: { id: string } | null;
  team?: { id?: string; key: string } | null;
  state?: { name: string; type: string } | null;
  labels?: { nodes: Array<{ name: string }> } | null;
  project?: { id?: string; name: string } | null;
  projectMilestone?: { id?: string; name: string } | null;
  cycle?: { id: string } | null;
}

function routingFieldsOf(issue: RoutingNode): RoutingIssueFields {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? "",
    team: issue.team?.key ?? null,
    project: issue.project?.name ?? null,
    projectMilestone: issue.projectMilestone?.name ?? null,
    cycle: issue.cycle?.id ?? null,
    state: issue.state?.name ?? null,
    stateType: issue.state?.type ?? null,
    priority: issue.priority ?? 0,
    assignee: issue.assignee?.id ?? null,
    creator: issue.creator?.id ?? null,
    parent: issue.parent?.identifier ?? null,
    parentId: issue.parent?.id ?? null,
    labels: issue.labels?.nodes.map((l) => l.name) ?? [],
    estimate: issue.estimate ?? null,
    dueDate: issue.dueDate ?? null,
    teamId: issue.team?.id ?? null,
    projectId: issue.project?.id ?? null,
    projectMilestoneId: issue.projectMilestone?.id ?? null,
  };
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
    ...(issue.branchName && { branchName: issue.branchName }),
    teamId: issue.team?.id ?? "",
    teamKey: issue.team?.key ?? "",
    ...(issue.team?.name && { teamName: issue.team.name }),
    ...(issue.state?.id && { stateId: issue.state.id }),
    stateType: toWorkflowStateType(issue.state?.type),
    stateName: issue.state?.name ?? "",
    labels: issue.labels?.nodes.map((l) => l.name) ?? [],
    priority: toIssuePriority(issue.priority),
    subIssueSortOrder: issue.subIssueSortOrder ?? undefined,
    projectName: issue.project?.name ?? undefined,
    ...(issue.project?.id && { projectId: issue.project.id }),
    parentId: issue.parent?.id ?? undefined,
    assigneeId: issue.assignee?.id ?? undefined,
    ...(issue.delegate?.id && { delegateId: issue.delegate.id }),
    ...(issue.updatedAt && { updatedAt: issue.updatedAt }),
    creator: issue.creator
      ? {
          id: issue.creator.id,
          name: issue.creator.name,
          ...(issue.creator.url && { url: issue.creator.url }),
        }
      : undefined,
  };
}

/** An issue's relations as `inverseRelations` lists them. */
interface RelationNode {
  type: string;
  issue?: {
    id: string;
    identifier: string;
    title?: string | null;
    state?: { type: string; name?: string | null } | null;
  } | null;
}

/** The `blocks` relations among an issue's inverse relations: the issues that block it. */
function blockersOf(nodes: RelationNode[]): Blocker[] {
  return nodes.flatMap((rel) =>
    rel.type === "blocks" && rel.issue
      ? [
          {
            id: rel.issue.id,
            identifier: rel.issue.identifier,
            title: rel.issue.title ?? undefined,
            stateType: toWorkflowStateType(rel.issue.state?.type),
            ...(rel.issue.state?.name && { stateName: rel.issue.state.name }),
          },
        ]
      : [],
  );
}

/** Blockers `listIssues` reads per issue (in the same query, so its complexity stays bounded). */
const BLOCKERS_PER_ISSUE = 25;

/** `ListIssuesFilter` as a Linear `IssueFilter` (every condition must hold). */
export function issueFilter(filter: LinearListIssuesFilter): Record<string, unknown> {
  const and: Array<Record<string, unknown>> = [];
  if (filter.teamId) and.push({ team: { id: { eq: filter.teamId } } });
  if (filter.teamKey) and.push({ team: { key: { eqIgnoreCase: filter.teamKey } } });
  if (filter.projectId) and.push({ project: { id: { eq: filter.projectId } } });
  if (filter.projectName) and.push({ project: { name: { eqIgnoreCase: filter.projectName } } });
  if (filter.withoutProject) and.push({ project: { null: true } });
  if (filter.labelIds?.length) and.push({ labels: { some: { id: { in: filter.labelIds } } } });
  if (filter.labelNames?.length) {
    and.push({
      or: filter.labelNames.map((name) => ({ labels: { some: { name: { eqIgnoreCase: name } } } })),
    });
  }
  if (filter.delegateId) and.push({ delegate: { id: { eq: filter.delegateId } } });
  if (filter.notDelegateId) {
    and.push({
      or: [{ delegate: { null: true } }, { delegate: { id: { neq: filter.notDelegateId } } }],
    });
  }
  if (filter.stateTypes) and.push({ state: { type: { in: filter.stateTypes } } });
  if (filter.identifiers) {
    const or = filter.identifiers.flatMap((identifier) => {
      const parsed = parseIssueIdentifier(identifier);
      return parsed
        ? [{ team: { key: { eqIgnoreCase: parsed.teamKey } }, number: { eq: parsed.number } }]
        : [];
    });
    // No valid identifier matches nothing, not everything.
    and.push(or.length ? { or } : { id: { in: [] } });
  }
  if (filter.stateMatch) {
    const { types, typesExceptTeamIds, ids } = filter.stateMatch;
    const or: Array<Record<string, unknown>> = [];
    if (types.length) {
      or.push({
        state: { type: { in: types } },
        ...(typesExceptTeamIds.length && { team: { id: { nin: typesExceptTeamIds } } }),
      });
    }
    if (ids.length) or.push({ state: { id: { in: ids } } });
    // No state matches: an impossible condition rather than none.
    and.push(or.length ? { or } : { state: { id: { in: [] } } });
  }
  return { and };
}

/** Thrown when Linear answers a mutation with `success: false` or without the created entity. */
export class LinearMutationError extends Error {
  constructor(operation: string) {
    super(`Linear ${operation} did not succeed`);
    this.name = "LinearMutationError";
  }
}

/** Whether the error is Linear refusing the input (an unknown ID included: "Entity not found"). */
function isInvalidInput(error: unknown): error is TrackerInvalidInputError {
  return error instanceof TrackerInvalidInputError;
}

/**
 * `LinearGateway` over `@linear/sdk`. Each call is one named GraphQL document
 * (the SDK's lazy model getters would cost a request per relation), sent
 * through the SDK client so auth, errors and rate limits are the SDK's.
 */
export class SdkLinearGateway implements LinearGateway {
  readonly provider = "linear" as const;
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

  readonly sessions: TrackerSessions = {
    createSessionOnIssue: (issueId) => this.createSessionOnIssue(issueId),
    createActivity: (sessionId, content, options) =>
      this.createActivity(sessionId, content, options),
    updatePlan: (sessionId, plan) => this.updatePlan(sessionId, plan),
    addExternalUrl: (sessionId, label, url) => this.addExternalUrl(sessionId, label, url),
  };

  readonly delegation: TrackerDelegation = {
    delegateIssue: (issueId, delegateId) => this.delegateIssue(issueId, delegateId),
  };

  readonly documents: TrackerDocuments = {
    getDocument: (ref) => this.getDocument(ref),
  };

  readonly uploads: TrackerUploads = {
    isUploadUrl: isLinearUploadUrl,
    findUploads: findLinearUploads,
    downloadUpload: (url, signal) => this.downloadUpload(url, signal),
    uploadFile: (input) => this.uploadFile(input),
  };

  /** Linear refusing the input (`InvalidInputLinearError`) throws a `TrackerInvalidInputError`. */
  private async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let response;
    try {
      response = await this.client.client.rawRequest<T, Record<string, unknown>>(query, variables);
    } catch (error) {
      if (error instanceof InvalidInputLinearError) {
        throw new TrackerInvalidInputError(error.message, { cause: error });
      }
      throw error;
    }
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

  async getWorkspace(): Promise<Workspace> {
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

  async listTeams(): Promise<Team[]> {
    return this.paginate(async (after) => {
      const data = await this.request<{ teams: Connection<Team> }>(
        /* GraphQL */ `
          query Teams($first: Int!, $after: String) {
            teams(first: $first, after: $after) {
              nodes {
                id
                key
                name
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        { first: PAGE_SIZE, after },
      );
      return data.teams;
    });
  }

  async getViewer(): Promise<Viewer> {
    const data = await this.request<{ viewer: Viewer }>(/* GraphQL */ `
      query Viewer {
        viewer {
          id
          name
        }
      }
    `);
    return { id: data.viewer.id, name: data.viewer.name };
  }

  /** Runs a read of one entity by ref, answering Linear's "Entity not found" with `TrackerNotFoundError`. */
  private async findOne<T>(entity: string, ref: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (isInvalidInput(error)) throw new TrackerNotFoundError(entity, ref, { cause: error });
      throw error;
    }
  }

  async getIssue(idOrIdentifier: string): Promise<IssueSummary> {
    const data = await this.findOne("issue", idOrIdentifier, () =>
      this.request<{ issue: IssueNode }>(
        /* GraphQL */ `
          query Issue($id: String!) {
            issue(id: $id) {
              ...IssueFields
            }
          }
          ${ISSUE_FIELDS}
        `,
        { id: idOrIdentifier },
      ),
    );
    return summarize(data.issue);
  }

  async getRoutingFields(idOrIdentifier: string): Promise<RoutingIssue> {
    const data = await this.findOne("issue", idOrIdentifier, () =>
      this.request<{
        issue: RoutingNode & { parentIssue?: RoutingNode | null };
      }>(
        /* GraphQL */ `
        query IssueRoutingFields($id: String!) {
          issue(id: $id) {
            ...RoutingFields
            parentIssue: parent {
              ...RoutingFields
            }
          }
        }
        fragment RoutingFields on Issue {
          ${routingSelection(250)}
        }
      `,
        { id: idOrIdentifier },
      ),
    );
    const { parentIssue, ...issue } = data.issue;
    return {
      issue: routingFieldsOf(issue),
      parent: parentIssue ? routingFieldsOf(parentIssue) : null,
    };
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

  async searchIssues(query: string, options: { first?: number } = {}): Promise<IssueSummary[]> {
    const data = await this.request<{ searchIssues: { nodes: IssueNode[] } }>(
      /* GraphQL */ `
        query SearchIssues($term: String!, $first: Int!) {
          searchIssues(term: $term, first: $first) {
            nodes {
              ...IssueSearchFields
            }
          }
        }
        fragment IssueSearchFields on IssueSearchResult {
          ${ISSUE_SELECTION}
        }
      `,
      { term: query, first: options.first ?? 10 },
    );
    return data.searchIssues.nodes.map(summarize);
  }

  /** A document by ID or slug ID. */
  private async getDocument(idOrSlugId: string): Promise<TrackerDocument> {
    type DocumentNode = {
      id: string;
      title: string;
      content?: string | null;
      url: string;
      updatedAt: string;
      project?: { name: string } | null;
      issue?: { identifier: string } | null;
    };
    const { document } = await this.findOne("document", idOrSlugId, () =>
      this.request<{ document: DocumentNode }>(
        /* GraphQL */ `
          query Document($id: String!) {
            document(id: $id) {
              id
              title
              content
              url
              updatedAt
              project {
                name
              }
              issue {
                identifier
              }
            }
          }
        `,
        { id: idOrSlugId },
      ),
    );
    return {
      id: document.id,
      title: document.title,
      content: document.content ?? "",
      url: document.url,
      updatedAt: document.updatedAt,
      ...(document.project && { projectName: document.project.name }),
      ...(document.issue && { issueIdentifier: document.issue.identifier }),
    };
  }

  async getBlockers(issueId: string): Promise<Blocker[]> {
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
                    title
                    state {
                      type
                      name
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
    return blockersOf(nodes);
  }

  async listIssues(filter: LinearListIssuesFilter): Promise<LinearIssuePage> {
    // The routing fields share `IssueFields`' labels selection (50), so the fragments merge.
    const routing = filter.withRoutingFields
      ? {
          spread: /* GraphQL */ `
              ...ListRoutingFields
              parentIssue: parent {
                ...ListRoutingFields
              }`,
          fragment: /* GraphQL */ `
            fragment ListRoutingFields on Issue {
              ${routingSelection(50)}
            }`,
        }
      : { spread: "", fragment: "" };
    const data = await this.request<{
      issues: Connection<
        IssueNode &
          RoutingNode & {
            inverseRelations: { nodes: RelationNode[] };
            parentIssue?: RoutingNode | null;
          }
      >;
    }>(
      /* GraphQL */ `
        query ListIssues($filter: IssueFilter, $first: Int!, $after: String) {
          issues(filter: $filter, first: $first, after: $after) {
            nodes {
              ...IssueFields${routing.spread}
              inverseRelations(first: ${BLOCKERS_PER_ISSUE}) {
                nodes {
                  type
                  issue {
                    id
                    identifier
                    title
                    state {
                      type
                      name
                    }
                  }
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
        ${ISSUE_FIELDS}${routing.fragment}
      `,
      { filter: issueFilter(filter), first: filter.first, after: filter.after ?? null },
    );
    return {
      issues: data.issues.nodes.map(({ inverseRelations, parentIssue, ...issue }) => ({
        ...summarize(issue),
        blockers: blockersOf(inverseRelations.nodes),
        ...(filter.withRoutingFields && {
          routing: {
            issue: routingFieldsOf(issue),
            parent: parentIssue ? routingFieldsOf(parentIssue) : null,
          },
        }),
      })),
      endCursor: data.issues.pageInfo.hasNextPage ? (data.issues.pageInfo.endCursor ?? null) : null,
    };
  }

  getWorkflowStates(teamId: string): Promise<WorkflowState[]> {
    let states = this.statesByTeam.get(teamId);
    if (!states) {
      states = this.request<{
        workflowStates: { nodes: Array<Omit<WorkflowState, "type"> & { type: string }> };
      }>(
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
      ).then((data) =>
        data.workflowStates.nodes
          .map((state) => ({ ...state, type: toWorkflowStateType(state.type) }))
          .sort((a, b) => a.position - b.position),
      );
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

  async listLabels(): Promise<IssueLabel[]> {
    type LabelNode = { id: string; name: string; isGroup: boolean; team?: { id: string } | null };
    const nodes = await this.paginate(async (after) => {
      const data = await this.request<{ issueLabels: Connection<LabelNode> }>(
        /* GraphQL */ `
          query IssueLabels($first: Int!, $after: String) {
            issueLabels(first: $first, after: $after) {
              nodes {
                id
                name
                isGroup
                team {
                  id
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        { first: PAGE_SIZE, after },
      );
      return data.issueLabels;
    });
    // A label group only parents its labels; issues can't carry it.
    return nodes
      .filter((l) => !l.isGroup)
      .map((l) => ({ id: l.id, name: l.name, teamId: l.team?.id ?? null }));
  }

  async listProjects(): Promise<Project[]> {
    return this.paginate(async (after) => {
      const data = await this.request<{ projects: Connection<Project> }>(
        /* GraphQL */ `
          query Projects($first: Int!, $after: String) {
            projects(first: $first, after: $after) {
              nodes {
                id
                name
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        { first: PAGE_SIZE, after },
      );
      return data.projects;
    });
  }

  async listProjectMilestones(): Promise<ProjectMilestone[]> {
    type MilestoneNode = { id: string; name: string; project?: { name: string } | null };
    const nodes = await this.paginate(async (after) => {
      const data = await this.request<{ projectMilestones: Connection<MilestoneNode> }>(
        /* GraphQL */ `
          query ProjectMilestones($first: Int!, $after: String) {
            projectMilestones(first: $first, after: $after) {
              nodes {
                id
                name
                project {
                  name
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        { first: PAGE_SIZE, after },
      );
      return data.projectMilestones;
    });
    return nodes.map((m) => ({ id: m.id, name: m.name, projectName: m.project?.name ?? "" }));
  }

  async listCycles(): Promise<Cycle[]> {
    type CycleNode = {
      id: string;
      number: number;
      name?: string | null;
      team?: { key: string } | null;
    };
    const nodes = await this.paginate(async (after) => {
      const data = await this.request<{ cycles: Connection<CycleNode> }>(
        /* GraphQL */ `
          query Cycles($first: Int!, $after: String) {
            cycles(first: $first, after: $after, filter: { isPast: { eq: false } }) {
              nodes {
                id
                number
                name
                team {
                  key
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        { first: PAGE_SIZE, after },
      );
      return data.cycles;
    });
    return nodes.map((c) => ({
      id: c.id,
      number: c.number,
      name: c.name || null,
      teamKey: c.team?.key ?? "",
    }));
  }

  async listUsers(): Promise<User[]> {
    return this.paginate(async (after) => {
      const data = await this.request<{ users: Connection<User> }>(
        /* GraphQL */ `
          query Users($first: Int!, $after: String) {
            users(first: $first, after: $after) {
              nodes {
                id
                name
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        `,
        { first: PAGE_SIZE, after },
      );
      return data.users;
    });
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

  async createIssue(input: LinearCreateIssueInput): Promise<IssueSummary> {
    const projectId =
      input.projectId ?? (input.projectName ? await this.projectId(input.projectName) : undefined);
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
          ...(input.projectMilestoneId && { projectMilestoneId: input.projectMilestoneId }),
          ...(input.cycleId && { cycleId: input.cycleId }),
          ...(labelIds && { labelIds }),
          ...(input.delegateId !== undefined && { delegateId: input.delegateId }),
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

  async setIssueState(issueId: string, target: IssueStateTarget): Promise<void> {
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
      (target.id && states.find((s) => s.id === target.id)) ||
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

  private async delegateIssue(issueId: string, delegateId: string | null): Promise<void> {
    await this.issueUpdate(issueId, { delegateId });
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

  async linkUrl(issueId: string, url: string, title?: string): Promise<void> {
    await this.mutate(
      "attachmentLinkURL",
      /* GraphQL */ `
        mutation LinkUrl($issueId: String!, $url: String!, $title: String) {
          attachmentLinkURL(issueId: $issueId, url: $url, title: $title) {
            success
          }
        }
      `,
      { issueId, url, title: title ?? null },
    );
  }

  private async createSessionOnIssue(issueId: string): Promise<string> {
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

  private async createActivity(
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

  private updatePlan(sessionId: string, plan: PlanStep[]): Promise<void> {
    return this.updateSession(sessionId, { plan });
  }

  private addExternalUrl(sessionId: string, label: string, url: string): Promise<void> {
    return this.updateSession(sessionId, { addedExternalUrls: [{ label, url }] });
  }

  private async downloadUpload(url: string, signal?: AbortSignal): Promise<UploadDownload> {
    if (!isLinearUploadUrl(url)) throw new Error("not a Linear upload URL");
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

  private async uploadFile(input: UploadFileInput): Promise<string> {
    const { uploadFile } = await this.mutate<
      "fileUpload",
      {
        success: boolean;
        uploadFile?: {
          uploadUrl: string;
          assetUrl: string;
          headers: Array<{ key: string; value: string }>;
        } | null;
      }
    >(
      "fileUpload",
      /* GraphQL */ `
        mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
          fileUpload(contentType: $contentType, filename: $filename, size: $size) {
            success
            uploadFile {
              uploadUrl
              assetUrl
              headers {
                key
                value
              }
            }
          }
        }
      `,
      { contentType: input.contentType, filename: input.filename, size: input.data.byteLength },
    );
    if (!uploadFile) throw new LinearMutationError("fileUpload");
    // The signed URL carries its own auth: Linear's headers, never the token.
    const headers = new Headers({
      "content-type": input.contentType,
      "cache-control": "public, max-age=31536000",
    });
    for (const { key, value } of uploadFile.headers) headers.set(key, value);
    const res = await fetch(uploadFile.uploadUrl, {
      method: "PUT",
      headers,
      body: new Uint8Array(input.data),
    });
    if (!res.ok) throw new Error(`Linear's file storage answered ${res.status} to the upload`);
    return uploadFile.assetUrl;
  }
}
