import "server-only";
import {
  appendChatMessage,
  getOrganization,
  getRunByChatThread,
  listChatMessages,
  type ChatMessageRole,
  type Database,
} from "@omniralph/db";
import { generateText, stepCountIs, type LanguageModel, type ModelMessage } from "ai";
import { ConsoleLogger, type Logger, type Message } from "chat";
import { getAppUrl } from "@/lib/app-url";
import { CHAT_AGENT_RATE_LIMITS, hitRateLimit, type RateLimit } from "@/lib/rate-limit";
import { chatRunAskingCleanup, chatRunSession, sendToChatRun } from "@/lib/ralph/chat-reply";
import { answerCleanup } from "@/lib/ralph/cleanup";
import type { RalphDeps } from "@/lib/ralph/run";
import { MAX_BODY_CHARS, sanitizeCapped } from "@/lib/review/sanitize";
import { requireMember, type ChatConversationHandler } from "../bot";
import { CHAT_AGENT_HISTORY_LIMIT, CHAT_AGENT_MAX_STEPS } from "./config";
import { historyMessages, systemPrompt } from "./prompt";
import { chatTools } from "./registry";
import { toAiTools, type ChatToolRegistry } from "./tools";

/**
 * The control-panel agent: answers each message of a thread the bot is part
 * of with a model from the AI Gateway, using the tools the author's access
 * level allows.
 */

export const NOT_CONFIGURED_REPLY =
  "The Omniralph assistant isn't configured on this deployment yet, so I can't answer here. Ask your Omniralph admin to set it up.";
export const RATE_LIMITED_REPLY =
  "I'm getting a lot of questions right now, so I'm taking a short break. Please ask again in a few minutes.";
export const ERROR_REPLY =
  "Sorry, something went wrong while I was working on that. Please try again.";
export const EMPTY_REPLY = "Sorry, I don't have an answer to that.";

export interface ChatAgentDeps {
  db: Database;
  /** Null when the agent isn't configured (`chatAgentConfig()`): the bot says so once per thread. */
  model: LanguageModel | null;
  tools?: ChatToolRegistry;
  maxSteps?: number;
  logger?: Logger;
  /** `APP_URL` (tests). */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** The ralph orchestrator's dependencies for an organization (default: `defaultDeps`). */
  ralph?: (organizationId: string) => Promise<RalphDeps>;
  rateLimits?: {
    perOrganization: (organizationId: string) => RateLimit;
    perChatUser: (organizationId: string, platform: string, externalUserId: string) => RateLimit;
  };
}

interface AgentThreadState {
  /** Set once the thread was told the agent isn't configured. */
  notConfiguredNoticeSent?: boolean;
}

/** The deployment's ralph dependencies for an organization (loaded on first use). */
async function defaultRalphDeps(db: Database, organizationId: string): Promise<RalphDeps> {
  const { defaultDeps } = await import("@/lib/ralph/jobs");
  return defaultDeps(db, organizationId);
}

/** How a message passed to the running session is acknowledged (no extra message). */
export const SESSION_REACTION = "eyes";

/** A chat message's author as the session sees it. */
const authorName = (m: Message) =>
  m.author.fullName || m.author.userName || m.author.userId || null;

/** The parts of a model message other than text. */
function withoutText(message: ModelMessage): Array<{ type: string }> {
  if (typeof message.content === "string") return [];
  return (message.content as Array<{ type: string }>).filter((p) => p.type !== "text");
}

/** The text parts of a model message replaced by `text` (what was actually posted). */
function withPostedText(message: ModelMessage, text: string): ModelMessage["content"] {
  if (typeof message.content === "string") return text;
  return [...withoutText(message), { type: "text", text }] as ModelMessage["content"];
}

export function createChatAgentHandler(deps: ChatAgentDeps): ChatConversationHandler {
  const { db } = deps;
  const logger = deps.logger ?? new ConsoleLogger("info", "chat-agent");
  const rateLimits = deps.rateLimits ?? CHAT_AGENT_RATE_LIMITS;
  const registry = deps.tools ?? chatTools;
  const now = () => deps.now?.() ?? new Date();
  const ralphDeps = (organizationId: string) =>
    (deps.ralph ?? ((id) => defaultRalphDeps(db, id)))(organizationId);

  return {
    async handle(thread, message, context) {
      const { organizationId, connection, chatThread, actor } = context;
      const record = (role: ChatMessageRole, content: unknown) =>
        appendChatMessage(db, { threadId: chatThread.id, role, content });
      const reply = async (text: string) => {
        await thread.post(text);
        await record("assistant", text);
      };

      /** Marks a message the run took (no extra message). */
      const acknowledge = () =>
        thread.adapter
          .addReaction(thread.id, message.id, SESSION_REACTION)
          .catch((error: unknown) =>
            logger.warn("Couldn't react to a message passed to the session", {
              threadId: thread.id,
              error,
            }),
          );

      // While the thread's session works, a plain reply is for it; a mention is for the agent.
      if (!message.isMention && (await chatRunSession(db, chatThread.id))) {
        if (actor.kind !== "member") {
          await requireMember(context);
          return;
        }
        try {
          const ralph = await ralphDeps(organizationId);
          let passed = false;
          for (const m of [...context.skipped.filter((s) => !s.isMention), message]) {
            const outcome = await sendToChatRun(ralph, {
              chatThreadId: chatThread.id,
              text: m.text,
              author: authorName(m),
            });
            if (outcome.status !== "no_run") passed = true;
          }
          if (passed) {
            await acknowledge();
            return;
          }
          // The run ended meanwhile: the agent answers instead.
        } catch (error) {
          logger.error("Passing a chat reply to the ralph session failed", {
            organizationId,
            threadId: thread.id,
            error,
          });
          await reply(ERROR_REPLY).catch(() => undefined);
          return;
        }
      }

      // After the run's PR/MR merged, a member's plain reply may answer its cleanup question.
      if (!message.isMention && actor.kind === "member") {
        const asking = await chatRunAskingCleanup(db, chatThread.id);
        if (asking) {
          try {
            const answer = await answerCleanup(
              await ralphDeps(organizationId),
              asking.id,
              message.text,
            );
            if (answer) {
              await acknowledge();
              return;
            }
          } catch (error) {
            logger.error("Answering a ralph cleanup question from chat failed", {
              organizationId,
              threadId: thread.id,
              error,
            });
            await reply(ERROR_REPLY).catch(() => undefined);
            return;
          }
        }
      }

      if (!deps.model) {
        const state = (await thread.state) as AgentThreadState | null;
        if (state?.notConfiguredNoticeSent) return;
        await reply(NOT_CONFIGURED_REPLY);
        await thread.setState({ notConfiguredNoticeSent: true } satisfies AgentThreadState);
        return;
      }

      const rules = [
        rateLimits.perChatUser(organizationId, connection.platform, message.author.userId),
        rateLimits.perOrganization(organizationId),
      ];
      const hits = [];
      for (const rule of rules) hits.push({ rule, ...(await hitRateLimit(db, rule, now())) });
      if (hits.some((h) => h.limited)) {
        // Say so once, on the hit that crosses a limit; stay quiet after that.
        if (hits.some((h) => h.count === h.rule.limit + 1)) await reply(RATE_LIMITED_REPLY);
        logger.info("Chat agent turn rate-limited", { organizationId, threadId: thread.id });
        return;
      }

      await thread.startTyping().catch(() => undefined);

      let linkNeeded = actor.kind === "unlinked";
      let handedOff = false;
      try {
        const appUrl = getAppUrl(deps.env);
        const organization = await getOrganization(db, organizationId);
        const history = await listChatMessages(db, chatThread.id, CHAT_AGENT_HISTORY_LIMIT);
        const turnMessages = [...context.skipped, message].map((m) => ({
          author: authorName(m),
          text: m.text,
        }));
        const threadRun = await getRunByChatThread(db, chatThread.id);
        const tools = toAiTools(
          registry,
          {
            db,
            organizationId,
            actor,
            thread,
            appUrl,
            chatThread,
            turnMessages,
            ralph: () => ralphDeps(organizationId),
            handedOff: () => {
              handedOff = true;
            },
          },
          () => {
            linkNeeded = true;
          },
        );
        const result = await generateText({
          model: deps.model,
          system: systemPrompt({
            organizationName: organization?.name ?? "your organization",
            platform: connection.platform,
            userName: message.author.fullName || message.author.userName || message.author.userId,
            actor,
            appUrl,
            now: now(),
            threadRun: threadRun && {
              id: threadRun.id,
              status: threadRun.status,
              working: !!(await chatRunSession(db, chatThread.id)),
            },
          }),
          messages: historyMessages(history, { includeTools: Object.keys(tools).length > 0 }),
          tools,
          stopWhen: stepCountIs(deps.maxSteps ?? CHAT_AGENT_MAX_STEPS),
          maxRetries: 1,
        });

        // After a handoff (announced in the thread already), an empty answer posts nothing.
        const quiet = handedOff && !result.text.trim();
        const text = quiet
          ? ""
          : sanitizeCapped(
              result.text.trim() || EMPTY_REPLY,
              { allowedHosts: [new URL(appUrl).host] },
              MAX_BODY_CHARS,
            );
        if (!quiet) await thread.post({ markdown: text });
        const responses = result.response.messages;
        const last = responses.at(-1);
        for (const m of responses) {
          if (quiet && m === last && m.role === "assistant") {
            // Its empty text isn't kept: models reject empty assistant messages.
            const parts = withoutText(m);
            if (parts.length > 0) await record("assistant", parts);
            continue;
          }
          const content =
            m === last && m.role === "assistant" ? withPostedText(m, text) : m.content;
          await record(m.role === "tool" ? "tool" : "assistant", content);
        }
        if (last?.role !== "assistant" && !quiet) await record("assistant", text);
      } catch (error) {
        logger.error("Chat agent turn failed", { organizationId, threadId: thread.id, error });
        await reply(ERROR_REPLY).catch((postError: unknown) =>
          logger.error("Couldn't post the chat agent apology", { threadId: thread.id, postError }),
        );
      }

      // Also after an error: a user who needs a link should still get it.
      if (linkNeeded) await requireMember(context);
    },
  };
}
