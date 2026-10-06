import { query as sdkQuery, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { QueryFn, TokenUsage } from "@omniralph/engine";
import type { ToolPolicy } from "../index.js";
import { sdkPermissions } from "../tool-policy.js";

/** A session that sends nothing (no message at all) for this long is aborted. */
export const SESSION_IDLE_TIMEOUT_MS = 5 * 60_000;

const RATE_LIMIT_TEXT = /rate[_ ]limit|usage limit|\b429\b|too many requests/i;

/** What a session shows while it runs (relayed to the Linear agent session). */
export type SessionEvent =
  { type: "text"; text: string } | { type: "tool"; name: string; input: unknown };

export interface SessionRequest {
  prompt: string;
  /** The session's working directory (the branch worktree). */
  cwd: string;
  policy: ToolPolicy;
  /** Appended to Claude Code's system prompt. */
  systemAppend: string;
  /** JSON schema of the structured result (`outputFormat`). */
  outputSchema: Record<string, unknown>;
  model?: string;
  /** Directories outside `cwd` the session may use (e.g. the progress log's). */
  additionalDirectories?: string[];
  /** Environment of the Claude Code process. */
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  idleTimeoutMs?: number;
  onEvent?: (event: SessionEvent) => void;
}

export interface SessionResult {
  /**
   * How the session ended: `completed` (a successful result; `structured` holds
   * it, unvalidated), `error`, `rate_limited`, `idle` (no message for the idle
   * timeout) or `aborted` (the request's signal).
   */
  stop: "completed" | "error" | "rate_limited" | "idle" | "aborted";
  structured?: unknown;
  /** The final message, or the last streamed text when there was none. */
  output: string;
  error?: string;
  retryAfterMs?: number;
  usage: TokenUsage;
}

/** Runs one Claude session and returns how it ended. */
export type SessionRunner = (request: SessionRequest) => Promise<SessionResult>;

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

/** The SDK options of a ralph session; exported for tests. */
export function sessionOptions(request: SessionRequest, abortController: AbortController): Options {
  return {
    ...sdkPermissions(request.policy)({ cwd: request.cwd, allowExploration: true }),
    model: request.model,
    abortController,
    systemPrompt: { type: "preset", preset: "claude_code", append: request.systemAppend },
    outputFormat: { type: "json_schema", schema: request.outputSchema },
    ...(request.additionalDirectories?.length
      ? { additionalDirectories: request.additionalDirectories }
      : {}),
    persistSession: false,
    env: { ...request.env, CLAUDE_AGENT_SDK_CLIENT_APP: "omniralph-agent" },
  };
}

/**
 * A `SessionRunner` on the Agent SDK's `query()` (ported from cyralph's
 * `ClaudeAgentRunner`): one prompt, the policy's permissions, a structured
 * result, Claude's text and tool calls reported as events. The session is
 * aborted when the request's signal fires or no message arrives for the idle
 * timeout.
 */
export function createSessionRunner(query: QueryFn = sdkQuery as QueryFn): SessionRunner {
  return async (request) => {
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal.reason);
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    if (request.signal.aborted) return { stop: "aborted", output: "", usage };
    request.signal.addEventListener("abort", onAbort, { once: true });

    let idle = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const idleTimeoutMs = request.idleTimeoutMs ?? SESSION_IDLE_TIMEOUT_MS;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idle = true;
        controller.abort(new Error("the session was idle"));
      }, idleTimeoutMs);
    };

    const texts: string[] = [];
    const last = () => texts.at(-1) ?? "";
    let rateLimited = false;
    let retryAfterMs: number | undefined;
    const stopped = (): SessionResult | undefined => {
      if (request.signal.aborted) return { stop: "aborted", output: last(), usage };
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

    resetIdle();
    try {
      const messages = query({
        prompt: request.prompt,
        options: sessionOptions(request, controller),
      });
      for await (const message of messages) {
        resetIdle();
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
            for (const block of message.message.content) {
              if (block.type === "text" && block.text.trim()) {
                texts.push(block.text);
                request.onEvent?.({ type: "text", text: block.text });
              } else if (block.type === "tool_use") {
                request.onEvent?.({ type: "tool", name: block.name, input: block.input });
              }
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
            Object.assign(usage, resultUsage(message));
            if (message.subtype === "success" && !message.is_error) {
              return {
                stop: "completed",
                structured: message.structured_output,
                output: message.result || last(),
                usage,
              };
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
      }
      return (
        stopped() ?? {
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
      request.signal.removeEventListener("abort", onAbort);
    }
  };
}
