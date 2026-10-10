/**
 * Where a ralph run talks to people: every write to a run's session (its
 * activities, plan and PR/MR links) goes through a `RunConversation`, so a run
 * from Linear posts to its agent session and a run from chat to its thread.
 * `conversationFor` picks the run's channel.
 */
import type { SlackAdapter } from "@chat-adapter/slack";
import {
  appendChatMessage,
  getChatThreadWithConnection,
  getRepositoryWithConnection,
  linearSessionOf,
  type ChatPlatform,
  type ChatThread,
  type Database,
  type RalphRun,
} from "@omniralph/db";
import type { Adapter, StateAdapter } from "chat";
import type {
  ActivityContent,
  ActivityOptions,
  LinearGateway,
  PlanStep,
} from "@/lib/linear/gateway";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { inlineCode, MAX_BODY_CHARS, sanitizeCapped } from "@/lib/review/sanitize";
import { errorMessage } from "./notify";

export interface RunConversation {
  /** Names the conversation in logs (e.g. `Linear session <id>`). */
  readonly name: string;
  /** Posts an activity (a thought, action, response, elicitation or error). Throws on failure. */
  post(content: ActivityContent, options?: ActivityOptions): Promise<void>;
  /** Replaces the plan shown with the run's stories. Throws on failure. */
  updatePlan(plan: PlanStep[]): Promise<void>;
  /** Links the conversation to a URL (a PR/MR). Throws on failure. */
  addLink(label: string, url: string): Promise<void>;
}

/** A Linear gateway, or a way to get one only when a write needs it. */
export type LinearSource = LinearGateway | (() => Promise<LinearGateway>);

export interface ConversationDeps {
  linear: LinearSource;
  /** Where a chat run's thread is posted through (default: the deployment's chat bot). */
  chat?: ChatSource;
}

/** A run's Linear agent session. */
export class LinearConversation implements RunConversation {
  readonly name: string;

  constructor(
    private readonly linear: LinearSource,
    readonly sessionId: string,
  ) {
    this.name = `Linear session ${sessionId}`;
  }

  private async client(): Promise<LinearGateway> {
    return typeof this.linear === "function" ? this.linear() : this.linear;
  }

  async post(content: ActivityContent, options?: ActivityOptions): Promise<void> {
    await (await this.client()).createActivity(this.sessionId, content, options);
  }

  async updatePlan(plan: PlanStep[]): Promise<void> {
    await (await this.client()).updateSessionPlan(this.sessionId, plan);
  }

  async addLink(label: string, url: string): Promise<void> {
    await (await this.client()).addSessionExternalUrl(this.sessionId, label, url);
  }
}

/** What a chat run's thread is posted through: the chat bot's adapters, outside any webhook. */
export interface ChatChannel {
  db: Database;
  /** The bot's adapter of each configured platform. */
  adapters: Partial<Record<ChatPlatform, Adapter>>;
  /** Remembers each run's status message between posts (the Chat SDK state). */
  state: StateAdapter;
  /** The control panel's URL: its links stay clickable. */
  appUrl: string;
  /** `ENCRYPTION_KEY` override for Slack credentials (tests). */
  encryptionKey?: string | Buffer;
}

/** A chat channel, or a way to get one only when a write needs it. */
export type ChatSource = ChatChannel | (() => Promise<ChatChannel>);

/** The deployment's chat bot (`getChatBot`), loaded on first use. */
async function defaultChatChannel(): Promise<ChatChannel> {
  const [{ getChatBot }, { getDb }, { getAppUrl }] = await Promise.all([
    import("@/lib/chat/bot"),
    import("@/lib/db"),
    import("@/lib/app-url"),
  ]);
  const bot = getChatBot();
  await bot.chat.initialize();
  return { db: getDb(), adapters: bot.adapters, state: bot.state, appUrl: getAppUrl() };
}

/** The run fields a chat conversation needs. */
export type ChatRunRef = Pick<
  RalphRun,
  "id" | "organizationId" | "chatThreadId" | "repositoryId" | "requestJobId"
>;

/** A run's status message in its thread, and the links already posted. */
interface ChatRunState {
  status?: {
    /** The request job it shows (null: before the run's first one). */
    jobId: string | null;
    messageId: string;
    /** The plan step in progress. */
    step?: string;
    /** The last thought or action. */
    last?: string;
  };
  links?: string[];
}

interface ChatTarget {
  channel: ChatChannel;
  thread: ChatThread;
  adapter: Adapter;
  /** Runs a platform call with the connection's bot token (Slack). */
  send<T>(fn: () => Promise<T>): Promise<T>;
  allowedHosts: string[];
}

/** How long a run's status message is remembered after its last update. */
const CHAT_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STATUS_LOCK_TTL_MS = 10_000;
const STATUS_LOCK_ATTEMPTS = 50;
const STATUS_LOCK_WAIT_MS = 100;
/** How much of a thought or action the status message shows. */
const MAX_STATUS_CHARS = 300;

const STATUS_HEADER = "⏳ Working on it";

function truncate(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The status line of a thought or action. */
function statusLine(content: ActivityContent): string {
  if (content.type === "action") {
    const parameter = content.parameter.trim();
    return parameter
      ? `${content.action} ${inlineCode(truncate(parameter, MAX_STATUS_CHARS))}`
      : content.action;
  }
  return "body" in content ? truncate(content.body.split("\n")[0] ?? "", MAX_STATUS_CHARS) : "";
}

/** The plan step in progress (else the next one), numbered. */
export function currentPlanStep(plan: PlanStep[]): string | undefined {
  const inProgress = plan.findIndex((s) => s.status === "inProgress");
  const index = inProgress >= 0 ? inProgress : plan.findIndex((s) => s.status === "pending");
  if (index < 0) return plan.length > 0 ? "All steps done" : undefined;
  return `Step ${index + 1}/${plan.length}: ${plan[index]!.content}`;
}

/** The text of a run's status message. */
export function statusText(status: { step?: string; last?: string }): string {
  return [status.step ? `${STATUS_HEADER} · ${status.step}` : STATUS_HEADER, status.last]
    .filter(Boolean)
    .join("\n");
}

/** The text of a message an activity posts (a response, error or elicitation). */
function messageText(content: ActivityContent): string {
  if (content.type === "error") return `⚠️ ${content.body}`;
  return "body" in content ? content.body : statusLine(content);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A chat run's thread, posted to proactively through the Chat SDK (session
 * updates arrive long after the webhook that started the run). Chat isn't a
 * Linear session: thoughts, actions and plan updates edit one status message
 * per request job, while responses, errors, elicitations and links are new
 * messages, sanitized and recorded in the thread's history as the run's.
 * When the thread or its connection is gone, writes are skipped (logged).
 */
export class ChatConversation implements RunConversation {
  readonly name: string;
  private target?: Promise<ChatTarget | null>;

  constructor(
    readonly run: ChatRunRef,
    private readonly source: ChatSource = defaultChatChannel,
  ) {
    this.name = `chat thread ${run.chatThreadId ?? "(gone)"}`;
  }

  private stateKey(): string {
    return `ralph-chat:${this.run.id}`;
  }

  private skip(what: string, reason: string): null {
    console.warn(`Skipping ${what} of ralph run ${this.run.id} to ${this.name}: ${reason}`);
    return null;
  }

  /** The thread to post to, or null (logged) when it or its connection is gone. */
  private resolve(what: string): Promise<ChatTarget | null> {
    this.target ??= this.load();
    return this.target.then((target) =>
      target ? target : this.skip(what, "the thread or its chat connection is gone"),
    );
  }

  private async load(): Promise<ChatTarget | null> {
    if (!this.run.chatThreadId) return null;
    const channel = typeof this.source === "function" ? await this.source() : this.source;
    const found = await getChatThreadWithConnection<{ botToken?: string }>(
      channel.db,
      this.run.chatThreadId,
      channel.encryptionKey,
    );
    if (!found) return null;
    const { thread, connection } = found;
    const adapter = channel.adapters[thread.platform];
    if (!adapter) return null;
    const allowedHosts = [new URL(channel.appUrl).hostname];
    if (this.run.repositoryId) {
      const repo = await getRepositoryWithConnection(
        channel.db,
        this.run.repositoryId,
        this.run.organizationId,
      );
      if (repo) {
        const { repository, connection: scm } = repo;
        allowedHosts.push(
          new URL(repositoryWebUrl(repository.provider, scm.baseUrl, repository.fullPath)).hostname,
        );
      }
    }
    const botToken = connection.credentials?.botToken;
    // Outside a webhook, the Slack adapter only knows a workspace's token when handed it.
    const slack = adapter as Partial<Pick<SlackAdapter, "withBotToken">>;
    const send = <T>(fn: () => Promise<T>): Promise<T> =>
      botToken && slack.withBotToken
        ? slack.withBotToken(botToken, fn, { installationId: connection.externalId })
        : fn();
    return { channel, thread, adapter, send, allowedHosts };
  }

  private sanitize(target: ChatTarget, text: string): string {
    return sanitizeCapped(text, { allowedHosts: target.allowedHosts }, MAX_BODY_CHARS);
  }

  /** Posts a new message and records it in the thread's history as the run's. */
  private async postMessage(target: ChatTarget, text: string): Promise<void> {
    const markdown = this.sanitize(target, text);
    await target.send(() =>
      target.adapter.postMessage(target.thread.externalThreadId, { markdown }),
    );
    await appendChatMessage(target.channel.db, {
      threadId: target.thread.id,
      role: "assistant",
      content: markdown,
      ralphRunId: this.run.id,
    });
  }

  /** Runs `fn` holding the run's chat state lock (posts of one run race: relays, outcomes). */
  private async locked<T>(target: ChatTarget, fn: () => Promise<T>): Promise<T> {
    const { state } = target.channel;
    const key = this.stateKey();
    for (let attempt = 1; ; attempt += 1) {
      const lock = await state.acquireLock(key, STATUS_LOCK_TTL_MS);
      if (lock) {
        try {
          return await fn();
        } finally {
          await state.releaseLock(lock);
        }
      }
      // A stuck lock expires; past that, go ahead rather than drop the update.
      if (attempt >= STATUS_LOCK_ATTEMPTS) return fn();
      await sleep(STATUS_LOCK_WAIT_MS);
    }
  }

  /** Edits the request job's status message (posted on its first update). */
  private async updateStatus(
    what: string,
    change: { step?: string; last?: string },
  ): Promise<void> {
    const target = await this.resolve(what);
    if (!target) return;
    await this.locked(target, async () => {
      const { state } = target.channel;
      const saved = (await state.get<ChatRunState>(this.stateKey())) ?? {};
      const jobId = this.run.requestJobId ?? saved.status?.jobId ?? null;
      const current = saved.status?.jobId === jobId ? saved.status : undefined;
      const next = {
        step: change.step ?? current?.step,
        last: change.last ?? current?.last,
      };
      const markdown = this.sanitize(target, statusText(next));
      const threadId = target.thread.externalThreadId;
      let messageId = current?.messageId;
      if (messageId) {
        const id = messageId;
        const edited = await target
          .send(() => target.adapter.editMessage(threadId, id, { markdown }))
          .then(
            () => true,
            (error: unknown) => {
              console.warn(
                `Editing the status message of ralph run ${this.run.id} failed, posting a new one: ${errorMessage(error)}`,
              );
              return false;
            },
          );
        if (!edited) messageId = undefined;
      }
      if (!messageId) {
        const posted = await target.send(() => target.adapter.postMessage(threadId, { markdown }));
        messageId = posted.id;
      }
      await state.set<ChatRunState>(
        this.stateKey(),
        { ...saved, status: { jobId, messageId, ...next } },
        CHAT_STATE_TTL_MS,
      );
    });
  }

  async post(content: ActivityContent): Promise<void> {
    if (content.type === "thought" || content.type === "action") {
      const last = statusLine(content);
      await this.updateStatus(`a ${content.type}`, last ? { last } : {});
      return;
    }
    const target = await this.resolve(`a ${content.type}`);
    if (target) await this.postMessage(target, messageText(content));
  }

  async updatePlan(plan: PlanStep[]): Promise<void> {
    await this.updateStatus("the plan", { step: currentPlanStep(plan) });
  }

  async addLink(label: string, url: string): Promise<void> {
    const target = await this.resolve("a link");
    if (!target) return;
    await this.locked(target, async () => {
      const { state } = target.channel;
      const saved = (await state.get<ChatRunState>(this.stateKey())) ?? {};
      if (saved.links?.includes(url)) return;
      await this.postMessage(target, `${label}: ${url}`);
      await state.set<ChatRunState>(
        this.stateKey(),
        { ...saved, links: [...(saved.links ?? []), url] },
        CHAT_STATE_TTL_MS,
      );
    });
  }
}

/** The Linear agent session of a Linear session ID (e.g. a new session before its run exists). */
export function linearConversation(linear: LinearSource, sessionId: string): LinearConversation {
  return new LinearConversation(linear, sessionId);
}

/** The conversation a run posts to: its Linear agent session, or its chat thread. */
export function conversationFor(
  run: Pick<
    RalphRun,
    | "id"
    | "organizationId"
    | "origin"
    | "linearIssueId"
    | "linearIdentifier"
    | "linearAgentSessionId"
    | "chatThreadId"
    | "repositoryId"
    | "requestJobId"
  >,
  deps: ConversationDeps,
): RunConversation {
  const sessionId = linearSessionOf(run);
  if (sessionId !== null) return new LinearConversation(deps.linear, sessionId);
  return new ChatConversation(run, deps.chat);
}
