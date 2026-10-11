import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createSdkMcpServer,
  tool,
  type McpSdkServerConfigWithInstance,
  type SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import { attachmentFileName } from "@omniralph/ralph";
import { HARNESS_TOOLS_BY_TASK_TYPE, type HarnessTool, type TaskType } from "@omniralph/tasks";
import { z } from "zod";
import type { FetchFn } from "../api.js";
import type { Logger } from "../logger.js";
import { ActivityRelay } from "./activities.js";
import { controlPanelFetcher } from "./attachments.js";
import { PermissionRelay } from "./permissions.js";

/** The name of the in-process MCP server serving the harness tools. */
export const OMNIRALPH_SERVER = "omniralph";

/** The harness tools this harness serves (`ship` comes with coding runs). */
export const SERVED_HARNESS_TOOLS: readonly HarnessTool[] = [
  "post_activity",
  "ask_permission",
  "get_attachment",
];

/** The name a session's permission rules use for a harness tool. */
export function harnessToolName(name: HarnessTool): string {
  return `mcp__${OMNIRALPH_SERVER}__${name}`;
}

/** The directory (under the run's temp directory) `get_attachment` saves files to. */
export const ATTACHMENT_DOWNLOADS_DIR = "attachments";

export interface OmniralphServerOptions {
  /** The control panel's URL. */
  server: string;
  jobId: string;
  /** The run's session token (`run:activity`, `run:attachments`); never the lifecycle token. */
  sessionToken: () => string;
  /** The harness tools the agent lists (`tools.harness`). */
  tools: readonly HarnessTool[];
  /** The run's task type: caps `tools` (`ship` is for coding runs only). */
  taskType: TaskType;
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

/** The harness tools of the agent's list that the task type allows and this harness serves. */
export function offeredHarnessTools(
  tools: readonly HarnessTool[],
  taskType: TaskType,
): HarnessTool[] {
  const allowed = HARNESS_TOOLS_BY_TASK_TYPE[taskType];
  return [...new Set(tools)].filter(
    (name) => allowed.includes(name) && SERVED_HARNESS_TOOLS.includes(name),
  );
}

/**
 * The definitions of the offered harness tools (`offeredHarnessTools`). Each
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
  const offered = offeredHarnessTools(options.tools, options.taskType);
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

  return definitions;
}

/**
 * The in-process MCP server `omniralph` serving a run's harness tools (see
 * `omniralphTools`), with the rules that allow them; null when the agent
 * gets none, so no server is attached at all.
 */
export function createOmniralphServer(options: OmniralphServerOptions): OmniralphServer | null {
  const tools = omniralphTools(options);
  if (tools.length === 0) return null;
  return {
    config: createSdkMcpServer({ name: OMNIRALPH_SERVER, tools }),
    allowedTools: tools.map((definition) => harnessToolName(definition.name as HarnessTool)),
  };
}
