/**
 * Where a ralph run talks to people: every write to a run's session (its
 * activities, plan and PR/MR links) goes through a `RunConversation`, so a run
 * from a tracker posts to its agent session (or, on a tracker without
 * sessions, comments on its work item) and a run from chat records run events
 * of its thread.
 * `conversationFor` picks the run's channel.
 */
import { randomUUID } from "node:crypto";
import type { SlackAdapter } from "@chat-adapter/slack";
import {
  getChatThreadWithConnection,
  getRepositoryWithConnection,
  isLinearRun,
  type ChatPlatform,
  type ChatThread,
  type Database,
  type RalphRun,
} from "@omniralph/db";
import type { Adapter, StateAdapter } from "chat";
import {
  hasCapability,
  type ActivityContent,
  type ActivityOptions,
  type PlanStep,
  type TrackerGateway,
} from "@omniralph/tracker";
import { recordChatRunEvent, type ChatRunEventKind } from "@/lib/chat/run-events";
import { repositoryWebUrl } from "@/lib/repositories/web-url";
import { inlineCode } from "@/lib/review/sanitize";

/** How an activity is posted. */
export interface PostOptions extends ActivityOptions {
  /**
   * News from outside the session's steps (a PR/MR follow-up: a review, CI
   * failure, `@bot fix` or cleanup): a tracker posts it as usual, while chat
   * posts even a thought as a new message, since the status message it would
   * edit may be far up the thread.
   */
  notice?: boolean;
  /**
   * The run event a chat run records for it (`lib/chat/run-events.ts`): its
   * kind (default: by the activity's type), its key within the run, so it is
   * recorded once (default: a new one), and structured details for the
   * responder. A tracker ignores it.
   */
  event?: { kind?: ChatRunEventKind; key?: string; details?: Record<string, unknown> };
}

export interface RunConversation {
  /** Names the conversation in logs (e.g. `tracker session <id>`). */
  readonly name: string;
  /** Posts an activity (a thought, action, response, elicitation or error). Throws on failure. */
  post(content: ActivityContent, options?: PostOptions): Promise<void>;
  /** Replaces the plan shown with the run's stories. Throws on failure. */
  updatePlan(plan: PlanStep[]): Promise<void>;
  /** Links the conversation to a URL (a PR/MR). Throws on failure. */
  addLink(label: string, url: string): Promise<void>;
}

/**
 * The key of a run's end within the run: its final status, and the run's
 * last update before it (a finished chat run resumed by a follow-up, like a
 * CI fix, ends again).
 */
function endKey(status: "completed" | "failed", run: Pick<RalphRun, "updatedAt">): string {
  return `${status}:${run.updatedAt.toISOString()}`;
}

/** A chat run's final response: its `completion` event (`run` as it was before it completed). */
export function runCompletedEvent(run: Pick<RalphRun, "updatedAt">): PostOptions["event"] {
  return { kind: "completion", key: endKey("completed", run), details: { status: "completed" } };
}

/** A chat run's last error: its `failure` event (`run` as it was before it failed). */
export function runFailedEvent(run: Pick<RalphRun, "updatedAt">): PostOptions["event"] {
  return { kind: "failure", key: endKey("failed", run), details: { status: "failed" } };
}

/** A tracker gateway, or a way to get one only when a write needs it. */
export type TrackerSource = TrackerGateway | (() => Promise<TrackerGateway>);

export interface ConversationDeps {
  linear: TrackerSource;
  /** Where a chat run's thread is posted through (default: the deployment's chat bot). */
  chat?: ChatSource;
}

/** The heading of a plan posted as a work item comment. */
export const PLAN_COMMENT_HEADING = "**Plan**";

const PLAN_MARKS: Record<PlanStep["status"], string> = {
  pending: "- [ ]",
  inProgress: "- [ ] ⏳",
  completed: "- [x]",
  canceled: "- [x] ~~",
};

/** A plan as a work item comment: a checklist of its steps. */
export function planComment(plan: readonly PlanStep[]): string {
  const steps = plan.map((step) =>
    step.status === "canceled"
      ? `${PLAN_MARKS.canceled}${step.content}~~`
      : `${PLAN_MARKS[step.status]} ${step.content}`,
  );
  return [PLAN_COMMENT_HEADING, "", ...(steps.length > 0 ? steps : ["_No steps._"])].join("\n");
}

/** An activity as a work item comment (an elicitation lists the options it offers). */
export function activityComment(content: ActivityContent, options?: ActivityOptions): string {
  const text = messageText(content);
  const choices = options?.signal === "select" ? selectOptions(options.signalMetadata) : [];
  if (choices.length === 0) return text;
  return [text, "", "Reply with one of:", ...choices.map((c) => `- ${inlineCode(c)}`)].join("\n");
}

/** The values a `select` elicitation offers (`signalMetadata: { options: [{ value }] }`). */
function selectOptions(metadata: Record<string, unknown> | undefined): string[] {
  const options = metadata?.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option: unknown) => {
    const value = (option as { value?: unknown } | null)?.value;
    return typeof value === "string" && value.trim() ? [value] : [];
  });
}

/**
 * A run's conversation in its tracker: its agent session when the tracker
 * has the sessions capability. On a tracker without it, activities and plans
 * become comments on the work item (`issueId`; ephemeral activities and an
 * unchanged plan are skipped) and links are linked to it.
 */
export class TrackerConversation implements RunConversation {
  readonly name: string;

  constructor(
    private readonly tracker: TrackerSource,
    readonly sessionId: string,
    readonly issueId?: string,
  ) {
    this.name = `tracker session ${sessionId}`;
  }

  private async client(): Promise<TrackerGateway> {
    return typeof this.tracker === "function" ? this.tracker() : this.tracker;
  }

  /** The work item comments go to, on a tracker without sessions. */
  private commentTarget(tracker: TrackerGateway): string {
    if (this.issueId) return this.issueId;
    throw new Error(
      `The ${tracker.provider} tracker has no sessions, and ${this.name} has no work item to comment on`,
    );
  }

  async post(content: ActivityContent, options?: PostOptions): Promise<void> {
    // A notice is an ordinary activity in a tracker.
    const { notice: _notice, event: _event, ...activity } = options ?? {};
    const tracker = await this.client();
    if (hasCapability(tracker, "sessions")) {
      await tracker.sessions.createActivity(
        this.sessionId,
        content,
        Object.keys(activity).length > 0 ? activity : undefined,
      );
      return;
    }
    // The next activity would replace it in a session; a comment stays, so it's left out.
    if (activity.ephemeral) return;
    await tracker.addComment(this.commentTarget(tracker), activityComment(content, activity));
  }

  async updatePlan(plan: PlanStep[]): Promise<void> {
    const tracker = await this.client();
    if (hasCapability(tracker, "sessions")) {
      await tracker.sessions.updatePlan(this.sessionId, plan);
      return;
    }
    const issueId = this.commentTarget(tracker);
    const body = planComment(plan);
    // The plan is posted again on every update: only a changed one is worth a comment.
    const comments = await tracker.getComments(issueId);
    const lastPlan = comments.findLast((c) => c.body.startsWith(PLAN_COMMENT_HEADING));
    if (lastPlan?.body === body) return;
    await tracker.addComment(issueId, body);
  }

  async addLink(label: string, url: string): Promise<void> {
    const tracker = await this.client();
    if (hasCapability(tracker, "sessions")) {
      await tracker.sessions.addExternalUrl(this.sessionId, label, url);
      return;
    }
    await tracker.linkUrl(this.commentTarget(tracker), url, label);
  }
}

/** What a chat run's thread is posted through: the chat bot's adapters, outside any webhook. */
export interface ChatChannel {
  db: Database;
  /** The bot's adapter of each configured platform. */
  adapters: Partial<Record<ChatPlatform, Adapter>>;
  /** The Chat SDK state. */
  state: StateAdapter;
  /** The control panel's URL: its links stay clickable. */
  appUrl: string;
  /** `ENCRYPTION_KEY` override for Slack credentials (tests). */
  encryptionKey?: string | Buffer;
}

/** A chat channel, or a way to get one only when a write needs it. */
export type ChatSource = ChatChannel | (() => Promise<ChatChannel>);

/** The deployment's chat bot (`getChatBot`), loaded on first use. */
export async function defaultChatChannel(): Promise<ChatChannel> {
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
export type ChatRunRef = Pick<RalphRun, "id" | "organizationId" | "chatThreadId" | "repositoryId">;

/** A chat thread to post to proactively, through its connection's adapter. */
export interface ChatTarget {
  channel: ChatChannel;
  thread: ChatThread;
  adapter: Adapter;
  /** Runs a platform call with the connection's bot token (Slack). */
  send<T>(fn: () => Promise<T>): Promise<T>;
  /** Hosts links in posted messages may point at: the control panel's and the repository's. */
  allowedHosts: string[];
  /** The repository's browser URL, when the target has one. */
  repositoryUrl: string | null;
}

/**
 * The thread `chatThreadId` to post to outside a webhook, with the hosts its
 * links may point at (the control panel's, and `repositoryId`'s code host).
 * Null when there is no thread, or it, its connection or its platform's
 * adapter is gone.
 */
export async function loadChatTarget(
  source: ChatSource,
  ref: { chatThreadId: string | null; organizationId: string; repositoryId: string | null },
): Promise<ChatTarget | null> {
  if (!ref.chatThreadId) return null;
  const channel = typeof source === "function" ? await source() : source;
  const found = await getChatThreadWithConnection<{ botToken?: string }>(
    channel.db,
    ref.chatThreadId,
    channel.encryptionKey,
  );
  if (!found) return null;
  const { thread, connection } = found;
  const adapter = channel.adapters[thread.platform];
  if (!adapter) return null;
  const allowedHosts = [new URL(channel.appUrl).hostname];
  let repositoryUrl: string | null = null;
  if (ref.repositoryId) {
    const repo = await getRepositoryWithConnection(
      channel.db,
      ref.repositoryId,
      ref.organizationId,
    );
    if (repo) {
      const { repository, connection: scm } = repo;
      repositoryUrl = repositoryWebUrl(repository.provider, scm.baseUrl, repository.fullPath);
      allowedHosts.push(new URL(repositoryUrl).hostname);
    }
  }
  const botToken = connection.credentials?.botToken;
  // Outside a webhook, the Slack adapter only knows a workspace's token when handed it.
  const slack = adapter as Partial<Pick<SlackAdapter, "withBotToken">>;
  const send = <T>(fn: () => Promise<T>): Promise<T> =>
    botToken && slack.withBotToken
      ? slack.withBotToken(botToken, fn, { installationId: connection.externalId })
      : fn();
  return { channel, thread, adapter, send, allowedHosts, repositoryUrl };
}

/** How much of an action's parameter a notice shows. */
const MAX_PARAMETER_CHARS = 300;

function truncate(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The text of an activity a chat run records (a response, error, elicitation or notice). */
function messageText(content: ActivityContent): string {
  if (content.type === "error") return `⚠️ ${content.body}`;
  if (content.type === "action") {
    const parameter = content.parameter.trim();
    return parameter
      ? `${content.action} ${inlineCode(truncate(parameter, MAX_PARAMETER_CHARS))}`
      : content.action;
  }
  return "body" in content ? content.body : "";
}

/** The event an activity of a chat run is (null: thoughts and actions aren't relayed). */
function eventKind(content: ActivityContent, options?: PostOptions): ChatRunEventKind | null {
  switch (content.type) {
    case "thought":
    case "action":
      return options?.notice ? "response" : null;
    case "response":
      return "response";
    case "elicitation":
      return "question";
    case "error":
      return "failure";
  }
}

/**
 * A chat run's thread. The run doesn't post there itself: its responses,
 * notices, questions, errors and links are recorded as run events of the
 * thread (`lib/chat/run-events.ts`), sanitized, for the chat responder to
 * relay; thoughts, actions and plan updates record nothing. When the thread
 * or its connection is gone, writes are skipped (logged).
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

  private skip(what: string, reason: string): null {
    console.warn(`Skipping ${what} of ralph run ${this.run.id} to ${this.name}: ${reason}`);
    return null;
  }

  /** The run's thread, or null (logged) when it or its connection is gone. */
  private resolve(what: string): Promise<ChatTarget | null> {
    this.target ??= loadChatTarget(this.source, this.run);
    return this.target.then((target) =>
      target ? target : this.skip(what, "the thread or its chat connection is gone"),
    );
  }

  /** Records a run event in the thread (once per `key`; a new key by default). */
  private async record(
    what: string,
    kind: ChatRunEventKind,
    text: string,
    event?: PostOptions["event"],
  ): Promise<void> {
    const target = await this.resolve(what);
    if (!target) return;
    await recordChatRunEvent(target, {
      organizationId: this.run.organizationId,
      run: { ralphRunId: this.run.id },
      kind,
      body: { ...event?.details, text },
      key: event?.key ?? `${kind}:${randomUUID()}`,
    });
  }

  async post(content: ActivityContent, options?: PostOptions): Promise<void> {
    const kind = options?.event?.kind ?? eventKind(content, options);
    if (!kind) return;
    await this.record(`a ${content.type}`, kind, messageText(content), options?.event);
  }

  async updatePlan(_plan: PlanStep[]): Promise<void> {
    // The plan isn't relayed: the responder answers "what's the run doing?" from the database.
  }

  async addLink(label: string, url: string): Promise<void> {
    await this.record("a link", "response", `${label}: ${url}`, {
      key: `link:${url}`,
      details: { label, url },
    });
  }
}

/**
 * The conversation of a tracker session ID (e.g. a new session before its run
 * exists), on its work item `issueId` (where a tracker without sessions comments).
 */
export function trackerConversation(
  tracker: TrackerSource,
  sessionId: string,
  issueId?: string,
): TrackerConversation {
  return new TrackerConversation(tracker, sessionId, issueId);
}

/** The conversation a run posts to: its tracker session (or work item), or its chat thread. */
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
  >,
  deps: ConversationDeps,
): RunConversation {
  if (isLinearRun(run)) {
    return new TrackerConversation(deps.linear, run.linearAgentSessionId, run.linearIssueId);
  }
  return new ChatConversation(run, deps.chat);
}
