import type { ChatConnection, ChatThread, Database } from "@omniralph/db";
import { tool, type ToolSet } from "ai";
import type { Thread } from "chat";
import type { z } from "zod";
import type { QuotedMessage } from "@/lib/ralph/chat-start";
import type { RalphDeps } from "@/lib/ralph/run";
import type { ThreadAttachment } from "../attachments";
import type { ChatActor } from "../identity";
import type { TaskLookup } from "../tasks";

/**
 * The control-panel agent's tools. Each declares a tier:
 * - `read`: linked members, and unlinked Slack users whose email domain is one
 *   of the organization's (`domain` actors);
 * - `action`: linked members only.
 * Tools are registered in `./registry` (`chatTools`).
 */

export type ChatToolTier = "read" | "action";

/** What a tool gets from the handler. The organization is the connection's, never the model's. */
export interface ChatToolContext {
  db: Database;
  organizationId: string;
  /** The chat connection that received the message (its channel's chat tasks, `chatTasksFor`). */
  connection: Pick<ChatConnection, "id" | "organizationId">;
  actor: ChatActor;
  /** The chat user ID of the author of the message being answered. */
  requesterExternalUserId: string;
  thread: Thread;
  /** The control panel's base URL (no trailing slash), for links to its pages. */
  appUrl: string;
  /** The thread's `chat_threads` row. */
  chatThread: ChatThread;
  /** The user messages this turn answers (recorded already), oldest first. */
  turnMessages: readonly QuotedMessage[];
  /** The ralph orchestrator's dependencies for the organization (built on first use). */
  ralph(): Promise<RalphDeps>;
  /** The files attached in the thread, by the ref the prompt shows (`threadAttachments`). */
  attachments?: ReadonlyMap<string, ThreadAttachment>;
  /** Looks up the tasks chat runs (default: the organization's, `organizationDefinitions`). */
  getTask?: TaskLookup;
  /**
   * A tool posted its own message (e.g. a card) in the thread: an empty final
   * answer then posts nothing.
   */
  handedOff(): void;
}

export interface ChatTool<S extends z.ZodType = z.ZodType> {
  tier: ChatToolTier;
  description: string;
  inputSchema: S;
  execute(input: z.infer<S>, context: ChatToolContext): Promise<unknown>;
}

export type ChatToolRegistry = Readonly<Record<string, ChatTool>>;

export function defineChatTool<S extends z.ZodType>(definition: ChatTool<S>): ChatTool<S> {
  return definition;
}

/** Whether `actor` may use a tool of `tier`. */
export function tierAllowed(tier: ChatToolTier, actor: ChatActor): boolean {
  if (actor.kind === "member") return true;
  return actor.kind === "domain" && tier === "read";
}

/** The result of a tool the actor may not use. */
export const LINK_REQUIRED_RESULT = {
  error: "link_required",
  message:
    "The user must link their chat account to their Omniralph account before you can do this. Ask them to use the link that is being sent to them, then to try again.",
} as const;

/**
 * The registry as AI SDK tools bound to `context`. An `unlinked` actor gets
 * none; a tool above the actor's tier answers {@link LINK_REQUIRED_RESULT} and
 * calls `onRefused`.
 */
export function toAiTools(
  registry: ChatToolRegistry,
  context: ChatToolContext,
  onRefused: (name: string) => void,
): ToolSet {
  if (context.actor.kind === "unlinked") return {};
  const tools: ToolSet = {};
  for (const [name, definition] of Object.entries(registry)) {
    tools[name] = tool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: async (input: unknown) => {
        if (!tierAllowed(definition.tier, context.actor)) {
          onRefused(name);
          return LINK_REQUIRED_RESULT;
        }
        return definition.execute(input, context);
      },
    });
  }
  return tools;
}
