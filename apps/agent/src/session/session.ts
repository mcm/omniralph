import { randomUUID } from "node:crypto";
import {
  query as sdkQuery,
  type CanUseTool,
  type McpServerConfig,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SessionPermissions, TokenUsage } from "@omniralph/engine";
import { UsageByModelTracker } from "@omniralph/shared";
import type { ToolPolicy } from "../capabilities/index.js";
import { withInstallableSkills, type InstallableSkills } from "../installable-skills.js";
import {
  narrowPermissions,
  sdkPermissions,
  type ToolRestrictions,
} from "../capabilities/tool-policy.js";

/** A session that sends nothing (no message at all) for this long is aborted. */
export const SESSION_IDLE_TIMEOUT_MS = 5 * 60_000;

/** If an injected message never gets answered, the session stops waiting for it after this long. */
export const INJECTION_IDLE_TIMEOUT_MS = 5 * 60_000;

/** How long a session waits for background work it reported `waiting` for. */
export const BACKGROUND_WAIT_TIMEOUT_MS = 60 * 60_000;

/** A waiting session with nothing running in the background is nudged after this long. */
export const WAIT_NUDGE_DELAY_MS = 30_000;

/** Sent to a session that reported `waiting` while nothing runs in the background. */
export const WAIT_NUDGE_TEXT =
  "Nothing is running in the background any more, so there is nothing left to wait for. Check the results of the background work you started, finish the task, and report your structured result.";

const RATE_LIMIT_TEXT = /rate[_ ]limit|usage limit|\b429\b|too many requests/i;

/** Tells a session denied a tool call that a person had to approve. */
export const PERMISSION_DENIED_TEXT =
  "A person had to approve this in Linear (the repository's Claude Code settings ask about it) and denied it or didn't answer in time. Don't retry it: carry on without it, or report what it blocks.";

/** A tool call the repository's settings `ask` about. */
export interface PermissionCall {
  tool: string;
  input: Record<string, unknown>;
  /** Claude Code's prompt or reason, when it gave one. */
  reason?: string;
}

/** Asks a person whether a call may run (false: deny it). */
export type PermissionAsker = (call: PermissionCall, signal: AbortSignal) => Promise<boolean>;

/** What a session shows while it runs (relayed to the Linear agent session). */
export type SessionEvent =
  { type: "text"; text: string } | { type: "tool"; name: string; input: unknown };

export interface SessionRequest {
  prompt: string;
  /** The session's working directory (the branch worktree). */
  cwd: string;
  policy: ToolPolicy;
  /**
   * Whether the policy's tools are available (default true); without them the
   * session gets no tools at all (e.g. a query without a checkout).
   */
  allowExploration?: boolean;
  /** Appended to Claude Code's system prompt. */
  systemAppend: string;
  /**
   * The whole system prompt, used instead of Claude Code's preset (and
   * `systemAppend`); unset keeps the preset.
   */
  systemPrompt?: string;
  /** JSON schema of the structured result (`outputFormat`); without it the result is the final text. */
  outputSchema?: Record<string, unknown>;
  /** Most turns the session may take; unset for Claude Code's default. */
  maxTurns?: number;
  /**
   * Token cap (input + output, across the session): the session stops with
   * `budget_exhausted` once its usage reaches it, or before a turn that
   * would cross it. Unset for none.
   */
  tokenBudget?: number;
  model?: string;
  /** Model used when `model` is overloaded. */
  fallbackModel?: string;
  /** The repository's `allowedTools`/`disallowedTools`: they only narrow `policy`. */
  tools?: ToolRestrictions;
  /**
   * In-process MCP servers (e.g. `omniralph`, the agent tools), attached
   * even when the policy loads no settings, with the rules allowing their
   * tools (`mcp__<server>__<tool>`, on top of the policy's).
   */
  mcpServers?: { servers: Record<string, McpServerConfig>; allowedTools: readonly string[] };
  /**
   * The run's installable skills (plugins the agent wrote), loaded even
   * when the policy loads no settings, without loading any other settings
   * (`withInstallableSkills`).
   */
  skills?: InstallableSkills;
  /** Directories outside `cwd` the session may use (e.g. the progress log's). */
  additionalDirectories?: string[];
  /** Environment of the Claude Code process. */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  idleTimeoutMs?: number;
  /** How long a finished turn waits for an injected message's turn (default `INJECTION_IDLE_TIMEOUT_MS`). */
  injectionIdleTimeoutMs?: number;
  /**
   * Whether a turn's structured result says the session ended its turn to wait
   * for background work (subagents, commands). Such a turn doesn't end the
   * session: Claude Code starts another turn when the work finishes.
   */
  isWaiting?: (structured: unknown) => boolean;
  /** How long a waiting session waits for its background work (default `BACKGROUND_WAIT_TIMEOUT_MS`). */
  backgroundWaitTimeoutMs?: number;
  /** How long a waiting session with nothing running waits before it is nudged (default `WAIT_NUDGE_DELAY_MS`). */
  waitNudgeDelayMs?: number;
  onEvent?: (event: SessionEvent) => void;
  /**
   * Called with a function that injects a message into the live session (or
   * `undefined` once the session takes no more input). It returns false when
   * it was too late.
   */
  onInjector?: (inject: MessageInjector | undefined) => void;
  /**
   * Keep the session's files on this host, so a later session can `resume`
   * it (request sessions); off by default.
   */
  persistSession?: boolean;
  /** A persisted session to continue (its conversation so far is kept). */
  resume?: string;
  /**
   * Asks a person about tool calls the repository's settings `ask` about
   * (`canUseTool`); without it, such calls are denied. The session's idle
   * timeout doesn't run while a question is open.
   */
  askPermission?: PermissionAsker;
}

/** Delivers a message into a live session; false when the session takes no more input. */
export type MessageInjector = (text: string) => boolean;

export interface SessionResult {
  /**
   * How the session ended: `completed` (a successful result; `structured` holds
   * it, unvalidated), `error`, `rate_limited`, `idle` (no message for the idle
   * timeout), `aborted` (the request's signal) or `budget_exhausted` (the
   * usage reached `tokenBudget`).
   */
  stop: "completed" | "error" | "rate_limited" | "idle" | "aborted" | "budget_exhausted";
  /** On `completed`, a waiting result (see `isWaiting`) when the session stopped waiting for it. */
  structured?: unknown;
  /** The final message, or the last streamed text when there was none. */
  output: string;
  error?: string;
  retryAfterMs?: number;
  usage: TokenUsage;
  /** The Claude session's ID, once the session reported one. */
  sessionId?: string;
}

/** Runs one Claude session and returns how it ended. */
export type SessionRunner = (request: SessionRequest) => Promise<SessionResult>;

/**
 * The events a message of the session itself (not a subagent's) shows:
 * Claude's non-blank text and its tool calls, in order.
 */
export function sessionEvents(message: SDKMessage): SessionEvent[] {
  if (message.type !== "assistant" || message.parent_tool_use_id !== null) return [];
  const events: SessionEvent[] = [];
  for (const block of message.message.content) {
    if (block.type === "text" && block.text.trim()) {
      events.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      events.push({ type: "tool", name: block.name, input: block.input });
    }
  }
  return events;
}

/**
 * Lets the agent watch a job's Claude sessions (its attempt's live tail)
 * without changing them: a session runner's `onEvent`, or for the engine's
 * review provider its SDK `query()`, also goes to the observer.
 */
export interface SessionTee {
  runner(runner: SessionRunner): SessionRunner;
  query<P>(
    query: (params: P) => AsyncIterable<SDKMessage>,
  ): (params: P) => AsyncIterable<SDKMessage>;
}

/**
 * A `SessionTee` calling `observe` with every session event, after the
 * request's own `onEvent` (the relay to the control panel). An observer that
 * throws never affects the session.
 */
export function sessionTee(observe: (event: SessionEvent) => void): SessionTee {
  const safely = (event: SessionEvent) => {
    try {
      observe(event);
    } catch {
      // Watching is best effort.
    }
  };
  return {
    runner: (runner) => (request) =>
      runner({
        ...request,
        onEvent: (event) => {
          request.onEvent?.(event);
          safely(event);
        },
      }),
    query: (query) => (params) =>
      (async function* () {
        for await (const message of query(params)) {
          for (const event of sessionEvents(message)) safely(event);
          yield message;
        }
      })(),
  };
}

function retryAfter(resetsAt: number | undefined): number | undefined {
  if (resetsAt === undefined) return undefined;
  const ms = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
  const wait = ms - Date.now();
  return wait > 0 ? wait : undefined;
}

/** Token usage of a result message (every model call of the session). */
function resultUsage(message: Extract<SDKMessage, { type: "result" }>): TokenUsage {
  return Object.values(message.modelUsage ?? {}).reduce<TokenUsage>(
    (acc, m) => ({
      inputTokens:
        acc.inputTokens + m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens,
      outputTokens: acc.outputTokens + m.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
}

/**
 * A session's permissions: the policy's, with its tools when
 * `allowExploration` (default true), narrowed by the repository's `tools`.
 */
export function sessionPermissions(
  request: Pick<
    SessionRequest,
    | "policy"
    | "cwd"
    | "allowExploration"
    | "tools"
    | "additionalDirectories"
    | "mcpServers"
    | "skills"
  >,
): SessionPermissions {
  const permissions = withInstallableSkills(sessionToolPermissions(request), request.skills);
  if (!request.mcpServers) return permissions;
  return {
    ...permissions,
    allowedTools: [...(permissions.allowedTools ?? []), ...request.mcpServers.allowedTools],
    mcpServers: { ...permissions.mcpServers, ...request.mcpServers.servers },
  };
}

function sessionToolPermissions(
  request: Pick<
    SessionRequest,
    "policy" | "cwd" | "allowExploration" | "tools" | "additionalDirectories"
  >,
): SessionPermissions {
  return narrowPermissions(
    sdkPermissions(request.policy)({
      cwd: request.cwd,
      allowExploration: request.allowExploration !== false,
      ...(request.additionalDirectories && {
        additionalDirectories: request.additionalDirectories,
      }),
    }),
    request.tools,
  );
}

/** The SDK options of a session; exported for tests. */
export function sessionOptions(
  request: SessionRequest,
  abortController: AbortController,
  canUseTool?: CanUseTool,
): Options {
  return {
    ...sessionPermissions(request),
    model: request.model,
    ...(request.fallbackModel && { fallbackModel: request.fallbackModel }),
    abortController,
    systemPrompt:
      request.systemPrompt !== undefined
        ? request.systemPrompt
        : { type: "preset", preset: "claude_code", append: request.systemAppend },
    ...(request.outputSchema && {
      outputFormat: { type: "json_schema", schema: request.outputSchema },
    }),
    ...(request.maxTurns !== undefined && { maxTurns: request.maxTurns }),
    ...(request.additionalDirectories?.length
      ? { additionalDirectories: request.additionalDirectories }
      : {}),
    persistSession: request.persistSession === true,
    ...(request.resume && { resume: request.resume }),
    env: { ...request.env, CLAUDE_AGENT_SDK_CLIENT_APP: "omniralph-agent" },
    ...(canUseTool && { canUseTool }),
  };
}

/** Async-iterable message queue: a session's streaming input (cyralph's `InputQueue`). */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiting: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
  closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = undefined;
      waiting({ value: message, done: false });
    } else this.items.push(message);
  }

  close(): void {
    this.closed = true;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

function userMessage(text: string, uuid: string, priority?: "next"): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid: uuid as SDKUserMessage["uuid"],
    ...(priority && { priority }),
    origin: { kind: "human" },
  };
}

/** The Agent SDK's `query()` with streaming input (what a `SessionRunner` calls). */
export type SessionQueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => AsyncIterable<SDKMessage>;

/**
 * A `SessionRunner` on the Agent SDK's `query()` (ported from cyralph's
 * `ClaudeAgentRunner`): the prompt as streaming input, the policy's
 * permissions, a structured result, Claude's text and tool calls reported as
 * events. Messages injected through `onInjector` go into the live session as
 * user messages with priority `next`; the session stays open until every one
 * is answered (the last turn's result counts), but stops waiting for an
 * answer after `injectionIdleTimeoutMs`. A turn whose result `isWaiting` (it
 * waits for background work) doesn't end the session either: it waits up to
 * `backgroundWaitTimeoutMs` for the next turn, nudging a session that waits
 * with nothing running, and returns the waiting result if it gives up. The
 * session is aborted when the request's signal fires or no message arrives
 * for the idle timeout while a turn runs.
 */
export function createSessionRunner(
  query: SessionQueryFn = sdkQuery as SessionQueryFn,
): SessionRunner {
  return async (request) => {
    const seen: { sessionId?: string } = {};
    const result = await runQuery(query, request, seen);
    return seen.sessionId ? { ...result, sessionId: seen.sessionId } : result;
  };
}

/** Whether a message belongs to a turn of the session itself (not a subagent's or a task's). */
function startsTurn(message: SDKMessage): boolean {
  switch (message.type) {
    case "assistant":
    case "user":
    case "stream_event":
      return message.parent_tool_use_id === null;
    case "system":
      return message.subtype === "init";
    default:
      return false;
  }
}

/** Input (incl. cache reads/writes) and output tokens of one assistant message. */
function messageUsage(message: Extract<SDKMessage, { type: "assistant" }>): TokenUsage {
  const raw = (message.message.usage ?? {}) as unknown as Record<string, unknown>;
  const num = (key: string) => (typeof raw[key] === "number" ? raw[key] : 0);
  return {
    inputTokens:
      num("input_tokens") + num("cache_creation_input_tokens") + num("cache_read_input_tokens"),
    outputTokens: num("output_tokens"),
  };
}

const total = (usage: TokenUsage) => usage.inputTokens + usage.outputTokens;

/** One session of `createSessionRunner`; the session ID it reports goes into `seen`. */
async function runQuery(
  query: SessionQueryFn,
  request: SessionRequest,
  seen: { sessionId?: string },
): Promise<SessionResult> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(request.signal.reason);
  /** Usage per model (the shared tracker); `usage.byModel` reads it, so every result carries it. */
  const models = new UsageByModelTracker();
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  Object.defineProperty(usage, "byModel", {
    enumerable: true,
    get: () => {
      const byModel = models.byModel;
      return byModel.length > 0 ? byModel : undefined;
    },
  });
  if (request.signal.aborted) return { stop: "aborted", output: "", usage };
  request.signal.addEventListener("abort", onAbort, { once: true });

  let idle = false;
  let idleTimer: NodeJS.Timeout | undefined;
  const idleTimeoutMs = request.idleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS;
  const injectionIdleTimeoutMs = request.injectionIdleTimeoutMs ?? INJECTION_IDLE_TIMEOUT_MS;
  /** Permission questions open right now: the session is quiet while it waits for a person. */
  let asking = 0;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    if (asking > 0) return;
    idleTimer = setTimeout(() => {
      idle = true;
      controller.abort(new Error("the session was idle"));
    }, idleTimeoutMs);
  };

  // Streaming input: the session stays open until every message sent has been answered.
  const input = new InputQueue();
  const outstanding = new Set<string>();
  const send = (text: string, priority?: "next") => {
    const id = randomUUID();
    outstanding.add(id);
    input.push(userMessage(text, id, priority));
  };
  let injectionTimer: NodeJS.Timeout | undefined;
  const finishInput = () => {
    clearTimeout(injectionTimer);
    if (input.closed) return;
    input.close();
    request.onInjector?.(undefined);
  };
  send(request.prompt);
  request.onInjector?.((text) => {
    if (input.closed) return false;
    send(text, "next");
    return true;
  });
  controller.signal.addEventListener("abort", finishInput, { once: true });

  // A turn that reported `waiting` ends without ending the session: Claude Code starts the next
  // turn when the background work finishes. No turn runs meanwhile, so the idle timeout is off.
  const live = new Set<string>();
  let waiting = false;
  let nudged = false;
  let waitStopped: string | undefined;
  let waitTimer: NodeJS.Timeout | undefined;
  let nudgeTimer: NodeJS.Timeout | undefined;
  const backgroundWaitTimeoutMs = request.backgroundWaitTimeoutMs ?? BACKGROUND_WAIT_TIMEOUT_MS;
  const waitNudgeDelayMs = request.waitNudgeDelayMs ?? WAIT_NUDGE_DELAY_MS;
  const stopWaiting = (why: string) => {
    waitStopped = why;
    controller.abort(new Error(why));
  };
  // Waiting with nothing running: nudge once, then give up rather than wait out the timeout.
  const watchNothingRunning = () => {
    clearTimeout(nudgeTimer);
    if (!waiting || live.size > 0) return;
    nudgeTimer = setTimeout(() => {
      if (nudged) {
        stopWaiting("the session kept waiting with nothing running in the background");
        return;
      }
      nudged = true;
      send(WAIT_NUDGE_TEXT, "next");
      // If no turn takes the nudge either, the next quiet period gives up.
      watchNothingRunning();
    }, waitNudgeDelayMs);
  };
  const startWaiting = () => {
    waiting = true;
    clearTimeout(idleTimer);
    clearTimeout(waitTimer);
    waitTimer = setTimeout(
      () =>
        stopWaiting(
          `the background work took longer than ${Math.round(backgroundWaitTimeoutMs / 60_000)} minutes`,
        ),
      backgroundWaitTimeoutMs,
    );
    watchNothingRunning();
  };
  const endWaiting = () => {
    waiting = false;
    clearTimeout(waitTimer);
    clearTimeout(nudgeTimer);
  };

  // Usage so far, per assistant message (streamed messages repeat their ID), for the token budget.
  const perMessage = new Map<string, TokenUsage>();
  const recordUsage = (message: Extract<SDKMessage, { type: "assistant" }>): TokenUsage => {
    const next = messageUsage(message);
    const key = (message.message as { id?: string }).id ?? message.uuid;
    const prev = perMessage.get(key);
    const merged = {
      inputTokens: Math.max(prev?.inputTokens ?? 0, next.inputTokens),
      outputTokens: Math.max(prev?.outputTokens ?? 0, next.outputTokens),
    };
    perMessage.set(key, merged);
    let inputTokens = 0;
    let outputTokens = 0;
    for (const u of perMessage.values()) {
      inputTokens += u.inputTokens;
      outputTokens += u.outputTokens;
    }
    usage.inputTokens = Math.max(usage.inputTokens, inputTokens);
    usage.outputTokens = Math.max(usage.outputTokens, outputTokens);
    return merged;
  };

  const texts: string[] = [];
  const last = () => texts.at(-1) ?? "";
  let rateLimited = false;
  let retryAfterMs: number | undefined;
  /** A turn's successful result while an injected message is unanswered or background work runs. */
  let answered: SessionResult | undefined;
  const stopped = (): SessionResult | undefined => {
    if (request.signal.aborted) return { stop: "aborted", output: last(), usage };
    if (waitStopped && answered) return { ...answered, error: waitStopped };
    if (idle) {
      return {
        stop: "idle",
        output: last(),
        error: `the session sent nothing for ${Math.round(idleTimeoutMs / 1000)}s`,
        usage,
      };
    }
    return undefined;
  };

  const askPermission = request.askPermission;
  const canUseTool: CanUseTool | undefined = askPermission
    ? async (toolName, toolInput, options) => {
        asking++;
        clearTimeout(idleTimer);
        let allowed = false;
        try {
          const rule = options.matchedAskRule;
          const reason = [
            options.title ?? options.decisionReason,
            rule &&
              `It matches \`${rule.toolName}${rule.ruleContent ? `(${rule.ruleContent})` : ""}\` in the ${rule.source} settings.`,
          ]
            .filter(Boolean)
            .join("\n");
          allowed = await askPermission(
            { tool: toolName, input: toolInput, ...(reason && { reason }) },
            options.signal,
          );
        } catch {
          allowed = false;
        } finally {
          asking--;
          if (!waiting) resetIdle();
        }
        return allowed
          ? { behavior: "allow", updatedInput: toolInput }
          : { behavior: "deny", message: PERMISSION_DENIED_TEXT };
      }
    : undefined;

  resetIdle();
  try {
    const messages = query({
      prompt: input,
      options: sessionOptions(request, controller, canUseTool),
    });
    for await (const message of messages) {
      if (message.type === "system" && message.subtype === "background_tasks_changed") {
        live.clear();
        for (const task of message.tasks) if (!task.ambient) live.add(task.task_id);
        if (live.size > 0) nudged = false;
        watchNothingRunning();
      }
      // While waiting, background tasks report on their own; only a new turn is activity.
      if (!waiting || startsTurn(message)) {
        clearTimeout(injectionTimer);
        endWaiting();
        resetIdle();
      }
      if ("session_id" in message && message.session_id) seen.sessionId = message.session_id;
      const turn = message.type === "assistant" ? recordUsage(message) : undefined;
      if (message.type === "assistant") models.recordMessage(message.message, message.uuid);
      switch (message.type) {
        case "assistant": {
          if (message.parent_tool_use_id !== null) break;
          if (message.error === "rate_limit") {
            controller.abort();
            return {
              stop: "rate_limited",
              output: last(),
              error: "Claude rate limit reached",
              retryAfterMs,
              usage,
            };
          }
          for (const event of sessionEvents(message)) {
            if (event.type === "text") texts.push(event.text);
            request.onEvent?.(event);
          }
          break;
        }
        case "rate_limit_event":
          if (message.rate_limit_info.status === "rejected") {
            rateLimited = true;
            retryAfterMs = retryAfter(message.rate_limit_info.resetsAt);
          }
          break;
        case "result": {
          const final = resultUsage(message);
          models.recordResult(message);
          usage.inputTokens = Math.max(usage.inputTokens, final.inputTokens);
          usage.outputTokens = Math.max(usage.outputTokens, final.outputTokens);
          if (message.subtype === "success" && !message.is_error) {
            const result: SessionResult = {
              stop: "completed",
              structured: message.structured_output,
              output: message.result || last(),
              usage,
            };
            // Which of our messages this turn answered; older producers don't say, so assume all.
            const ids =
              message.user_message_uuids ??
              (message.user_message_uuid ? [message.user_message_uuid] : [...outstanding]);
            for (const id of ids) outstanding.delete(id);
            const waits = request.isWaiting?.(message.structured_output) === true;
            if (!waits && outstanding.size === 0) return result;
            answered = result;
            clearTimeout(idleTimer);
            if (waits) startWaiting();
            // An injected message starts another turn; until it does, only the injection timeout runs.
            else injectionTimer = setTimeout(finishInput, injectionIdleTimeoutMs);
            break;
          }
          const detail =
            message.subtype === "success"
              ? message.result
              : [message.subtype, ...message.errors].join(": ");
          if (rateLimited || RATE_LIMIT_TEXT.test(detail)) {
            return {
              stop: "rate_limited",
              output: last(),
              error: `Claude rate limit: ${detail}`,
              retryAfterMs,
              usage,
            };
          }
          return { stop: "error", output: last(), error: detail || "the session failed", usage };
        }
        default:
          break;
      }
      const budget = request.tokenBudget;
      if (budget !== undefined && turn && message.type === "assistant") {
        // A tool call means another turn, which re-sends at least this turn's context and
        // output: stop before that turn would cross the cap (as `ClaudeAgentProvider` does).
        const callsTool =
          message.parent_tool_use_id === null &&
          (message.message.content ?? []).some((block) => block.type === "tool_use");
        if (total(usage) >= budget || (callsTool && total(usage) + total(turn) > budget)) {
          controller.abort(new Error("the token budget is exhausted"));
          return { stop: "budget_exhausted", output: last(), usage };
        }
      }
    }
    return (
      stopped() ??
      answered ?? {
        stop: "error",
        output: last(),
        error: "the session ended without a result",
        usage,
      }
    );
  } catch (error) {
    const stop = stopped();
    if (stop) return stop;
    const text = error instanceof Error ? error.message : String(error);
    if (rateLimited || RATE_LIMIT_TEXT.test(text)) {
      return {
        stop: "rate_limited",
        output: last(),
        error: `Claude rate limit: ${text}`,
        retryAfterMs,
        usage,
      };
    }
    return { stop: "error", output: last(), error: text, usage };
  } finally {
    clearTimeout(idleTimer);
    endWaiting();
    finishInput();
    request.signal.removeEventListener("abort", onAbort);
    controller.signal.removeEventListener("abort", finishInput);
  }
}
