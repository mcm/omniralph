import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { attachmentFileName } from "@omniralph/ralph";
import {
  DEFAULT_LINEAR_SEARCH_RESULTS,
  RALPH_PULL_REQUEST_ACTIONS,
  LinearEntityId,
  MAX_LINEAR_COMMENTS,
  MAX_LINEAR_SEARCH_QUERY,
  MAX_LINEAR_SEARCH_RESULTS,
  RunLinearCommentsResponse,
  RunLinearDocumentResponse,
  RunLinearIssueResponse,
  RunLinearSearchResponse,
} from "@omniralph/shared";
import {
  AGENT_TOOLS_BY_TASK_TYPE,
  type AgentTools,
  type AgentTool,
  type LinearTool,
  type TaskType,
  type ToolSettings,
} from "@omniralph/tasks";
import { z } from "zod";
import { getJson, type FetchFn } from "../api.js";
import type { ShipOutcome, ShipRequest } from "../lifecycle/request-attempt.js";
import type { Logger } from "../logger.js";
import { ActivityRelay } from "./activities.js";
import { controlPanelFetcher } from "./attachments.js";
import { PermissionRelay } from "./permissions.js";

/** The name of the in-process MCP server serving the agent tools. */
export const OMNIRALPH_SERVER = "omniralph";

/** The agent tools this agent serves (`ship` only with a `ship` handler: request coding runs). */
export const SERVED_AGENT_TOOLS: readonly AgentTool[] = [
  "post_activity",
  "ask_permission",
  "get_attachment",
  "ship",
];

/** The name a session's permission rules use for an agent or Linear tool. */
export function omniralphToolName(name: AgentTool | LinearTool): string {
  return `mcp__${OMNIRALPH_SERVER}__${name}`;
}

/** The directory (under the run's temp directory) `get_attachment` saves files to. */
export const ATTACHMENT_DOWNLOADS_DIR = "attachments";

export interface OmniralphServerOptions {
  /** The control panel's URL. */
  server: string;
  jobId: string;
  /** The run's session token (`run:activity`, `run:attachments`, `linear:read`); never the lifecycle token. */
  sessionToken: () => string;
  /** The Omniralph tools the agent lists (`tools.agent`). */
  tools: readonly AgentTool[];
  /** The read-only Linear tools of the run (`offeredLinearTools`), served by the control panel. */
  linearTools?: readonly LinearTool[];
  /** The run's task type: caps `tools` (`ship` is for coding runs only). */
  taskType: TaskType;
  /**
   * Commits and pushes the run's branch with the lifecycle's git access (a
   * request coding run's `prepared.ship`): `ship` is only offered with it.
   */
  ship?: (request: ShipRequest) => Promise<ShipOutcome>;
  /** The run's temp directory: `get_attachment` saves under its `attachments/`. */
  tmpDir: string;
  /** The run's signal: an open `ask_permission` is denied when it fires. */
  signal: AbortSignal;
  logger: Logger;
  fetch?: FetchFn;
  permissionTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** The `omniralph` server of a session, and the rules allowing its tools. */
export interface OmniralphServer {
  config: McpSdkServerConfigWithInstance;
  /** `mcp__omniralph__<tool>` for every tool it serves. */
  allowedTools: string[];
}

type ToolResult = Awaited<ReturnType<SdkMcpToolDefinition["handler"]>>;

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });

const failure = (what: string, error: unknown): ToolResult => ({
  content: [
    {
      type: "text",
      text: `${what} failed: ${error instanceof Error ? error.message : String(error)}`,
    },
  ],
  isError: true,
});

/**
 * The agent tools of the agent's list that the task type allows and this
 * agent serves; `ship` only when the run can ship (`canShip`: a request
 * coding run, never a story run).
 */
export function offeredAgentTools(
  tools: readonly AgentTool[],
  taskType: TaskType,
  canShip = false,
): AgentTool[] {
  const allowed = AGENT_TOOLS_BY_TASK_TYPE[taskType];
  return [...new Set(tools)].filter(
    (name) =>
      allowed.includes(name) && SERVED_AGENT_TOOLS.includes(name) && (name !== "ship" || canShip),
  );
}

/** The Linear tools of the agent's list, when the task turns on `toolSettings.linearRead`; none otherwise. */
export function offeredLinearTools(
  tools: Pick<AgentTools, "linear">,
  settings: Pick<ToolSettings, "linearRead">,
): LinearTool[] {
  return settings.linearRead ? [...new Set(tools.linear)] : [];
}

/**
 * The definitions of the offered agent tools (`offeredAgentTools`). Each
 * calls the control panel with the session token, and reports a failure
 * (HTTP error, network) as a tool error result rather than throwing.
 */
export function omniralphTools(options: OmniralphServerOptions): SdkMcpToolDefinition[] {
  const common = {
    server: options.server,
    jobId: options.jobId,
    jobToken: options.sessionToken,
    logger: options.logger,
    ...(options.fetch && { fetch: options.fetch }),
  };
  const offered = offeredAgentTools(options.tools, options.taskType, options.ship !== undefined);
  const definitions: SdkMcpToolDefinition[] = [];

  if (offered.includes("post_activity")) {
    const activities = new ActivityRelay(common);
    definitions.push(
      tool(
        "post_activity",
        "Shows progress to the person following this run: a thought (what you think or found) or an action (what you are doing, e.g. a tool name, with its parameter).",
        {
          type: z.enum(["thought", "action"]),
          body: z.string().trim().min(1).max(10_000),
          parameter: z.string().max(10_000).optional(),
        },
        async (args) => {
          try {
            await activities.send({ ...args, ephemeral: false });
            return text("posted");
          } catch (error) {
            return failure("posting the activity", error);
          }
        },
      ) as unknown as SdkMcpToolDefinition,
    );
  }

  if (offered.includes("ask_permission")) {
    const permissions = new PermissionRelay({
      ...common,
      ...(options.permissionTimeoutMs !== undefined && { timeoutMs: options.permissionTimeoutMs }),
      ...(options.pollIntervalMs !== undefined && { pollIntervalMs: options.pollIntervalMs }),
    });
    definitions.push(
      tool(
        "ask_permission",
        "Asks a person to approve something before you do it, and waits for the answer: `allowed`, `denied` or `expired` (nobody answered in time). Only `allowed` means you may go ahead.",
        {
          tool: z.string().trim().min(1).max(200),
          detail: z.string().max(500),
        },
        async (args) => {
          try {
            return text(await permissions.decide(args, options.signal));
          } catch (error) {
            return failure("asking for permission", error);
          }
        },
      ) as unknown as SdkMcpToolDefinition,
    );
  }

  if (offered.includes("get_attachment")) {
    const fetcher = controlPanelFetcher({ ...common, signal: options.signal });
    const dir = path.join(options.tmpDir, ATTACHMENT_DOWNLOADS_DIR);
    definitions.push(
      tool(
        "get_attachment",
        "Downloads one of the run's attachments (by its ID) and returns the local path of the file, to read with your file tools.",
        { attachmentId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) },
        async ({ attachmentId }) => {
          try {
            const result = await fetcher(attachmentId);
            if (!result.ok || !result.data) {
              return failure("downloading the attachment", result.error ?? "unknown error");
            }
            await mkdir(dir, { recursive: true });
            const file = path.join(
              dir,
              attachmentFileName({}, result.contentType, `attachment-${attachmentId}`),
            );
            await writeFile(file, result.data);
            return text(file);
          } catch (error) {
            return failure("downloading the attachment", error);
          }
        },
      ) as unknown as SdkMcpToolDefinition,
    );
  }

  if (offered.includes("ship") && options.ship) {
    const shipBranch = options.ship;
    definitions.push(
      tool(
        "ship",
        "Publishes your work on the run's branch (you can't `git push` yourself: your git credentials are read-only). Commits everything left in the worktree (`git add -A`) with `message`, when there is anything, then pushes the branch to `origin`. Pass `forceWithLease: true` only after a history rewrite the request asked for (refused where history rewrites are disabled). `pullRequest` asks for a pull/merge request change (`open`, `update` or `ready`, with a title and description), made after the run. Returns `{ commitSha, pushed, error }`; when the push fails the commit is undone and your changes stay in the worktree.",
        {
          message: z
            .string()
            .trim()
            .min(1)
            .max(20_000)
            .optional()
            .describe("The commit message: a one-line subject, a blank line, then a short body"),
          pullRequest: z
            .object({
              action: z.enum(RALPH_PULL_REQUEST_ACTIONS),
              title: z.string().trim().min(1).max(500).optional(),
              body: z.string().trim().min(1).max(60_000).optional(),
            })
            .optional(),
          forceWithLease: z.boolean().optional(),
        },
        async (args) => {
          try {
            const outcome = await shipBranch({
              ...(args.message && { message: args.message }),
              ...(args.pullRequest && { pullRequest: args.pullRequest }),
              ...(args.forceWithLease && { forceWithLease: true }),
            });
            return {
              ...text(JSON.stringify(outcome, null, 2)),
              ...(outcome.error && { isError: true }),
            };
          } catch (error) {
            return failure("shipping", error);
          }
        },
      ) as unknown as SdkMcpToolDefinition,
    );
  }

  definitions.push(...linearTools(options));
  return definitions;
}

/**
 * The definitions of the run's Linear tools (`linearTools`), read through
 * `/api/agent/runs/{id}/linear/*` with the session token: the control panel
 * holds the Linear token and decides what the run may read. Results are JSON.
 */
function linearTools(options: OmniralphServerOptions): SdkMcpToolDefinition[] {
  const offered = new Set(options.linearTools ?? []);
  const base = `${options.server}/api/agent/runs/${encodeURIComponent(options.jobId)}/linear`;
  const read = async <S extends z.ZodType>(what: string, url: string, schema: S) => {
    try {
      const body = await getJson(options.fetch ?? fetch, url, schema, options.sessionToken(), {
        signal: options.signal,
      });
      return text(JSON.stringify(body, null, 2));
    } catch (error) {
      return failure(what, error);
    }
  };
  const issueId = LinearEntityId.describe("The issue's identifier (e.g. ENG-123) or ID");
  const definitions: SdkMcpToolDefinition[] = [];

  if (offered.has("linear_get_issue")) {
    definitions.push(
      tool(
        "linear_get_issue",
        "Reads a Linear issue: title, description (Markdown), state, priority, labels, team, project and parent.",
        { issueId },
        async (args) =>
          read(
            "reading the issue",
            `${base}/issues/${encodeURIComponent(args.issueId)}`,
            RunLinearIssueResponse,
          ),
      ) as unknown as SdkMcpToolDefinition,
    );
  }

  if (offered.has("linear_list_comments")) {
    definitions.push(
      tool(
        "linear_list_comments",
        `Lists the comments on a Linear issue, oldest first (the most recent ${MAX_LINEAR_COMMENTS}; \`omitted\` counts older ones).`,
        { issueId },
        async (args) =>
          read(
            "listing the comments",
            `${base}/issues/${encodeURIComponent(args.issueId)}/comments`,
            RunLinearCommentsResponse,
          ),
      ) as unknown as SdkMcpToolDefinition,
    );
  }

  if (offered.has("linear_search_issues")) {
    definitions.push(
      tool(
        "linear_search_issues",
        "Searches the Linear workspace's issues by text (titles and descriptions), best match first.",
        {
          query: z.string().trim().min(1).max(MAX_LINEAR_SEARCH_QUERY),
          first: z
            .int()
            .min(1)
            .max(MAX_LINEAR_SEARCH_RESULTS)
            .optional()
            .describe(`How many issues to return (default ${DEFAULT_LINEAR_SEARCH_RESULTS})`),
        },
        async (args) => {
          const params = new URLSearchParams({ query: args.query });
          if (args.first !== undefined) params.set("first", String(args.first));
          return read("searching issues", `${base}/issues?${params}`, RunLinearSearchResponse);
        },
      ) as unknown as SdkMcpToolDefinition,
    );
  }

  if (offered.has("linear_get_document")) {
    definitions.push(
      tool(
        "linear_get_document",
        "Reads a Linear document (e.g. a PRD or design doc) by its ID or the slug ID at the end of its URL; its content is Markdown.",
        { documentId: LinearEntityId.describe("The document's ID or slug ID") },
        async (args) =>
          read(
            "reading the document",
            `${base}/documents/${encodeURIComponent(args.documentId)}`,
            RunLinearDocumentResponse,
          ),
      ) as unknown as SdkMcpToolDefinition,
    );
  }

  return definitions;
}

/**
 * The in-process MCP server `omniralph` serving a run's agent and Linear
 * tools (see `omniralphTools`), with the rules that allow them; null when the
 * agent gets none, so no server is attached at all.
 */
export function createOmniralphServer(options: OmniralphServerOptions): OmniralphServer | null {
  const tools = omniralphTools(options);
  if (tools.length === 0) return null;
  return {
    config: createSdkMcpServer({ name: OMNIRALPH_SERVER, tools }),
    allowedTools: tools.map((definition) =>
      omniralphToolName(definition.name as AgentTool | LinearTool),
    ),
  };
}
