import type { Database } from "@omniralph/db";
import { tool, type ToolSet } from "ai";
import type { Thread } from "chat";
import type { z } from "zod";
import type { ChatActor } from "../identity";

/**
 * The control-panel agent's tools. Each declares a tier:
 * - `read`: linked members, and unlinked Slack users whose email domain is one
 *   of the organization's (`domain` actors);
 * - `action`: linked members only.
 * Later epics add tools by registering them in {@link chatTools}.
 */

export type ChatToolTier = "read" | "action";

/** What a tool gets from the handler. The organization is the connection's, never the model's. */
export interface ChatToolContext {
  db: Database;
  organizationId: string;
  actor: ChatActor;
  thread: Thread;
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

/** The registered tools (names are what the model sees). */
export const chatTools: ChatToolRegistry = {};

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
