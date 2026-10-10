/**
 * Where a ralph run talks to people: every write to a run's session (its
 * activities, plan and PR/MR links) goes through a `RunConversation`, so a run
 * from Linear posts to its agent session and a run from chat to its thread.
 * `conversationFor` picks the run's channel.
 */
import { linearSessionOf, type RalphRun } from "@omniralph/db";
import type {
  ActivityContent,
  ActivityOptions,
  LinearGateway,
  PlanStep,
} from "@/lib/linear/gateway";

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

/**
 * A run's chat thread. Posting to the thread isn't wired up yet, so a chat
 * run's session writes are dropped, as they were before runs had a channel.
 */
export class ChatConversation implements RunConversation {
  readonly name: string;

  constructor(readonly chatThreadId: string | null) {
    this.name = `chat thread ${chatThreadId ?? "(gone)"}`;
  }

  async post(): Promise<void> {}

  async updatePlan(): Promise<void> {}

  async addLink(): Promise<void> {}
}

/** The Linear agent session of a Linear session ID (e.g. a new session before its run exists). */
export function linearConversation(linear: LinearSource, sessionId: string): LinearConversation {
  return new LinearConversation(linear, sessionId);
}

/** The conversation a run posts to: its Linear agent session, or its chat thread. */
export function conversationFor(
  run: Pick<
    RalphRun,
    "origin" | "linearIssueId" | "linearIdentifier" | "linearAgentSessionId" | "chatThreadId"
  >,
  deps: ConversationDeps,
): RunConversation {
  const sessionId = linearSessionOf(run);
  if (sessionId !== null) return new LinearConversation(deps.linear, sessionId);
  return new ChatConversation(run.chatThreadId);
}
